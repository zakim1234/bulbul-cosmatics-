import Expense from '../models/Expense.js';
import { listExpenseCategories, resolveExpenseCategory, addExpenseCategory } from '../services/expenseCategoryService.js';
import Account from '../models/Account.js';
import { postExpense, voidExpenseDoc, chargeExpenseLater } from '../services/expenseService.js';
import Liability from '../models/Liability.js';
import { logAudit } from '../services/auditService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { resolveDateRange } from '../utils/dateRange.js';
import { runInTransaction } from '../utils/transaction.js';

// `owed`: for one charged to Liabilities, its line there -- what is paid
// (each payment: account, amount, date) and what is left.
function toDTO(e, owed = null) {
  const l = owed && typeof owed === 'object' ? owed : null;
  return {
    payLater: !!e.liability,
    liability: e.liability
      ? {
          id: e.liability,
          paid: l ? fromCents(l.paidCents || 0) : 0,
          left: l ? fromCents(l.amountCents - (l.paidCents || 0)) : fromCents(e.amountCents),
          payments: (l?.payments || []).map((p) => ({ amount: fromCents(p.amountCents), accountName: p.accountName, date: p.date })),
        }
      : null,
    id: e._id,
    expenseNumber: e.expenseNumber,
    category: e.category,
    amount: fromCents(e.amountCents),
    date: e.date,
    paymentAccount: e.paymentAccount,
    paymentAccountName: e.paymentAccountName,
    note: e.note,
    status: e.status,
    voidedAt: e.voidedAt,
    voidReason: e.voidReason,
    createdByName: e.createdByName,
    createdAt: e.createdAt,
  };
}

// Expense dates are calendar days, not instants. Anchoring them at local noon
// keeps them inside the right day for every from/to range the reports build,
// whatever timezone the server runs in.
export function parseExpenseDate(value) {
  if (!value) return new Date();
  const day = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'Enter a valid expense date.');
  const date = new Date(`${day}T12:00:00`);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'Enter a valid expense date.');
  return date;
}

// GET /api/expenses/categories
export const getExpenseCategories = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listExpenseCategories() });
});

// POST /api/expenses/categories -- admin/manager only (enforced at the route).
export const createExpenseCategory = asyncHandler(async (req, res) => {
  const name = await addExpenseCategory(req.body.name);
  await logAudit({ user: req.user, action: 'expense.category.create', entityType: 'ExpenseCategory', details: { name } });
  res.status(201).json({ success: true, data: { name, categories: await listExpenseCategories() } });
});

// POST /api/expenses
export const createExpense = asyncHandler(async (req, res) => {
  const { amount, date, paymentAccountId, note = '' } = req.body;
  const category = await resolveExpenseCategory(req.body.category);
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0 || !Number.isSafeInteger(toCents(amountNumber)) || toCents(amountNumber) <= 0) {
    throw new ApiError(400, 'Amount must be greater than zero.');
  }
  // Pay later: charged now (Profit & Loss, this list) and put on the
  // Liabilities page to be paid from an account when the money comes.
  const payLater = req.body.payLater === true;
  if (payLater && req.user?.role !== 'admin') throw new ApiError(403, 'Only the admin can charge an expense to Liabilities.');
  if (!payLater && !paymentAccountId) throw new ApiError(400, 'Please select a payment account.');
  if (String(note).length > 500) throw new ApiError(400, 'Note is too long (500 characters max).');
  const amountCents = toCents(amountNumber);
  const expenseDate = parseExpenseDate(date);

  const expense = await runInTransaction(async (session) => {
    if (payLater) return (await chargeExpenseLater(session, { category, amountCents, date: expenseDate, name: String(note).trim() || `${category} -- ${String(date || '').slice(0, 10)}`, note, user: req.user })).expense;
    const account = await Account.findById(paymentAccountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'Selected payment account is not available.');

    return postExpense(session, { category, amountCents, date: expenseDate, account, note, user: req.user });
  });

  await logAudit({
    user: req.user,
    action: 'expense.create',
    entityType: 'Expense',
    entityId: expense._id,
    details: { expenseNumber: expense.expenseNumber, category, amount: amountNumber, account: expense.paymentAccountName, payLater },
  });

  res.status(201).json({ success: true, data: toDTO(expense) });
});

// GET /api/expenses?range=|from=|to=&category=&includeVoided=
// `summary.totalThisMonth` is always the calendar month to date regardless of
// the list's own filters, mirroring the "Total This Month" line on the page.
export const listExpenses = asyncHandler(async (req, res) => {
  const { category, includeVoided } = req.query;
  const filter = {};
  if (req.query.range || req.query.from || req.query.to) {
    const { start, end } = resolveDateRange(req.query);
    filter.date = { $gte: start, $lte: end };
  }
  if (category) {
    filter.category = await resolveExpenseCategory(category);
  }
  if (includeVoided !== 'true') filter.status = 'POSTED';

  const month = resolveDateRange({ range: 'month' });
  const [expenses, [monthAgg], [filteredAgg]] = await Promise.all([
    Expense.find(filter).sort({ date: -1, createdAt: -1 }).limit(500),
    Expense.aggregate([
      { $match: { status: 'POSTED', date: { $gte: month.start, $lte: month.end } } },
      { $group: { _id: null, total: { $sum: '$amountCents' } } },
    ]),
    Expense.aggregate([
      { $match: { ...filter, status: 'POSTED' } },
      { $group: { _id: null, total: { $sum: '$amountCents' } } },
    ]),
  ]);

  const owed = new Map((await Liability.find({ _id: { $in: expenses.map((e) => e.liability).filter(Boolean) } }).select('amountCents paidCents payments').lean()).map((l) => [String(l._id), l]));
  res.json({
    success: true,
    data: {
      expenses: expenses.map((e) => toDTO(e, e.liability ? owed.get(String(e.liability)) : null)),
      summary: { totalThisMonth: fromCents(monthAgg?.total || 0), totalFiltered: fromCents(filteredAgg?.total || 0) },
      categories: await listExpenseCategories(),
    },
  });
});

// POST /api/expenses/:id/void -- admin/manager only (enforced at the route).
// Puts the money back into the account it left as one compensating IN
// transaction; the original expense and its OUT transaction stay on record.
export const voidExpense = asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const expense = await runInTransaction(async (session) => {
    const doc = await Expense.findById(req.params.id).session(session);
    if (!doc) throw new ApiError(404, 'Expense not found.');
    return voidExpenseDoc(session, doc, { reason, user: req.user });
  });

  await logAudit({
    user: req.user,
    action: 'expense.void',
    entityType: 'Expense',
    entityId: expense._id,
    details: { expenseNumber: expense.expenseNumber, reason },
  });

  res.json({ success: true, data: toDTO(expense) });
});
