import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { toCents, fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';
import { logAudit } from '../services/auditService.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { resolveExpenseCategory } from '../services/expenseCategoryService.js';
import Liability from '../models/Liability.js';
import Expense from '../models/Expense.js';
import { chargeExpenseLater, voidExpenseDoc } from '../services/expenseService.js';
import Account from '../models/Account.js';

// The Liabilities page (sidebar, next to Fixed Assets). A liability is an
// expense charged now but not paid yet: it counts in Profit & Loss on its
// date (Net Income goes down) while no money moves; when money comes it is
// paid from an account and the debt goes down. An Opening Balance is a debt
// from before this system: not an expense, only something to pay off.
// See models/Liability.js. Reading: whoever sees Fixed Assets; changing:
// the admin (and Super Admin).
const router = Router();
router.use(requireAuth);
router.use(requirePermission('fixedAssets'));

const dto = (l) => ({
  id: l._id,
  name: l.name,
  category: l.category,
  amount: fromCents(l.amountCents),
  paid: fromCents(l.paidCents || 0),
  left: fromCents(l.amountCents - (l.paidCents || 0)),
  date: l.date,
  note: l.note,
  opening: !!l.opening,
  createdByName: l.createdByName,
  payments: (l.payments || []).map((p) => ({ id: p._id, amount: fromCents(p.amountCents), date: p.date, accountName: p.accountName, note: p.note, createdByName: p.createdByName })),
});

function parseAmount(value) {
  const n = Number(value);
  const cents = toCents(n);
  if (value === '' || value == null || !Number.isFinite(n) || cents <= 0) throw new ApiError(400, 'Amount must be greater than zero.');
  return cents;
}

function parseDate(value) {
  if (!value) return new Date();
  const day = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'Enter a valid date.');
  return new Date(`${day}T12:00:00`);
}

async function fields(body, { opening }) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!name) throw new ApiError(400, 'Enter who or what the money is owed for.');
  const category = opening ? '' : await resolveExpenseCategory(body.category);
  return { name, category, amountCents: parseAmount(body.amount), date: parseDate(body.date), note: String(body.note || '').trim().slice(0, 500) };
}

// GET /api/liabilities
router.get('/', asyncHandler(async (req, res) => {
  const list = await Liability.find().sort({ date: -1, createdAt: -1 }).lean();
  const sum = (f) => fromCents(list.reduce((t, l) => t + f(l), 0));
  res.json({
    success: true,
    data: {
      liabilities: list.map(dto),
      total: sum((l) => l.amountCents),
      paid: sum((l) => l.paidCents || 0),
      left: sum((l) => l.amountCents - (l.paidCents || 0)),
    },
  });
}));

// POST /api/liabilities { name, category, amount, date, note, opening }
// A normal one is charged as an Expense too (EXP number, on the Expenses
// page) with no account moving; an opening one is only a debt.
router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const opening = req.body.opening === true || req.body.opening === 'true';
  const f = await fields(req.body, { opening });
  const l = opening
    ? await Liability.create({ ...f, opening, createdBy: req.user._id, createdByName: req.user.name })
    : (await runInTransaction((session) => chargeExpenseLater(session, { category: f.category, amountCents: f.amountCents, date: f.date, name: f.name, note: f.note, user: req.user }))).liability;
  await logAudit({ user: req.user, action: 'liability.create', entityType: 'Liability', entityId: l._id, details: { name: l.name, amount: fromCents(l.amountCents), opening } });
  res.status(201).json({ success: true, data: dto(l) });
}));

// PUT /api/liabilities/:id -- corrects one; never below what was paid.
router.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Liability not found.');
  const l = await Liability.findById(req.params.id);
  if (!l) throw new ApiError(404, 'Liability not found.');
  const f = await fields(req.body, { opening: l.opening });
  if (f.amountCents < (l.paidCents || 0)) throw new ApiError(400, `${fromCents(l.paidCents).toFixed(2)} of it is already paid: the amount cannot be less.`);
  Object.assign(l, f);
  await l.save();
  // Its expense says the same.
  if (l.expense) await Expense.updateOne({ _id: l.expense }, { $set: { category: f.category, amountCents: f.amountCents, date: f.date, note: f.note || f.name } });
  await logAudit({ user: req.user, action: 'liability.update', entityType: 'Liability', entityId: l._id, details: { name: l.name, amount: fromCents(l.amountCents) } });
  res.json({ success: true, data: dto(l) });
}));

// DELETE /api/liabilities/:id -- only one with nothing paid yet.
router.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Liability not found.');
  const l = await Liability.findById(req.params.id);
  if (!l) throw new ApiError(404, 'Liability not found.');
  if (l.payments.length) throw new ApiError(400, 'Part of it is already paid. Undo the payments first.');
  // Charged as an expense: that expense is voided (this line goes with it).
  if (l.expense) {
    await runInTransaction(async (session) => {
      const exp = await Expense.findById(l.expense).session(session);
      if (exp && exp.status !== 'VOIDED') await voidExpenseDoc(session, exp, { reason: 'Liability deleted', user: req.user });
      await Liability.deleteOne({ _id: l._id }, { session });
    });
  } else {
    await Liability.deleteOne({ _id: l._id });
  }
  await logAudit({ user: req.user, action: 'liability.delete', entityType: 'Liability', entityId: l._id, details: { name: l.name, amount: fromCents(l.amountCents) } });
  res.json({ success: true, data: { id: l._id } });
}));

// POST /api/liabilities/:id/pay { amount, paymentAccountId, date, note }
router.post('/:id/pay', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Liability not found.');
  const amountCents = parseAmount(req.body.amount);
  if (!mongoose.isValidObjectId(req.body.paymentAccountId)) throw new ApiError(400, 'Choose the account the money is paid from.');
  const note = String(req.body.note || '').trim().slice(0, 500);
  const l = await runInTransaction(async (session) => {
    const doc = await Liability.findById(req.params.id).session(session);
    if (!doc) throw new ApiError(404, 'Liability not found.');
    const left = doc.amountCents - (doc.paidCents || 0);
    if (amountCents > left) throw new ApiError(400, `Only ${fromCents(left).toFixed(2)} is left to pay on ${doc.name}.`);
    const account = await Account.findById(req.body.paymentAccountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'Selected account is not available.');
    if (amountCents > account.currentBalanceCents) throw new ApiError(400, `${account.name} has only ${fromCents(account.currentBalanceCents).toFixed(2)}.`);
    const txn = await postImmediateTransaction(
      { account, direction: 'OUT', type: 'WITHDRAWAL', amountCents, referenceType: 'Manual', description: `Liability paid: ${doc.name}${note ? ` -- ${note}` : ''}`, createdBy: req.user },
      session
    );
    doc.payments.push({ amountCents, date: parseDate(req.body.date), account: account._id, accountName: account.name, accountTransaction: txn?._id || null, note, createdByName: req.user.name });
    doc.paidCents = (doc.paidCents || 0) + amountCents;
    await doc.save({ session });
    return doc;
  });
  await logAudit({ user: req.user, action: 'liability.pay', entityType: 'Liability', entityId: l._id, details: { name: l.name, amount: fromCents(amountCents) } });
  res.status(201).json({ success: true, data: dto(l) });
}));

// DELETE /api/liabilities/:id/payments/:paymentId -- undoes a payment: the
// money comes back into its account and the debt goes up again.
router.delete('/:id/payments/:paymentId', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.paymentId)) throw new ApiError(404, 'Payment not found.');
  const l = await runInTransaction(async (session) => {
    const doc = await Liability.findById(req.params.id).session(session);
    const p = doc?.payments.id(req.params.paymentId);
    if (!p) throw new ApiError(404, 'Payment not found.');
    const account = await Account.findById(p.account).session(session);
    if (!account) throw new ApiError(400, `The account "${p.accountName}" no longer exists, so the money cannot come back.`);
    await postImmediateTransaction(
      { account, direction: 'IN', type: 'DEPOSIT', amountCents: p.amountCents, referenceType: 'Manual', description: `Liability payment undone: ${doc.name}`, createdBy: req.user },
      session
    );
    doc.paidCents -= p.amountCents;
    p.deleteOne();
    await doc.save({ session });
    return doc;
  });
  await logAudit({ user: req.user, action: 'liability.payment_undo', entityType: 'Liability', entityId: l._id, details: { name: l.name } });
  res.json({ success: true, data: dto(l) });
}));

export default router;
