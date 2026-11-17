import mongoose from 'mongoose';
import CompanyWallet from '../models/CompanyWallet.js';
import CompanyWalletEntry from '../models/CompanyWalletEntry.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';
import { logAudit } from '../services/auditService.js';
import Branch from '../models/Branch.js';
import Account from '../models/Account.js';
import { runWithBranch, currentBranch } from '../services/branchContext.js';
import AutoTakeDue from '../models/AutoTakeDue.js';
import CompanySetting, { getCompanySetting } from '../models/CompanySetting.js';
import { sweepBranch } from '../services/autoWalletTake.js';
import { notifyBranchTake, notifyBranchGive, takeText } from '../services/walletNotify.js';
import WalletNotice from '../models/WalletNotice.js';
import User from '../models/User.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { nextSequence } from '../models/Counter.js';

// Company wallets: savings kept apart from the shop's accounts (see the
// CompanyWallet model). Super Admin only.

const walletDTO = (w) => ({ id: w._id, name: w.name, note: w.note, balance: fromCents(w.balanceCents), createdAt: w.createdAt });
const entryDTO = (e) => ({
  id: e._id,
  type: e.type,
  amount: fromCents(e.amountCents),
  balanceAfter: fromCents(e.balanceAfterCents),
  date: e.date,
  person: e.person,
  note: e.note,
  branchName: e.branchName || '',
  accountName: e.accountName || '',
  fromBranch: !!e.account,
  batch: e.batch || '',
  createdByName: e.createdByName,
});

function dayOf(value) {
  if (!value) return new Date();
  const day = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'Enter a valid date.');
  return new Date(`${day}T12:00:00`);
}

// GET /api/company-wallets
export const listWallets = asyncHandler(async (req, res) => {
  const wallets = await CompanyWallet.find({ isActive: true }).sort({ createdAt: 1 });
  const total = wallets.reduce((t, w) => t + w.balanceCents, 0);
  res.json({ success: true, data: { total: fromCents(total), wallets: wallets.map(walletDTO) } });
});

// POST /api/company-wallets { name, note }
export const createWallet = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new ApiError(400, 'Wallet name is required.');
  const exists = await CompanyWallet.findOne({ name, isActive: true }).collation({ locale: 'en', strength: 2 });
  if (exists) throw new ApiError(409, `A wallet named "${exists.name}" already exists.`);
  const wallet = await CompanyWallet.create({ name, note: String(req.body.note || '').trim() });
  await logAudit({ user: req.user, action: 'companyWallet.create', entityType: 'CompanyWallet', entityId: wallet._id, details: { name } });
  res.status(201).json({ success: true, data: walletDTO(wallet) });
});

// PUT /api/company-wallets/:id { name, note }
export const updateWallet = asyncHandler(async (req, res) => {
  const wallet = await CompanyWallet.findById(req.params.id);
  if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new ApiError(400, 'Wallet name is required.');
  const exists = await CompanyWallet.findOne({ _id: { $ne: wallet._id }, name, isActive: true }).collation({ locale: 'en', strength: 2 });
  if (exists) throw new ApiError(409, `A wallet named "${exists.name}" already exists.`);
  wallet.name = name;
  if (req.body.note !== undefined) wallet.note = String(req.body.note || '').trim();
  await wallet.save();
  res.json({ success: true, data: walletDTO(wallet) });
});

// DELETE /api/company-wallets/:id -- only an empty wallet (balance 0).
export const deleteWallet = asyncHandler(async (req, res) => {
  const wallet = await CompanyWallet.findById(req.params.id);
  if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
  if (wallet.balanceCents !== 0) throw new ApiError(400, 'Take the money out first: only a wallet with 0 balance can be deleted.');
  wallet.isActive = false;
  await wallet.save();
  await logAudit({ user: req.user, action: 'companyWallet.delete', entityType: 'CompanyWallet', entityId: wallet._id, details: { name: wallet.name } });
  res.json({ success: true, data: { id: wallet._id } });
});

// GET /api/company-wallets/:id/entries
export const listEntries = asyncHandler(async (req, res) => {
  const wallet = await CompanyWallet.findById(req.params.id);
  if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
  const entries = await CompanyWalletEntry.find({ wallet: wallet._id }).sort({ date: -1, createdAt: -1 }).limit(2000);
  const sumOf = (list) => list.reduce((t, e) => t + e.amountCents, 0);
  const fromBranches = entries.filter((e) => e.type === 'DEPOSIT' && e.account);
  const toBranches = entries.filter((e) => e.type === 'WITHDRAW' && e.account);
  // One row per "Take from branches" or "Give to branch" (its batch), one
  // row per other entry.
  const rows = [];
  const batches = new Map();
  for (const e of entries) {
    // Takes from before statements existed: one statement each.
    const key = e.batch || (e.account ? String(e._id) : '');
    if (!key) {
      rows.push({ kind: 'ENTRY', ...entryDTO(e) });
      continue;
    }
    let row = batches.get(key);
    if (!row) {
      const give = e.type === 'WITHDRAW';
      row = { kind: give ? 'GIVE' : 'TAKE', id: key, batch: key, label: e.batch || 'Earlier take', type: e.type, amountCents: 0, balanceAfter: fromCents(e.balanceAfterCents), date: e.date, note: e.note, createdByName: e.createdByName, items: [] };
      batches.set(key, row);
      rows.push(row);
    }
    row.amountCents += e.amountCents;
    row.items.push({ branchName: e.branchName, accountName: e.accountName, amount: fromCents(e.amountCents) });
  }
  for (const r of batches.values()) {
    r.amount = fromCents(r.amountCents);
    delete r.amountCents;
    r.branches = [...new Set(r.items.map((i) => i.branchName))];
  }
  res.json({
    success: true,
    data: {
      wallet: walletDTO(wallet),
      deposited: fromCents(sumOf(entries.filter((e) => e.type === 'DEPOSIT' && !e.account))),
      fromBranches: fromCents(sumOf(fromBranches)),
      withdrawn: fromCents(sumOf(entries.filter((e) => e.type === 'WITHDRAW' && !e.account))),
      givenToBranches: fromCents(sumOf(toBranches)),
      rows,
      entries: entries.map(entryDTO),
    },
  });
});

// POST /api/company-wallets/:id/entries { type: DEPOSIT|WITHDRAW, amount, date, person, note }
export const addEntry = asyncHandler(async (req, res) => {
  const type = String(req.body.type || '').toUpperCase();
  if (!['DEPOSIT', 'WITHDRAW'].includes(type)) throw new ApiError(400, 'Choose deposit or withdraw.');
  const n = Number(req.body.amount);
  const amountCents = toCents(n);
  if (!Number.isFinite(n) || amountCents <= 0) throw new ApiError(400, 'Amount must be greater than zero.');
  const date = dayOf(req.body.date);
  const entry = await runInTransaction(async (session) => {
    const wallet = await CompanyWallet.findById(req.params.id).session(session);
    if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
    if (type === 'WITHDRAW' && amountCents > wallet.balanceCents) throw new ApiError(400, `Not enough in the wallet: it has ${fromCents(wallet.balanceCents).toFixed(2)}.`);
    wallet.balanceCents += type === 'DEPOSIT' ? amountCents : -amountCents;
    await wallet.save({ session });
    const [e] = await CompanyWalletEntry.create([{
      wallet: wallet._id, type, amountCents, balanceAfterCents: wallet.balanceCents, date,
      person: String(req.body.person || '').trim(), note: String(req.body.note || '').trim(),
      createdBy: req.user._id, createdByName: req.user.name,
    }], { session });
    return e;
  });
  await logAudit({ user: req.user, action: `companyWallet.${type.toLowerCase()}`, entityType: 'CompanyWallet', entityId: entry.wallet, details: { amount: fromCents(amountCents) } });
  res.status(201).json({ success: true, data: entryDTO(entry) });
});

// DELETE /api/company-wallets/:id/entries/:entryId -- removes a mistaken
// entry; the wallet's balance is put back as if it never happened.
export const deleteEntry = asyncHandler(async (req, res) => {
  await runInTransaction(async (session) => {
    const wallet = await CompanyWallet.findById(req.params.id).session(session);
    if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
    const entry = await CompanyWalletEntry.findOne({ _id: req.params.entryId, wallet: wallet._id }).session(session);
    if (!entry) throw new ApiError(404, 'Entry not found.');
    const back = entry.type === 'DEPOSIT' ? -entry.amountCents : entry.amountCents;
    if (wallet.balanceCents + back < 0) throw new ApiError(400, 'Cannot remove this deposit: the money was already taken out.');
    wallet.balanceCents += back;
    await wallet.save({ session });
    // Taken from a branch: the money goes back into that branch's account.
    // Given to a branch: it comes back out of that account.
    if (entry.branch && entry.account) await reverseBranchMove(entry, wallet, req.user, session, '');
    await CompanyWalletEntry.deleteOne({ _id: entry._id }, { session });
  });
  await logAudit({ user: req.user, action: 'companyWallet.entry_delete', entityType: 'CompanyWallet', entityId: req.params.id, details: { entryId: req.params.entryId } });
  res.json({ success: true, data: { id: req.params.entryId } });
});

// GET /api/company-wallets/branch-takes -- the report an admin may be given:
// every amount taken out of this branch's accounts into a company wallet,
// with the account it came from, and what the branch still owes the daily
// take. No wallet names or balances. With no branch open (the Super Admin's
// overview) it covers every branch.
export const listBranchTakes = asyncHandler(async (req, res) => {
  const branch = currentBranch();
  const filter = { type: 'DEPOSIT', account: { $ne: null }, ...(branch ? { branch } : {}) };
  const [entries, dues, setting] = await Promise.all([
    CompanyWalletEntry.find(filter).sort({ date: -1, createdAt: -1 }).lean(),
    AutoTakeDue.find(branch ? { branch } : {}).lean(),
    getCompanySetting(),
  ]);
  const byAccount = new Map();
  let total = 0;
  for (const e of entries) {
    total += e.amountCents;
    const key = `${e.branchName || ''}|${e.accountName || ''}`;
    const name = branch ? e.accountName || 'Account' : `${e.accountName || 'Account'} (${e.branchName || '—'})`;
    byAccount.set(key, { name, cents: (byAccount.get(key)?.cents || 0) + e.amountCents });
  }
  res.json({
    success: true,
    data: {
      allBranches: !branch,
      total: fromCents(total),
      owed: fromCents(dues.reduce((t, d) => t + Math.max(0, d.owedCents || 0), 0)),
      daily: setting.autoTakeEnabled ? fromCents(setting.autoTakeAmountCents || 0) : 0,
      accounts: [...byAccount.values()].sort((a, b) => b.cents - a.cents).map((a) => ({ name: a.name, total: fromCents(a.cents) })),
      rows: entries.map((e) => ({ id: e._id, date: e.createdAt || e.date, batch: e.batch || '', branchName: e.branchName || '', accountName: e.accountName || '', amount: fromCents(e.amountCents), note: e.note || '' })),
    },
  });
});

// GET /api/company-wallets/notices -- every message sent to the branch
// admins about money taken (Super Admin only), newest first.
export const listNotices = asyncHandler(async (req, res) => {
  if (!req.user?.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin can see these messages.');
  const list = await WalletNotice.find().sort({ createdAt: -1 }).limit(500).lean();
  const out = list.map((n) => ({ id: n._id, date: n.createdAt, branchName: n.branchName, to: n.to, text: n.text, taken: fromCents(n.takenCents || 0), given: fromCents(n.givenCents || 0), owed: fromCents(n.owedCents || 0), batch: n.batch, automatic: n.automatic }));
  // Takes made before these copies were kept: their message is rebuilt from
  // the take itself, so every take is listed.
  const kept = new Set(list.map((n) => `${n.batch}|${n.branchName}`));
  const older = await CompanyWalletEntry.find({ type: 'DEPOSIT', account: { $ne: null } }).sort({ createdAt: -1 }).limit(2000).lean();
  const groups = new Map();
  for (const e of older) {
    const k = `${e.batch}|${e.branchName}`;
    if (kept.has(k)) continue;
    const g = groups.get(k) || { id: k, date: e.createdAt || e.date, branchName: e.branchName, batch: e.batch, automatic: /automatic/i.test(e.note || ''), lines: [] };
    g.lines.push({ accountName: e.accountName, cents: e.amountCents });
    groups.set(k, g);
  }
  if (groups.size) {
    const admins = await User.find({ role: 'admin', isSuperAdmin: { $ne: true }, active: { $ne: false } }).select('name branch').lean();
    const branchIds = new Map(older.map((e) => [e.branchName, String(e.branch)]));
    for (const g of groups.values()) {
      out.push({
        id: g.id,
        date: g.date,
        branchName: g.branchName,
        to: admins.filter((a) => String(a.branch) === branchIds.get(g.branchName)).map((a) => a.name),
        text: takeText(g.lines),
        taken: fromCents(g.lines.reduce((t, l) => t + l.cents, 0)),
        owed: 0,
        batch: g.batch,
        automatic: g.automatic,
      });
    }
  }
  out.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ success: true, data: out });
});

const superOnly = (req) => {
  if (!req.user?.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin can set the automatic daily take.');
};
async function autoTakeDTO() {
  const s = await getCompanySetting();
  const branches = await Branch.find({ active: true }).sort({ createdAt: 1 }).select('_id name').lean();
  const dues = new Map((await AutoTakeDue.find().lean()).map((d) => [String(d.branch), d]));
  return {
    enabled: !!s.autoTakeEnabled,
    amount: fromCents(s.autoTakeAmountCents || 0),
    walletId: s.autoTakeWallet ? String(s.autoTakeWallet) : '',
    hour: 12,
    branches: branches.map((b) => {
      const d = dues.get(String(b._id));
      return {
        branchId: b._id,
        name: b.name,
        owed: fromCents(Math.max(0, d?.owedCents || 0)),
        // This branch's own daily amount ('' = the amount for every branch).
        daily: d?.dailyCents != null ? fromCents(d.dailyCents) : '',
        lastChargedDay: d?.lastChargedDay || '',
      };
    }),
  };
}

// GET /api/company-wallets/auto-take
export const getAutoTake = asyncHandler(async (req, res) => {
  superOnly(req);
  res.json({ success: true, data: await autoTakeDTO() });
});

// PUT /api/company-wallets/auto-take { enabled, amount, walletId }
export const saveAutoTake = asyncHandler(async (req, res) => {
  superOnly(req);
  const enabled = !!req.body.enabled;
  const amount = Number(req.body.amount || 0);
  if (!Number.isFinite(amount) || amount < 0) throw new ApiError(400, 'Enter a valid amount.');
  let wallet = null;
  if (req.body.walletId) {
    if (!mongoose.isValidObjectId(req.body.walletId)) throw new ApiError(400, 'Choose a wallet.');
    wallet = await CompanyWallet.findOne({ _id: req.body.walletId, isActive: true });
  }
  if (enabled && !wallet) throw new ApiError(400, 'Choose a wallet.');
  await CompanySetting.findOneAndUpdate(
    { _id: 'company' },
    { $set: { autoTakeEnabled: enabled, autoTakeAmountCents: toCents(amount), autoTakeWallet: wallet?._id || null, updatedByName: req.user.name } },
    { upsert: true }
  );
  await logAudit({ user: req.user, action: 'companyWallet.auto_take_set', entityType: 'CompanySetting', details: { enabled, amount, wallet: wallet?.name || '' } });
  res.json({ success: true, data: await autoTakeDTO() });
});

// PUT /api/company-wallets/auto-take/branches/:branchId { daily?, owed? } --
// this branch's own daily amount ('' or null: the amount for every branch),
// and/or what it still owes (e.g. 0 to let it off).
export const setBranchOwed = asyncHandler(async (req, res) => {
  superOnly(req);
  if (!mongoose.isValidObjectId(req.params.branchId)) throw new ApiError(400, 'Unknown branch.');
  const set = {};
  if ('owed' in req.body) {
    const owed = Number(req.body.owed || 0);
    if (!Number.isFinite(owed) || owed < 0) throw new ApiError(400, 'Enter a valid amount.');
    set.owedCents = toCents(owed);
  }
  if ('daily' in req.body) {
    const raw = req.body.daily;
    if (raw === '' || raw === null) set.dailyCents = null;
    else {
      const daily = Number(raw);
      if (!Number.isFinite(daily) || daily < 0) throw new ApiError(400, 'Enter a valid daily amount.');
      set.dailyCents = toCents(daily);
    }
  }
  const owed = set.owedCents != null ? set.owedCents / 100 : 0;
  const branch = await Branch.findById(req.params.branchId).select('_id name').lean();
  if (!branch) throw new ApiError(404, 'Branch not found.');
  await AutoTakeDue.updateOne({ branch: branch._id }, { $set: { ...set, branchName: branch.name }, $setOnInsert: { lastChargedDay: '' } }, { upsert: true });
  const s = await getCompanySetting();
  if (owed > 0 && s.autoTakeEnabled && s.autoTakeWallet) await sweepBranch(branch, s.autoTakeWallet);
  await logAudit({ user: req.user, action: 'companyWallet.auto_take_owed_set', entityType: 'Branch', entityId: branch._id, details: set });
  res.json({ success: true, data: await autoTakeDTO() });
});

// GET /api/company-wallets/branch-accounts -- every open branch with its
// accounts and balances, for taking money into a wallet.
export const listBranchAccounts = asyncHandler(async (req, res) => {
  const branches = await Branch.find({ active: true }).sort({ createdAt: 1 }).select('_id name').lean();
  const out = [];
  for (const b of branches) {
    const accounts = await runWithBranch(b._id, async () => await Account.find({ isActive: true }).sort({ name: 1 }).select('_id name currentBalanceCents').lean());
    out.push({ branchId: b._id, branchName: b.name, accounts: accounts.map((a) => ({ id: a._id, name: a.name, balance: fromCents(a.currentBalanceCents) })) });
  }
  res.json({ success: true, data: out });
});

// POST /api/company-wallets/:id/take { date, note, items: [{ branchId, accountId, amount }] }
// The Super Admin takes money from branch accounts into the wallet: each
// account goes down (a WITHDRAWAL in its statement), the wallet goes up, and
// each branch's balance sheet shows what was taken under Cash & bank.
export const takeFromBranches = asyncHandler(async (req, res) => {
  const items = (Array.isArray(req.body.items) ? req.body.items : []).filter((i) => Number(i?.amount) > 0);
  if (!items.length) throw new ApiError(400, 'Type an amount for at least one account.');
  const date = dayOf(req.body.date);
  const note = String(req.body.note || '').trim().slice(0, 500);
  const open = new Map((await Branch.find({ active: true }).select('_id name').lean()).map((b) => [String(b._id), b]));
  const result = await runInTransaction(async (session) => {
    const wallet = await CompanyWallet.findById(req.params.id).session(session);
    if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
    const seq = await nextSequence('walletTake', session);
    const batch = `CWT-${date.getFullYear()}-${String(seq).padStart(4, '0')}`;
    const entries = [];
    for (const it of items) {
      const branch = open.get(String(it.branchId));
      if (!branch) throw new ApiError(400, 'One of the branches is not open.');
      const amountCents = toCents(Number(it.amount));
      if (!Number.isFinite(Number(it.amount)) || amountCents <= 0) throw new ApiError(400, `${branch.name}: enter a valid amount.`);
      const txn = await runWithBranch(branch._id, async () => {
        const account = await Account.findById(it.accountId).session(session);
        if (!account || !account.isActive) throw new ApiError(400, `${branch.name}: the account is not available.`);
        if (amountCents > account.currentBalanceCents) {
          throw new ApiError(400, `${branch.name} -- ${account.name} has only ${fromCents(account.currentBalanceCents).toFixed(2)}.`);
        }
        const t = await postImmediateTransaction(
          { account, direction: 'OUT', type: 'WITHDRAWAL', amountCents, referenceType: 'Manual', description: `Taken to company wallet ${wallet.name}${note ? ` -- ${note}` : ''}`, createdBy: req.user },
          session
        );
        return { t, account };
      });
      wallet.balanceCents += amountCents;
      const [e] = await CompanyWalletEntry.create(
        [
          {
            wallet: wallet._id,
            type: 'DEPOSIT',
            amountCents,
            balanceAfterCents: wallet.balanceCents,
            date,
            person: req.user.name,
            note,
            branch: branch._id,
            branchName: branch.name,
            account: txn.account._id,
            accountName: txn.account.name,
            accountTransaction: txn.t?._id || null,
            batch,
            createdBy: req.user._id,
            createdByName: req.user.name,
          },
        ],
        { session }
      );
      entries.push(e);
    }
    await wallet.save({ session });
    return { wallet, entries, batch };
  });
  const total = result.entries.reduce((s, e) => s + e.amountCents, 0);
  // Tell each branch what was taken from which account.
  const perBranch = new Map();
  for (const e of result.entries) {
    const k = String(e.branch);
    const g = perBranch.get(k) || { branchId: e.branch, branchName: e.branchName, items: [] };
    g.items.push({ accountName: e.accountName, cents: e.amountCents });
    perBranch.set(k, g);
  }
  for (const g of perBranch.values()) await notifyBranchTake({ ...g, batch: result.batch, sender: req.user });
  await logAudit({ user: req.user, action: 'companyWallet.take_from_branches', entityType: 'CompanyWallet', entityId: result.wallet._id, details: { total: fromCents(total), items: result.entries.length } });
  res.status(201).json({ success: true, data: { batch: result.batch, total: fromCents(total), entries: result.entries.map(entryDTO) } });
});

// Puts a branch account back as it was before a wallet entry: a take
// (DEPOSIT) gives the account its money back; a give (WITHDRAW) takes it
// back out -- only if the branch still has it.
async function reverseBranchMove(entry, wallet, user, session, ref) {
  await runWithBranch(entry.branch, async () => {
    const account = await Account.findById(entry.account).session(session);
    if (!account) throw new ApiError(400, `The ${entry.branchName} account "${entry.accountName}" no longer exists, so the money cannot be moved back.`);
    if (entry.type === 'WITHDRAW') {
      if (account.currentBalanceCents < entry.amountCents) throw new ApiError(400, `Cannot undo: ${entry.branchName} -- ${account.name} has only ${fromCents(account.currentBalanceCents).toFixed(2)} of the ${fromCents(entry.amountCents).toFixed(2)} given.`);
      await postImmediateTransaction(
        { account, direction: 'OUT', type: 'WITHDRAWAL', amountCents: entry.amountCents, referenceType: 'Manual', description: `Back to company wallet ${wallet.name}${ref}`, createdBy: user },
        session
      );
    } else {
      await postImmediateTransaction(
        { account, direction: 'IN', type: 'DEPOSIT', amountCents: entry.amountCents, referenceType: 'Manual', description: `Back from company wallet ${wallet.name}${ref}`, createdBy: user },
        session
      );
    }
  });
}

// POST /api/company-wallets/:id/give { branchId, accountId, amount, date, note }
// Gives part of the wallet's money to a branch, into one of its accounts. It
// is not a loan: the branch owes nothing for it and the daily take is not
// changed. The branch admins are told by chat. Undone like a take.
export const giveToBranch = asyncHandler(async (req, res) => {
  const n = Number(req.body.amount);
  const amountCents = toCents(n);
  if (!Number.isFinite(n) || amountCents <= 0) throw new ApiError(400, 'Amount must be greater than zero.');
  if (!mongoose.isValidObjectId(req.body.branchId) || !mongoose.isValidObjectId(req.body.accountId)) throw new ApiError(400, 'Choose a branch and one of its accounts.');
  const date = dayOf(req.body.date);
  const note = String(req.body.note || '').trim().slice(0, 500);
  const branch = await Branch.findOne({ _id: req.body.branchId, active: true }).select('_id name').lean();
  if (!branch) throw new ApiError(400, 'That branch is not open.');
  // A branch that still owes the daily take would have this money taken
  // straight back by the next check (every minute), so it is refused.
  const setting = await getCompanySetting();
  const due = await AutoTakeDue.findOne({ branch: branch._id }).select('owedCents').lean();
  if (setting.autoTakeEnabled && due?.owedCents > 0) {
    throw new ApiError(409, `${branch.name} still owes ${fromCents(due.owedCents).toFixed(2)} to the daily take, so this money would be taken straight back. Set what it owes to 0 first, then give it.`);
  }
  const result = await runInTransaction(async (session) => {
    const wallet = await CompanyWallet.findById(req.params.id).session(session);
    if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
    if (amountCents > wallet.balanceCents) throw new ApiError(400, `Not enough in the wallet: it has ${fromCents(wallet.balanceCents).toFixed(2)}.`);
    const seq = await nextSequence('walletGive', session);
    const batch = `CWG-${date.getFullYear()}-${String(seq).padStart(4, '0')}`;
    const moved = await runWithBranch(branch._id, async () => {
      const account = await Account.findById(req.body.accountId).session(session);
      if (!account || !account.isActive) throw new ApiError(400, `${branch.name}: the account is not available.`);
      const t = await postImmediateTransaction(
        { account, direction: 'IN', type: 'DEPOSIT', amountCents, referenceType: 'Manual', description: `From company wallet ${wallet.name} (${batch}) -- not a loan${note ? ` -- ${note}` : ''}`, createdBy: req.user },
        session
      );
      return { t, account };
    });
    wallet.balanceCents -= amountCents;
    await wallet.save({ session });
    const [entry] = await CompanyWalletEntry.create(
      [
        {
          wallet: wallet._id,
          type: 'WITHDRAW',
          amountCents,
          balanceAfterCents: wallet.balanceCents,
          date,
          person: req.user.name,
          note,
          branch: branch._id,
          branchName: branch.name,
          account: moved.account._id,
          accountName: moved.account.name,
          accountTransaction: moved.t?._id || null,
          batch,
          createdBy: req.user._id,
          createdByName: req.user.name,
        },
      ],
      { session }
    );
    return { wallet, entry, batch };
  });
  await notifyBranchGive({ branchId: branch._id, branchName: branch.name, accountName: result.entry.accountName, cents: amountCents, note, batch: result.batch, sender: req.user });
  await logAudit({ user: req.user, action: 'companyWallet.give_to_branch', entityType: 'CompanyWallet', entityId: result.wallet._id, details: { batch: result.batch, branch: branch.name, account: result.entry.accountName, amount: fromCents(amountCents) } });
  res.status(201).json({ success: true, data: { batch: result.batch, total: fromCents(amountCents), entry: entryDTO(result.entry) } });
});

// DELETE /api/company-wallets/:id/takes/:batch -- undoes a whole "Take from
// branches" (every account gets its money back, the wallet goes down) or a
// "Give to branch" (the account gives it back, the wallet goes up).
export const deleteTake = asyncHandler(async (req, res) => {
  const total = await runInTransaction(async (session) => {
    const wallet = await CompanyWallet.findById(req.params.id).session(session);
    if (!wallet || !wallet.isActive) throw new ApiError(404, 'Wallet not found.');
    let entries = await CompanyWalletEntry.find({ wallet: wallet._id, batch: req.params.batch }).session(session);
    if (!entries.length && mongoose.isValidObjectId(req.params.batch)) {
      entries = await CompanyWalletEntry.find({ wallet: wallet._id, _id: req.params.batch, account: { $ne: null } }).session(session);
    }
    if (!entries.length) throw new ApiError(404, 'Statement not found.');
    // A take put money in the wallet (undo takes it out); a give took money
    // out (undo puts it back).
    const sum = entries.reduce((t, e) => t + e.amountCents, 0);
    const net = entries.reduce((t, e) => t + (e.type === 'WITHDRAW' ? -e.amountCents : e.amountCents), 0);
    if (wallet.balanceCents < net) throw new ApiError(400, 'Cannot undo: part of this money was already taken out of the wallet.');
    for (const e of entries) await reverseBranchMove(e, wallet, req.user, session, ` (${req.params.batch})`);
    wallet.balanceCents -= net;
    await wallet.save({ session });
    await CompanyWalletEntry.deleteMany({ _id: { $in: entries.map((e) => e._id) } }, { session });
    return sum;
  });
  await logAudit({ user: req.user, action: 'companyWallet.take_undone', entityType: 'CompanyWallet', entityId: req.params.id, details: { batch: req.params.batch, total: fromCents(total) } });
  res.json({ success: true, data: { batch: req.params.batch, total: fromCents(total) } });
});
