import mongoose from 'mongoose';
import { whoLabel } from '../utils/whoLabel.js';
import Account from '../models/Account.js';
import AccountTransaction from '../models/AccountTransaction.js';
import Payment from '../models/Payment.js';
import Sale from '../models/Sale.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { logAudit } from '../services/auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents } from '../utils/money.js';

const MOVABLE = ['SALE_PAYMENT', 'CUSTOMER_DEBT_PAYMENT'];

// POST /api/accounts/transactions/:txnId/move { toAccountId }
// A customer paid with EVC but eDahab was chosen: the money is moved to the
// right account. Still pending (before Close Day), the receipt just changes
// account. Already posted, eDahab gives it to EVC (a pair of entries, both
// shown on the statements) -- no profit or customer balance changes.
export const moveReceipt = asyncHandler(async (req, res) => {
  const { txnId } = req.params;
  const { toAccountId } = req.body;
  if (!mongoose.isValidObjectId(txnId) || !mongoose.isValidObjectId(toAccountId)) throw new ApiError(400, 'Choose the right account.');

  const result = await runInTransaction(async (session) => {
    const txn = await AccountTransaction.findById(txnId).session(session);
    if (!txn) throw new ApiError(404, 'Payment not found.');
    if (txn.direction !== 'IN' || !MOVABLE.includes(txn.type)) throw new ApiError(400, 'Only a customer payment (sale or debt payment) can be moved.');
    if (!['PENDING', 'POSTED'].includes(txn.status)) throw new ApiError(400, 'This payment was reversed; it cannot be moved.');
    if (txn.movedTo) throw new ApiError(409, `Already moved to ${txn.movedToName || 'another account'}.`);
    const [from, to] = await Promise.all([Account.findById(txn.account).session(session), Account.findOne({ _id: toAccountId, isActive: true }).session(session)]);
    if (!to) throw new ApiError(400, 'That account is not available.');
    if (String(from?._id) === String(to._id)) throw new ApiError(400, 'It is already in that account.');

    // Which receipt it is, for the records and the descriptions.
    let sale = null;
    let payment = null;
    if (txn.referenceType === 'Sale' && txn.referenceId) sale = await Sale.findById(txn.referenceId).session(session);
    if (txn.referenceType === 'Payment' && txn.referenceId) payment = await Payment.findById(txn.referenceId).session(session);
    const number = sale?.receiptNumber || payment?.receiptNumber || '';

    if (txn.status === 'PENDING') {
      // Not in any balance yet: it simply belongs to the other account.
      txn.account = to._id;
      txn.description = `${txn.description} (account corrected from ${from?.name || '?'})`;
      txn.correctionNote = `Wrong account corrected: ${from?.name || '?'} → ${to.name}`;
      txn.correctedByName = whoLabel(req.user);
      await txn.save({ session });
    } else {
      const label = number ? ` (${number})` : '';
      await postImmediateTransaction({ account: from, direction: 'OUT', type: 'ADJUSTMENT', amountCents: txn.amountCents, referenceType: txn.referenceType, referenceId: txn.referenceId, description: `Wrong account: moved to ${to.name}${label}`, createdBy: req.user }, session);
      await postImmediateTransaction({ account: to, direction: 'IN', type: 'ADJUSTMENT', amountCents: txn.amountCents, referenceType: txn.referenceType, referenceId: txn.referenceId, description: `Moved from ${from.name} -- paid here${label}`, createdBy: req.user }, session);
      txn.movedTo = to._id;
      txn.movedToName = to.name;
      txn.correctionNote = `Wrong account corrected: ${from.name} → ${to.name}`;
      txn.correctedByName = whoLabel(req.user);
      await txn.save({ session });
    }

    // The receipt now names the right account.
    if (sale) {
      sale.paymentAccount = to._id;
      await sale.save({ session });
      await Payment.updateMany({ relatedSale: sale._id, type: 'sale' }, { $set: { paymentAccount: to._id, paymentAccountName: to.name } }, { session });
    }
    if (payment) {
      payment.paymentAccount = to._id;
      payment.paymentAccountName = to.name;
      await payment.save({ session });
    }
    return { from, to, amountCents: txn.amountCents, number, pending: txn.status === 'PENDING' };
  });

  await logAudit({ user: req.user, action: 'account.move_receipt', entityType: 'AccountTransaction', entityId: txnId, details: { from: result.from?.name, to: result.to.name, amount: fromCents(result.amountCents), receipt: result.number } });
  res.json({ success: true, data: { from: result.from?.name, to: result.to.name, amount: fromCents(result.amountCents), receiptNumber: result.number, pending: result.pending } });
});
