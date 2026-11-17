import mongoose from 'mongoose';
import { whoLabel } from '../utils/whoLabel.js';
import Customer from '../models/Customer.js';
import CustomerLedger from '../models/CustomerLedger.js';
import Payment from '../models/Payment.js';
import Sale from '../models/Sale.js';
import AccountTransaction from '../models/AccountTransaction.js';
import { outstandingDebt, allocateDebt } from '../services/walletService.js';
import { logAudit } from '../services/auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents } from '../utils/money.js';

// POST /api/customers/:id/payments/:paymentId/move { toCustomerId, reason }
// A debt payment entered on the wrong customer (Cali instead of Cumar): Cali
// owes it again on the same invoices, and it pays Cumar's debt instead (his
// oldest first). The money stays in the account it came into -- the same
// receipt, now Cumar's.
export const moveCustomerPayment = asyncHandler(async (req, res) => {
  const { toCustomerId } = req.body;
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!mongoose.isValidObjectId(toCustomerId)) throw new ApiError(400, 'Choose the right customer.');
  if (String(toCustomerId) === String(req.params.id)) throw new ApiError(400, 'Choose a different customer.');

  const result = await runInTransaction(async (session) => {
    const [from, to] = await Promise.all([Customer.findById(req.params.id).session(session), Customer.findById(toCustomerId).session(session)]);
    if (!from) throw new ApiError(404, 'Customer not found.');
    if (!to) throw new ApiError(404, 'The right customer was not found.');
    const payment = await Payment.findOne({ _id: req.params.paymentId, customer: from._id }).session(session);
    if (!payment) throw new ApiError(404, 'Payment not found.');
    if (payment.type !== 'debt_payment') throw new ApiError(409, 'Only a debt payment can be moved. An invoice put on the wrong customer is moved from the invoice.');
    if (payment.status === 'CANCELLED') throw new ApiError(409, 'This payment is cancelled.');
    if (!payment.paymentAccount) throw new ApiError(409, `This was paid from ${from.name}'s wallet, so it is ${from.name}'s money; it cannot be moved.`);
    const amountCents = payment.amountCents;

    // The right customer must owe at least this much.
    const debt = await outstandingDebt(to, session);
    if (debt.totalCents < amountCents) throw new ApiError(400, `${to.name} owes only ${fromCents(debt.totalCents).toFixed(2)}, less than this ${fromCents(amountCents).toFixed(2)} payment.`);

    // 1. The wrong customer owes it again, on the same invoices.
    for (const a of payment.allocations) {
      if (!a.sale) continue; // the opening balance: owed again through balanceCents
      const sale = await Sale.findById(a.sale).session(session);
      if (!sale || sale.status !== 'CONFIRMED') throw new ApiError(409, `Invoice ${a.receiptNumber} was cancelled after this payment, so the payment cannot be moved.`);
      sale.outstandingCents += a.amountCents;
      await sale.save({ session });
    }
    const fromBefore = from.balanceCents;
    from.balanceCents += amountCents;
    from.totalPaidCents = Math.max(0, from.totalPaidCents - amountCents);
    await from.save({ session });
    const why = reason ? `: ${reason}` : '';
    await CustomerLedger.create(
      [{ customer: from._id, type: 'PAYMENT_CANCELLED', amountCents, payment: payment._id, description: `Payment ${payment.receiptNumber} was ${to.name}'s -- moved to ${to.name}${why}`, balanceBeforeCents: fromBefore, balanceAfterCents: from.balanceCents, createdBy: req.user?._id }],
      { session }
    );

    // 2. It pays the right customer's debt (opening debt, then oldest invoice).
    const allocations = await allocateDebt(debt, amountCents, session);
    const toBefore = to.balanceCents;
    to.balanceCents -= amountCents;
    to.totalPaidCents += amountCents;
    await to.save({ session });
    await CustomerLedger.create(
      [{ customer: to._id, type: 'PAYMENT', amountCents: -amountCents, payment: payment._id, description: `Debt payment ${payment.receiptNumber} (moved from ${from.name}) (${allocations.map((a) => a.receiptNumber).join(', ')})`, balanceBeforeCents: toBefore, balanceAfterCents: to.balanceCents, createdBy: req.user?._id }],
      { session }
    );

    // 3. The same receipt, now the right customer's.
    payment.customer = to._id;
    payment.allocations = allocations;
    payment.previousBalanceCents = toBefore;
    payment.newBalanceCents = to.balanceCents;
    payment.notes = `${payment.notes ? `${payment.notes} -- ` : ''}Moved from ${from.name}${why}`;
    await payment.save({ session });
    if (payment.accountTransaction) {
      await AccountTransaction.updateOne({ _id: payment.accountTransaction }, { $set: { description: `Debt payment ${payment.receiptNumber} — ${to.name} (moved from ${from.name})`, correctionNote: `Wrong customer corrected: ${from.name} → ${to.name}${why}`, correctedByName: whoLabel(req.user) } }, { session });
    }
    return { from, to, payment };
  });

  await logAudit({ user: req.user, action: 'customer.payment.move', entityType: 'Payment', entityId: result.payment._id, details: { receiptNumber: result.payment.receiptNumber, amount: fromCents(result.payment.amountCents), from: result.from.name, to: result.to.name, reason } });
  res.json({ success: true, data: { receiptNumber: result.payment.receiptNumber, amount: fromCents(result.payment.amountCents), from: result.from.name, to: result.to.name, toCustomerId: result.to._id } });
});
