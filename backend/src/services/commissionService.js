import mongoose from 'mongoose';
import CommissionPayment from '../models/CommissionPayment.js';
import Expense from '../models/Expense.js';
import User from '../models/User.js';
import Worker from '../models/Worker.js';
import Account from '../models/Account.js';
import { nextSequence } from '../models/Counter.js';
import { computePeriod } from './profitLossService.js';
import { postExpense, voidExpenseDoc } from './expenseService.js';
import { resolveExpenseCategory } from './expenseCategoryService.js';
import { periodRange } from './itemsSoldService.js';
import { currentBranch, runWithBranch } from './branchContext.js';
import Branch from '../models/Branch.js';
import { getCompanySetting } from '../models/CompanySetting.js';
import { ApiError } from '../utils/ApiError.js';
import { runInTransaction } from '../utils/transaction.js';

const COMMISSION = 'Commission';

function range(type, key) {
  if (!['month', 'year'].includes(type)) throw new ApiError(400, 'Choose monthly or yearly.');
  return periodRange(type, key); // [start, end)
}

// The period's profit before commissions: the P&L net income with any
// commission already posted in it added back, so paying commission never
// shrinks the base it is a percentage of.
export async function profitBeforeCommissionCents(type, key) {
  const { start, end } = range(type, key);
  const last = new Date(end.getTime() - 1);
  const [{ netIncomeCents }, [paid]] = await Promise.all([
    computePeriod({ start, end: last, basis: 'accrual' }),
    Expense.aggregate([
      { $match: { status: 'POSTED', category: COMMISSION, date: { $gte: start, $lt: end } } },
      { $group: { _id: null, cents: { $sum: '$amountCents' } } },
    ]),
  ]);
  // The year's profit includes the opening Net Income (this year's profit
  // from before the system), as on the Balance Sheet: the yearly commission
  // is shared from all of it. A month is only that month's profit, so the
  // opening is never paid on twice.
  let openingCents = 0;
  if (type === 'year') {
    const setting = await getCompanySetting();
    if (setting.openingNetIncomeYear === start.getFullYear()) openingCents = setting.openingNetIncomeCents || 0;
  }
  return netIncomeCents + (paid?.cents || 0) + openingCents;
}

// Who can receive commission: the branch's active users (staff and admins).
export async function commissionStaff() {
  return User.find({ active: { $ne: false }, ...(currentBranch() ? { branch: currentBranch() } : {}) })
    .select('name username phone role branch isSuperAdmin')
    .sort({ name: 1 });
}

// Workers without a login (porters, cleaners...) can get staff commission too.
export async function commissionWorkers() {
  return Worker.find({ active: { $ne: false } }).select('name job phone branch').sort({ name: 1 });
}

export async function previewCommission({ type, key }) {
  const { start, end } = range(type, key);
  const [baseProfitCents, staff, earlier, workers, yearCents] = await Promise.all([
    profitBeforeCommissionCents(type, key),
    commissionStaff(),
    CommissionPayment.find({ periodType: type, periodKey: key, status: 'ACTIVE' }).sort({ createdAt: 1 }),
    commissionWorkers(),
    // On a month, the whole year so far too (opening Net Income + profit since).
    type === 'month' ? profitBeforeCommissionCents('year', String(start.getFullYear())) : null,
  ]);
  return { type, key, start, end, baseProfitCents, staff, earlier, workers, yearProfitCents: yearCents ?? baseProfitCents };
}

export async function payCommission({ type, key, kind = 'STAFF', paymentAccountId, lines, note = '', user }) {
  const { start, end } = range(type, key);
  if (!['STAFF', 'ADMIN'].includes(kind)) throw new ApiError(400, 'Choose staff or admin commission.');
  if (kind === 'ADMIN' && !user?.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin pays commission to branch admins.');
  if (!Array.isArray(lines) || !lines.length) throw new ApiError(400, 'Choose who gets commission and their percentage.');
  if (!paymentAccountId) throw new ApiError(400, 'Choose the account the commission is paid from.');
  if (String(note).length > 500) throw new ApiError(400, 'Note is too long (500 characters max).');
  const cleaned = lines.map((l, i) => {
    const percent = Number(l.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new ApiError(400, `Line ${i + 1}: the percentage must be more than 0 and at most 100.`);
    return { userId: l.userId || null, workerId: l.workerId || null, name: String(l.name || '').trim(), percent: Math.round(percent * 100) / 100 };
  });
  const totalPercent = cleaned.reduce((s, l) => s + l.percent, 0);
  if (totalPercent > 100.0001) throw new ApiError(400, `Commission cannot be more than 100% of the profit (now ${Math.round(totalPercent * 100) / 100}%).`);

  const baseProfitCents = await profitBeforeCommissionCents(type, key);
  if (baseProfitCents <= 0) throw new ApiError(400, 'This period has no profit to pay commission on.');
  const category = await resolveExpenseCategory(COMMISSION);
  // The expense lands inside the period it is for: today, or the period's
  // last day when paying for a period that has already ended.
  const now = new Date();
  const date = now < end ? now : new Date(end.getTime() - 12 * 3600 * 1000);

  return runInTransaction(async (session) => {
    const account = await Account.findById(paymentAccountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'Selected account is not available.');

    // Never the same person twice for the same period.
    const earlier = await CommissionPayment.find({ periodType: type, periodKey: key, status: 'ACTIVE' }).session(session);
    const paidUsers = new Set(earlier.flatMap((c) => c.lines.filter((l) => l.user).map((l) => String(l.user))));
    const paidWorkers = new Set(earlier.flatMap((c) => c.lines.filter((l) => l.worker).map((l) => String(l.worker))));
    const paidNames = new Set(earlier.flatMap((c) => c.lines.filter((l) => !l.user && !l.worker).map((l) => l.name.toLowerCase())));
    const earlierPercent = earlier.reduce((s, c) => s + c.lines.reduce((x, l) => x + l.percent, 0), 0);
    if (earlierPercent + totalPercent > 100.0001) throw new ApiError(400, `This period already has ${earlierPercent}% commission paid; the total cannot go over 100%.`);

    const seq = await nextSequence('commission', session);
    const commissionNumber = `CM-${start.getFullYear()}-${String(seq).padStart(4, '0')}`;
    const periodLabel = type === 'year' ? key : key;
    const built = [];
    const seen = new Set();
    for (const l of cleaned) {
      let person = null;
      if (l.userId) {
        if (!mongoose.isValidObjectId(l.userId)) throw new ApiError(400, 'A selected person is not valid.');
        person = await User.findById(l.userId).select('name role').session(session);
        if (!person) throw new ApiError(404, 'A selected person no longer exists.');
      }
      let worker = null;
      if (!person && l.workerId) {
        if (kind !== 'STAFF') throw new ApiError(400, 'Workers get staff commission, not admin commission.');
        if (!mongoose.isValidObjectId(l.workerId)) throw new ApiError(400, 'A selected worker is not valid.');
        worker = await Worker.findById(l.workerId).select('name').session(session);
        if (!worker) throw new ApiError(404, 'A selected worker no longer exists.');
        if (paidWorkers.has(String(worker._id))) throw new ApiError(409, `${worker.name} has already been paid commission for ${periodLabel}.`);
      }
      const name = person?.name || worker?.name || l.name;
      if (!name) throw new ApiError(400, 'Enter the name of each person.');
      // Staff commission never goes to an admin, admin commission only to admins.
      if (kind === 'STAFF' && person?.role === 'admin') throw new ApiError(403, `${name} is an admin: their commission is paid by the Super Admin (Admin commission).`);
      if (kind === 'ADMIN' && person?.role !== 'admin') throw new ApiError(400, `${name} is not a branch admin; pay them under Staff commission.`);
      const who = person ? String(person._id) : worker ? `w:${worker._id}` : `name:${name.toLowerCase()}`;
      if (seen.has(who)) throw new ApiError(400, `${name} is listed twice.`);
      seen.add(who);
      if ((person && paidUsers.has(String(person._id))) || (!person && !worker && paidNames.has(name.toLowerCase()))) {
        throw new ApiError(409, `${name} has already been paid commission for ${periodLabel}.`);
      }
      const amountCents = Math.round((baseProfitCents * l.percent) / 100);
      const expense =
        amountCents > 0
          ? await postExpense(session, { category, amountCents, date, account, note: `${commissionNumber} ${name} ${l.percent}% of ${periodLabel} profit`, user })
          : null;
      built.push({ user: person?._id || null, worker: worker?._id || null, name, role: person?.role || (worker ? 'worker' : ''), percent: l.percent, amountCents, expense: expense?._id || null });
    }

    const [doc] = await CommissionPayment.create(
      [
        {
          commissionNumber,
          kind,
          periodType: type,
          periodKey: key,
          baseProfitCents,
          account: account._id,
          accountName: account.name,
          date,
          note: String(note).trim(),
          lines: built,
          totalCents: built.reduce((s, l) => s + l.amountCents, 0),
          createdBy: user?._id || null,
          createdByName: user?.name || '',
        },
      ],
      { session }
    );
    return doc;
  });
}

export async function cancelCommission({ id, reason = '', user }) {
  return runInTransaction(async (session) => {
    const doc = await CommissionPayment.findById(id).session(session);
    if (!doc) throw new ApiError(404, 'Commission payment not found.');
    if (doc.status === 'CANCELLED') throw new ApiError(409, 'This commission payment is already cancelled.');
    if (doc.kind === 'ADMIN' && !user?.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin can cancel admin commission.');
    for (const line of doc.lines) {
      if (!line.expense) continue;
      const exp = await Expense.findById(line.expense).session(session);
      if (exp && exp.status !== 'VOIDED') await voidExpenseDoc(session, exp, { reason: reason || `${doc.commissionNumber} cancelled`, user });
    }
    doc.status = 'CANCELLED';
    doc.cancelledAt = new Date();
    doc.cancelledByName = user?.name || '';
    doc.cancelReason = String(reason || '').slice(0, 500);
    await doc.save({ session });
    return doc;
  });
}

// The all-branches view: every open branch on its own -- its own profit,
// people (users and workers), accounts and what was already paid.
export async function previewCommissionBranches({ type, key }) {
  range(type, key);
  const branches = await Branch.find({ active: true }).sort({ createdAt: 1 }).select('_id name').lean();
  const out = [];
  for (const b of branches) {
    out.push(
      await runWithBranch(b._id, async () => {
        const [p, accounts] = await Promise.all([previewCommission({ type, key }), Account.find({ isActive: true }).sort({ name: 1 }).select('_id name currentBalanceCents').lean()]);
        return { branch: b, ...p, accounts };
      })
    );
  }
  return out;
}

// Pays several branches at once, each in its own branch with its own profit
// and account. Everything is checked first, so a mistake in one branch stops
// it before anything is paid.
export async function payCommissionAllBranches({ type, key, kind = 'STAFF', branches, note = '', user }) {
  if (!Array.isArray(branches) || !branches.length) throw new ApiError(400, 'Type a percentage for at least one person.');
  const open = await Branch.find({ active: true }).select('_id name').lean();
  const byId = new Map(open.map((b) => [String(b._id), b]));
  const plan = [];
  for (const entry of branches) {
    const b = byId.get(String(entry?.branchId));
    if (!b) throw new ApiError(400, 'One of the branches is not open.');
    const lines = Array.isArray(entry.lines) ? entry.lines.filter((l) => Number(l.percent) > 0) : [];
    if (!lines.length) continue;
    if (!entry.paymentAccountId) throw new ApiError(400, `${b.name}: choose the account the commission is paid from.`);
    const base = await runWithBranch(b._id, () => profitBeforeCommissionCents(type, key));
    if (base <= 0) throw new ApiError(400, `${b.name} has no profit to pay commission on.`);
    const ok = await runWithBranch(b._id, async () => await Account.exists({ _id: entry.paymentAccountId, isActive: true }));
    if (!ok) throw new ApiError(400, `${b.name}: the chosen account is not available.`);
    plan.push({ b, lines, accountId: entry.paymentAccountId });
  }
  if (!plan.length) throw new ApiError(400, 'Type a percentage for at least one person.');
  const done = [];
  for (const p of plan) {
    try {
      const doc = await runWithBranch(p.b._id, () => payCommission({ type, key, kind, paymentAccountId: p.accountId, lines: p.lines, note, user }));
      done.push({ branchName: p.b.name, doc });
    } catch (err) {
      const saved = done.map((d) => d.branchName).join(', ');
      throw new ApiError(err.statusCode || 400, `${p.b.name}: ${err.message}${saved ? ` (already paid: ${saved})` : ''}`);
    }
  }
  return done;
}
