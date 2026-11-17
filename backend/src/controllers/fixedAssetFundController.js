import mongoose from 'mongoose';
import FixedAssetFundEntry from '../models/FixedAssetFundEntry.js';
import FixedAsset from '../models/FixedAsset.js';
import ProfitDistribution from '../models/ProfitDistribution.js';
import Partner from '../models/Partner.js';
import Account from '../models/Account.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { yearNetProfitCents } from '../services/profitDistributionService.js';
import { fundBalanceCents } from '../services/fixedAssetFundService.js';
import { currentBranch } from '../services/branchContext.js';
import { logAudit } from '../services/auditService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';

// The Fixed Asset Wallet (see services/fixedAssetFundService.js): profit set
// aside from a year's Net Income, owed to the owners until paid out to them.

const entryDTO = (e) => ({
  id: e._id,
  type: e.type,
  amount: fromCents(e.amountCents),
  year: e.year,
  date: e.date,
  note: e.note,
  person: e.person,
  partner: e.partner,
  accountName: e.accountName,
  createdByName: e.createdByName,
});

function parseAmount(value) {
  const n = Number(value);
  const cents = toCents(n);
  if (!Number.isFinite(n) || cents <= 0) throw new ApiError(400, 'Amount must be greater than zero.');
  return cents;
}

function parseDate(value) {
  if (!value) return new Date();
  const day = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'Enter a valid date.');
  return new Date(`${day}T12:00:00`);
}

function parseYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError(400, 'Choose a valid year.');
  return year;
}

// What is still free to set aside from a year: its Net Income (already less
// what was set aside), unless that year's profit was already shared.
async function yearAvailable(year) {
  const shared = await ProfitDistribution.exists({ year, status: 'ACTIVE', ...(currentBranch() ? { branch: { $in: [currentBranch(), null] } } : {}) }).setOptions({ skipBranch: true });
  const left = await yearNetProfitCents(year);
  return { shared: !!shared, availableCents: shared ? 0 : Math.max(0, left) };
}

// Each person the equipment money is owed to: what was bought from them, what
// has been paid back to them, what is left. Names match whatever the case.
async function creditors(session = null) {
  const key = (n) => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const [bought, paid] = await Promise.all([
    // Opening-balance equipment is the company's own: nobody is owed for it.
    FixedAsset.aggregate([{ $match: { isActive: true, opening: { $ne: true } } }, { $group: { _id: '$owedTo', cents: { $sum: '$valueCents' } } }]).session(session),
    FixedAssetFundEntry.aggregate([{ $match: { type: 'PAYOUT' } }, { $group: { _id: '$person', cents: { $sum: '$amountCents' } } }]).session(session),
  ]);
  const out = new Map();
  const row = (name) => {
    const k = key(name);
    if (!out.has(k)) out.set(k, { name: String(name || '').trim() || 'Not named', boughtCents: 0, paidCents: 0 });
    return out.get(k);
  };
  for (const b of bought) row(b._id).boughtCents += b.cents;
  for (const p of paid) row(p._id).paidCents += p.cents;
  for (const c of out.values()) c.leftCents = Math.max(0, c.boughtCents - c.paidCents);
  return { list: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)), find: (name) => out.get(key(name)) || null };
}

// GET /api/fixed-assets/fund
export const getFund = asyncHandler(async (req, res) => {
  const year = new Date().getFullYear();
  const [balance, entries, thisYear, lastYear, owed] = await Promise.all([
    fundBalanceCents(),
    FixedAssetFundEntry.find().sort({ date: -1, createdAt: -1 }).limit(500).lean(),
    yearAvailable(year),
    yearAvailable(year - 1),
    creditors(),
  ]);
  const sum = (t) => entries.filter((e) => e.type === t).reduce((s, e) => s + e.amountCents, 0);
  res.json({
    success: true,
    data: {
      balance: fromCents(balance),
      setAside: fromCents(sum('SET_ASIDE')),
      paidOut: fromCents(sum('PAYOUT')),
      years: [
        { year, available: fromCents(thisYear.availableCents), shared: thisYear.shared },
        { year: year - 1, available: fromCents(lastYear.availableCents), shared: lastYear.shared },
      ],
      entries: entries.map(entryDTO),
      creditors: owed.list.map((c) => ({ name: c.name, bought: fromCents(c.boughtCents), paid: fromCents(c.paidCents), left: fromCents(c.leftCents) })),
    },
  });
});

// POST /api/fixed-assets/fund/set-aside { year, amount, date, note }
// Takes part of that year's Net Income into the wallet. No account moves.
export const setAside = asyncHandler(async (req, res) => {
  const year = parseYear(req.body.year);
  const amountCents = parseAmount(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 500);
  const { shared, availableCents } = await yearAvailable(year);
  if (shared) throw new ApiError(409, `The ${year} profit has already been shared with the partners. Cancel that sharing first to set money aside from it.`);
  if (amountCents > availableCents) throw new ApiError(400, `Only ${fromCents(availableCents).toFixed(2)} of the ${year} Net Income is left to set aside.`);
  const entry = await FixedAssetFundEntry.create({ type: 'SET_ASIDE', amountCents, year, date: parseDate(req.body.date), note, createdBy: req.user._id, createdByName: req.user.name });
  await logAudit({ user: req.user, action: 'fixedAssetFund.set_aside', entityType: 'FixedAssetFundEntry', entityId: entry._id, details: { year, amount: fromCents(amountCents) } });
  res.status(201).json({ success: true, data: entryDTO(entry) });
});

// POST /api/fixed-assets/fund/payout { amount, person | partnerId, paymentAccountId, date, note }
// Pays an owner from the wallet: the money leaves the chosen account.
export const payOut = asyncHandler(async (req, res) => {
  const amountCents = parseAmount(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!req.body.paymentAccountId || !mongoose.isValidObjectId(req.body.paymentAccountId)) throw new ApiError(400, 'Choose the account the money is paid from.');
  const entry = await runInTransaction(async (session) => {
    let partner = null;
    if (req.body.partnerId) {
      if (!mongoose.isValidObjectId(req.body.partnerId)) throw new ApiError(400, 'Choose a valid partner.');
      partner = await Partner.findById(req.body.partnerId).session(session);
      if (!partner || !partner.isActive) throw new ApiError(404, 'Partner not found.');
    }
    let person = partner ? partner.name : String(req.body.person || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!person) throw new ApiError(400, 'Choose the owner, or type the name of who receives it.');
    const [{ cents: balance = 0 } = {}] = await FixedAssetFundEntry.aggregate([{ $group: { _id: null, cents: { $sum: { $cond: [{ $eq: ['$type', 'PAYOUT'] }, { $multiply: ['$amountCents', -1] }, '$amountCents'] } } } }]).session(session);
    if (amountCents > balance) throw new ApiError(400, `The Fixed Asset Wallet has only ${fromCents(balance).toFixed(2)}.`);
    // Only someone the equipment money is owed to, and never more than
    // what is still owed to them.
    const creditor = (await creditors(session)).find(person);
    if (!creditor || !creditor.boughtCents) throw new ApiError(400, `Nothing is owed to ${person}: no fixed asset was bought from them.`);
    if (amountCents > creditor.leftCents) throw new ApiError(400, `Only ${fromCents(creditor.leftCents).toFixed(2)} is still owed to ${creditor.name}.`);
    person = creditor.name; // one spelling per person
    const account = await Account.findById(req.body.paymentAccountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'Selected account is not available.');
    if (amountCents > account.currentBalanceCents) throw new ApiError(400, `${account.name} has only ${fromCents(account.currentBalanceCents).toFixed(2)}.`);
    const txn = await postImmediateTransaction(
      { account, direction: 'OUT', type: 'WITHDRAWAL', amountCents, referenceType: 'Manual', description: `Fixed Asset Wallet paid to ${person}${note ? ` -- ${note}` : ''}`, createdBy: req.user },
      session
    );
    // A partner's "profit received" shows what they were paid.
    if (partner) {
      partner.totalProfitCents = (partner.totalProfitCents || 0) + amountCents;
      await partner.save({ session });
    }
    const [e] = await FixedAssetFundEntry.create(
      [{ type: 'PAYOUT', amountCents, date: parseDate(req.body.date), note, person, partner: partner?._id || null, account: account._id, accountName: account.name, accountTransaction: txn?._id || null, createdBy: req.user._id, createdByName: req.user.name }],
      { session }
    );
    return e;
  });
  await logAudit({ user: req.user, action: 'fixedAssetFund.payout', entityType: 'FixedAssetFundEntry', entityId: entry._id, details: { person: entry.person, amount: fromCents(amountCents), account: entry.accountName } });
  res.status(201).json({ success: true, data: entryDTO(entry) });
});

// DELETE /api/fixed-assets/fund/:entryId -- undoes a mistake. A set-aside
// goes back to that year's Net Income (only if the wallet still holds it); a
// payout comes back into its account.
export const deleteFundEntry = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.entryId)) throw new ApiError(404, 'Entry not found.');
  const entry = await runInTransaction(async (session) => {
    const e = await FixedAssetFundEntry.findById(req.params.entryId).session(session);
    if (!e) throw new ApiError(404, 'Entry not found.');
    if (e.type === 'SET_ASIDE') {
      const [{ cents: balance = 0 } = {}] = await FixedAssetFundEntry.aggregate([{ $group: { _id: null, cents: { $sum: { $cond: [{ $eq: ['$type', 'PAYOUT'] }, { $multiply: ['$amountCents', -1] }, '$amountCents'] } } } }]).session(session);
      if (balance < e.amountCents) throw new ApiError(400, 'Cannot undo: part of this money was already paid out. Undo the payout first.');
    } else {
      const account = e.account ? await Account.findById(e.account).session(session) : null;
      if (!account) throw new ApiError(400, `The account "${e.accountName}" no longer exists, so the money cannot come back.`);
      await postImmediateTransaction(
        { account, direction: 'IN', type: 'DEPOSIT', amountCents: e.amountCents, referenceType: 'Manual', description: `Fixed Asset Wallet payout to ${e.person} undone`, createdBy: req.user },
        session
      );
      if (e.partner) await Partner.updateOne({ _id: e.partner }, { $inc: { totalProfitCents: -e.amountCents } }, { session });
    }
    await FixedAssetFundEntry.deleteOne({ _id: e._id }, { session });
    return e;
  });
  await logAudit({ user: req.user, action: 'fixedAssetFund.undo', entityType: 'FixedAssetFundEntry', entityId: entry._id, details: { type: entry.type, amount: fromCents(entry.amountCents) } });
  res.json({ success: true, data: { id: entry._id } });
});
