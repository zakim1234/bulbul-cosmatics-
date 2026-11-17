import Purchase from '../models/Purchase.js';
import Supplier from '../models/Supplier.js';
import Account from '../models/Account.js';
import PurchasePayment from '../models/PurchasePayment.js';
import BulkPurchasePayment from '../models/BulkPurchasePayment.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents } from '../utils/money.js';
import { postImmediateTransaction } from './accountService.js';
import { generatePurchasePaymentNumber } from '../controllers/purchaseController.js';

// Completed invoices that still owe something, oldest first -- the order a
// supplier payment pays them in.
export const OUTSTANDING = { status: 'completed', balanceCents: { $gt: 0 } };
export const OLDEST_FIRST = { purchaseDate: 1, createdAt: 1, _id: 1 };

// What each supplier is owed, net: their invoices' balances less any credit
// they hold (a minus opening balance -- money we had paid them ahead). A
// supplier with -128 credit and a $100 invoice is owed nothing (we are still
// 28 ahead), so only suppliers owed something come out.
export const NET_OWED = [
  { $match: { status: 'completed', balanceCents: { $ne: 0 } } },
  {
    $group: {
      _id: '$supplier',
      name: { $first: '$supplierName' },
      owedCents: { $sum: '$balanceCents' },
      invoiceCount: { $sum: { $cond: [{ $gt: ['$balanceCents', 0] }, 1, 0] } },
    },
  },
  { $match: { owedCents: { $gt: 0 } } },
];

// The credit a supplier holds with us (cents, 0 or more).
async function creditCents(supplierId, session) {
  const [row] = await Purchase.aggregate([{ $match: { supplier: supplierId, status: 'completed', balanceCents: { $lt: 0 } } }, { $group: { _id: null, c: { $sum: '$balanceCents' } } }]).session(session);
  return -(row?.c || 0);
}

async function generateBulkNumber(session) {
  const seq = await nextSequence('bulkPurchasePayment', session);
  return `BPAY-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;
}

// Pays one supplier `amountCents` from one account, spread over their
// invoices oldest first: the selected `purchaseIds`, or every outstanding
// invoice of theirs when omitted. One account transaction, one
// PurchasePayment per invoice reached, one BulkPurchasePayment receipt.
// Runs inside the caller's transaction; returns the receipt document.
export async function paySupplier(session, { supplierId, purchaseIds = null, amountCents, discountCents = 0, paymentAccountId, paymentDate, note = '', percentage = null, receiptNo = '', user, offsetLabel = '' }) {
  const supplier = await Supplier.findById(supplierId).session(session);
  if (!supplier) throw new ApiError(404, 'Supplier not found.');
  // An offset (set off against what they owe us as a customer) moves no
  // money: no account, no account transaction.
  const account = offsetLabel ? null : await Account.findById(paymentAccountId).session(session);
  if (!offsetLabel && (!account || !account.isActive)) throw new ApiError(400, 'Selected payment account is not available.');

  let purchases;
  if (purchaseIds) {
    const uniqueIds = [...new Set(purchaseIds.map(String))];
    purchases = await Purchase.find({ _id: { $in: uniqueIds } }).sort(OLDEST_FIRST).session(session);
    if (purchases.length !== uniqueIds.length) throw new ApiError(404, 'One of the selected invoices was not found.');
  } else {
    purchases = await Purchase.find({ supplier: supplier._id, ...OUTSTANDING }).sort(OLDEST_FIRST).session(session);
    if (purchases.length === 0) throw new ApiError(409, `${supplier.name} has no unpaid invoices.`);
  }
  for (const p of purchases) {
    if (String(p.supplier) !== String(supplier._id)) throw new ApiError(400, `${p.purchaseNumber} belongs to a different supplier.`);
    if (p.status === 'voided') throw new ApiError(409, `${p.purchaseNumber} is voided and cannot be paid.`);
    if (p.balanceCents <= 0) throw new ApiError(409, `${p.purchaseNumber} is already fully paid.`);
  }
  const selectedOwedCents = purchases.reduce((s, p) => s + p.balanceCents, 0);
  if (amountCents + discountCents > selectedOwedCents) {
    throw new ApiError(400, discountCents ? `Amount plus discount exceeds what the selected invoices owe (${fromCents(selectedOwedCents).toFixed(2)}).` : `Amount exceeds what the selected invoices owe (${fromCents(selectedOwedCents).toFixed(2)}).`);
  }
  // Credit the supplier holds (money paid ahead) counts against what we owe.
  const credit = await creditCents(supplier._id, session);
  if (credit > 0) {
    const allOwed = (await Purchase.find({ supplier: supplier._id, ...OUTSTANDING }).select('balanceCents').session(session)).reduce((s, p) => s + p.balanceCents, 0);
    const netCents = allOwed - credit;
    if (amountCents + discountCents > netCents) {
      throw new ApiError(400, netCents > 0 ? `${supplier.name} holds ${fromCents(credit).toFixed(2)} credit, so only ${fromCents(netCents).toFixed(2)} is owed to them.` : `${supplier.name} holds ${fromCents(credit).toFixed(2)} credit, so nothing is owed to them (they owe us ${fromCents(-netCents).toFixed(2)}).`);
    }
  }

  const bulkNumber = await generateBulkNumber(session);
  const txn = offsetLabel ? null : await postImmediateTransaction(
    {
      account,
      direction: 'OUT',
      type: 'PURCHASE_PAYMENT',
      amountCents,
      referenceType: 'Purchase',
      referenceId: purchases[0]._id,
      description: `Bulk payment ${bulkNumber} to ${supplier.name}`,
      createdBy: user,
    },
    session
  );

  const [bulk] = await BulkPurchasePayment.create(
    [
      {
        bulkNumber,
        supplier: supplier._id,
        supplierName: supplier.name,
        amountCents,
        discountCents,
        selectedOwedCents,
        percentage,
        paymentAccount: account?._id || null,
        paymentAccountName: account?.name || offsetLabel,
        accountTransaction: txn?._id || null,
        paymentDate,
        note: String(note).trim(),
        receiptNo: String(receiptNo || '').trim(),
        allocations: [],
        createdBy: user?._id || null,
        createdByName: user?.name || '',
      },
    ],
    { session }
  );

  let remaining = amountCents;
  for (const purchase of purchases) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, purchase.balanceCents);
    const previousBalanceCents = purchase.balanceCents;
    purchase.paidAmountCents += take;
    purchase.balanceCents -= take;
    if (account) purchase.paymentAccount = account._id;
    await purchase.save({ session });

    const [payment] = await PurchasePayment.create(
      [
        {
          paymentNumber: await generatePurchasePaymentNumber(session),
          purchase: purchase._id,
          amountCents: take,
          paymentAccount: account?._id || null,
          paymentAccountName: account?.name || offsetLabel,
          accountTransaction: txn?._id || null,
          previousBalanceCents,
          newBalanceCents: purchase.balanceCents,
          note: `Part of bulk payment ${bulkNumber}${bulk.note ? ` — ${bulk.note}` : ''}`,
          paymentDate,
          receiptNo: bulk.receiptNo,
          bulkPayment: bulk._id,
          createdBy: user?._id,
        },
      ],
      { session }
    );
    bulk.allocations.push({
      purchase: purchase._id,
      purchaseNumber: purchase.purchaseNumber,
      payment: payment._id,
      amountCents: take,
      previousBalanceCents,
      newBalanceCents: purchase.balanceCents,
    });
    remaining -= take;
  }

  // The supplier's discount: clears the rest of the invoices the same way,
  // oldest first, but no money moves (Discount Received on the P&L).
  let discountLeft = discountCents;
  for (const purchase of purchases) {
    if (discountLeft <= 0) break;
    if (purchase.balanceCents <= 0) continue;
    const take = Math.min(discountLeft, purchase.balanceCents);
    const previousBalanceCents = purchase.balanceCents;
    purchase.paidAmountCents += take;
    purchase.balanceCents -= take;
    await purchase.save({ session });
    const [payment] = await PurchasePayment.create(
      [
        {
          paymentNumber: await generatePurchasePaymentNumber(session),
          purchase: purchase._id,
          amountCents: take,
          paymentAccount: null,
          paymentAccountName: 'Supplier discount',
          accountTransaction: null,
          previousBalanceCents,
          newBalanceCents: purchase.balanceCents,
          note: `Discount on bulk payment ${bulkNumber}${bulk.note ? ` — ${bulk.note}` : ''}`,
          paymentDate,
          receiptNo: bulk.receiptNo,
          bulkPayment: bulk._id,
          discount: true,
          createdBy: user?._id,
        },
      ],
      { session }
    );
    bulk.allocations.push({ purchase: purchase._id, purchaseNumber: purchase.purchaseNumber, payment: payment._id, amountCents: take, previousBalanceCents, newBalanceCents: purchase.balanceCents, discount: true });
    discountLeft -= take;
  }
  await bulk.save({ session });
  return bulk;
}

// Cancels one supplier payment: the money goes back to the account it came
// from (as its own REFUND transaction, so the account history stays
// exact) and the supplier is owed that much again. Already-cancelled
// payments are left alone. Runs inside the caller's transaction.
export async function reversePayment(session, payment, { reason = '', user, purchase = null }) {
  if (payment.status !== 'POSTED') return null;
  const invoice = purchase || (await Purchase.findById(payment.purchase).session(session));
  // An offset payment moved no money, so there is nothing to give back.
  const account = payment.paymentAccount ? await Account.findById(payment.paymentAccount).session(session) : null;
  if (payment.paymentAccount && !account) throw new ApiError(409, `The account payment ${payment.paymentNumber} was made from no longer exists. Contact an administrator.`);
  if (account) await postImmediateTransaction(
    {
      account,
      direction: 'IN',
      type: 'REFUND',
      amountCents: payment.amountCents,
      referenceType: 'Purchase',
      referenceId: payment.purchase,
      description: `Reversal of payment ${payment.paymentNumber}${invoice ? ` on purchase ${invoice.purchaseNumber}` : ''}${reason ? ` (${reason})` : ''}`,
      createdBy: user,
    },
    session
  );
  if (invoice) {
    invoice.paidAmountCents -= payment.amountCents;
    invoice.balanceCents += payment.amountCents;
    await invoice.save({ session });
  }
  payment.status = 'REVERSED';
  payment.reversedAt = new Date();
  payment.reversalReason = reason;
  await payment.save({ session });
  return payment;
}

// Cancels a whole supplier payment receipt (BPAY): every part of it still
// standing is reversed and its money returned to the account.
export async function cancelBulkPayment(session, bulkId, { reason = '', user }) {
  const bulk = await BulkPurchasePayment.findById(bulkId).session(session);
  if (!bulk) throw new ApiError(404, 'Payment not found.');
  if (bulk.status === 'CANCELLED') throw new ApiError(409, `${bulk.bulkNumber} is already cancelled.`);
  const payments = await PurchasePayment.find({ bulkPayment: bulk._id, status: 'POSTED' }).session(session);
  let refundedCents = 0;
  for (const p of payments) {
    await reversePayment(session, p, { reason: reason || `${bulk.bulkNumber} cancelled`, user });
    refundedCents += p.amountCents;
  }
  bulk.status = 'CANCELLED';
  bulk.cancelledAt = new Date();
  bulk.cancelReason = String(reason || '').trim();
  bulk.cancelledByName = user?.name || '';
  await bulk.save({ session });
  return { bulk, refundedCents };
}
