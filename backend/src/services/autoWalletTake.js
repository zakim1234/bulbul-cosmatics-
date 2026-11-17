import Branch from '../models/Branch.js';
import Account from '../models/Account.js';
import CompanyWallet from '../models/CompanyWallet.js';
import CompanyWalletEntry from '../models/CompanyWalletEntry.js';
import AutoTakeDue from '../models/AutoTakeDue.js';
import { getCompanySetting } from '../models/CompanySetting.js';
import { nextSequence } from '../models/Counter.js';
import { runWithBranch } from './branchContext.js';
import { postImmediateTransaction } from './accountService.js';
import { runInTransaction } from '../utils/transaction.js';
import { logAudit } from './auditService.js';
import { notifyBranchTake } from './walletNotify.js';

// Automatic daily take into the company wallet.
//
// The Super Admin sets an amount (e.g. $500) and a wallet. Every day at 12:00
// noon Somalia time each open branch owes that amount. It is taken from the
// branch's accounts straight away (the fullest account first). If the
// accounts do not hold enough -- even all at zero -- the rest stays owed
// (shown as -$100 etc.), and is taken the moment money comes into any of the
// branch's accounts: owed branches are checked every minute.
//
// Each take is a normal "Take from branches" statement (CWT-...), so it shows
// in the wallet's history, in the account statements and can be undone.

const TZ = process.env.AUTO_CLOSE_TZ || 'Africa/Mogadishu';
export const AUTO_TAKE_HOUR = Number(process.env.AUTO_TAKE_HOUR ?? 12);
const BY = 'Automatic (12:00 noon)';

function businessNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// Takes what the branch owes from its accounts, as far as they go.
export async function sweepBranch(branch, walletId) {
  const result = await runInTransaction(async (session) => {
    const due = await AutoTakeDue.findOne({ branch: branch._id }).session(session);
    if (!due || due.owedCents <= 0) return null;
    const wallet = await CompanyWallet.findById(walletId).session(session);
    if (!wallet || !wallet.isActive) return null;
    const accounts = await runWithBranch(branch._id, async () =>
      await Account.find({ isActive: true, currentBalanceCents: { $gt: 0 } }).sort({ currentBalanceCents: -1 }).session(session)
    );
    if (!accounts.length) return null;
    const now = new Date();
    const seq = await nextSequence('walletTake', session);
    const batch = `CWT-${now.getFullYear()}-${String(seq).padStart(4, '0')}`;
    let left = due.owedCents;
    let taken = 0;
    const lines = [];
    for (const account of accounts) {
      if (left <= 0) break;
      const amountCents = Math.min(left, account.currentBalanceCents);
      const txn = await runWithBranch(branch._id, async () =>
        await postImmediateTransaction(
          { account, direction: 'OUT', type: 'WITHDRAWAL', amountCents, referenceType: 'Manual', description: `Taken to company wallet ${wallet.name} -- automatic daily take`, createdBy: null },
          session
        )
      );
      wallet.balanceCents += amountCents;
      await CompanyWalletEntry.create(
        [
          {
            wallet: wallet._id,
            type: 'DEPOSIT',
            amountCents,
            balanceAfterCents: wallet.balanceCents,
            date: now,
            person: BY,
            note: 'Automatic daily take',
            branch: branch._id,
            branchName: branch.name,
            account: account._id,
            accountName: account.name,
            accountTransaction: txn?._id || null,
            batch,
            createdBy: null,
            createdByName: BY,
          },
        ],
        { session }
      );
      left -= amountCents;
      taken += amountCents;
      lines.push({ accountName: account.name, cents: amountCents });
    }
    due.owedCents = left;
    await due.save({ session });
    await wallet.save({ session });
    return { batch, taken, left, lines };
  });
  if (result?.taken) {
    console.log(`[auto-take] ${branch.name}: ${(result.taken / 100).toFixed(2)} taken (${result.batch}); still owed ${(result.left / 100).toFixed(2)}.`);
    await notifyBranchTake({ branchId: branch._id, branchName: branch.name, items: result.lines, batch: result.batch, owedCents: result.left, automatic: true });
    await logAudit({ user: null, action: 'companyWallet.auto_take', entityType: 'CompanyWallet', entityId: walletId, details: { branch: branch.name, batch: result.batch, taken: result.taken / 100, owed: result.left / 100 } }).catch(() => {});
  }
  return result;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const s = await getCompanySetting();
    if (!s.autoTakeEnabled || !s.autoTakeWallet) return;
    const { day, hour } = businessNow();
    const branches = await Branch.find({ active: { $ne: false } }).select('_id name').lean();
    for (const b of branches) {
      try {
        await AutoTakeDue.updateOne({ branch: b._id }, { $setOnInsert: { branch: b._id, owedCents: 0, lastChargedDay: '' }, $set: { branchName: b.name } }, { upsert: true });
        // 12:00 noon: today's amount is added once.
        let charged = false;
        // Each branch's own amount, or the one set for every branch.
        const mine = await AutoTakeDue.findOne({ branch: b._id }).select('dailyCents').lean();
        const daily = mine?.dailyCents != null ? mine.dailyCents : s.autoTakeAmountCents || 0;
        if (hour >= AUTO_TAKE_HOUR && daily > 0) {
          const r = await AutoTakeDue.updateOne({ branch: b._id, lastChargedDay: { $ne: day } }, { $inc: { owedCents: daily }, $set: { lastChargedDay: day } });
          charged = r.modifiedCount > 0;
          if (charged) console.log(`[auto-take] ${b.name}: ${(daily / 100).toFixed(2)} due for ${day}.`);
        }
        const swept = await sweepBranch(b, s.autoTakeWallet);
        // Nothing could be taken at noon (the accounts are empty): the admins
        // are told what the branch owes; it is taken on its own later.
        if (charged && !swept?.taken) {
          const d = await AutoTakeDue.findOne({ branch: b._id }).lean();
          if (d?.owedCents > 0) await notifyBranchTake({ branchId: b._id, branchName: b.name, items: [], owedCents: d.owedCents, automatic: true });
        }
      } catch (err) {
        console.warn(`[auto-take] ${b.name}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn('[auto-take] check failed:', err.message);
  } finally {
    running = false;
  }
}

export function startAutoWalletTake() {
  if (String(process.env.AUTO_TAKE || '').toLowerCase() === 'off') return;
  console.log(`[auto-take] checking every minute; daily take at ${AUTO_TAKE_HOUR}:00 (${TZ}) when switched on in Company Wallet.`);
  setInterval(tick, 60 * 1000).unref?.();
  tick();
}
