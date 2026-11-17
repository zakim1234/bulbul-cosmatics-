import Customer from '../models/Customer.js';
import Supplier from '../models/Supplier.js';
import Purchase from '../models/Purchase.js';
import Sale from '../models/Sale.js';
import Payment from '../models/Payment.js';
import CustomerLedger from '../models/CustomerLedger.js';
import BulkPurchasePayment from '../models/BulkPurchasePayment.js';
import PurchasePayment from '../models/PurchasePayment.js';
import Offset from '../models/Offset.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { outstandingDebt, allocateDebt } from './walletService.js';
import { paySupplier, cancelBulkPayment, OUTSTANDING } from './supplierPaymentService.js';

// What we owe a supplier, net of any credit they hold (cents, 0 or more).
export async function supplierOwedCents(supplierId, session = null) {
  const rows = await Purchase.find({ supplier: supplierId, status: 'completed', balanceCents: { $ne: 0 } }).select('balanceCents').session(session);
  return Math.max(0, rows.reduce((s, p) => s + p.balanceCents, 0));
}

export async function customerOwesCents(customer, session = null) {
  return (await outstandingDebt(customer, session)).totalCents;
}

async function nextNumber(session) {
  const seq = await nextSequence('offset', session);
  return `OFF-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;
}

// Sets off what the customer owes us against what we owe the supplier: the
// smaller of the two comes off both. Runs in the caller's transaction.
export async function createOffset(session, { customerId, supplierId, date, note = '', user }) {
  const customer = await Customer.findById(customerId).session(session);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const supplier = await Supplier.findById(supplierId).session(session);
  if (!supplier) throw new ApiError(404, 'Supplier not found.');

  const debt = await outstandingDebt(customer, session);
  const owesUs = debt.totalCents;
  const weOwe = await supplierOwedCents(supplier._id, session);
  if (owesUs <= 0) throw new ApiError(409, `${customer.name} owes nothing, so there is nothing to set off.`);
  if (weOwe <= 0) throw new ApiError(409, `Nothing is owed to ${supplier.name}, so there is nothing to set off.`);
  const amountCents = Math.min(owesUs, weOwe);
  const number = await nextNumber(session);
  const label = `Offset ${number}`;

  // Customer side: a debt payment with no account (no money moved).
  const allocations = await allocateDebt(debt, amountCents, session);
  const customerBefore = customer.balanceCents;
  customer.balanceCents -= amountCents;
  customer.totalPaidCents += amountCents;
  await customer.save({ session });
  const seq = await nextSequence('payment', session);
  const receiptNumber = `PAY-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;
  const [payment] = await Payment.create(
    [
      {
        receiptNumber,
        customer: customer._id,
        amountCents,
        type: 'debt_payment',
        paymentAccountName: `${label} (supplier ${supplier.name})`,
        allocations,
        previousBalanceCents: customerBefore,
        newBalanceCents: customer.balanceCents,
        notes: `${label}: set off against what we owe ${supplier.name}${note ? ` -- ${note}` : ''}`,
        createdBy: user?._id,
      },
    ],
    { session }
  );
  await CustomerLedger.create(
    [
      {
        customer: customer._id,
        type: 'PAYMENT',
        amountCents: -amountCents,
        payment: payment._id,
        description: `${label}: set off against supplier ${supplier.name} (${allocations.map((a) => a.receiptNumber).join(', ')})`,
        balanceBeforeCents: customerBefore,
        balanceAfterCents: customer.balanceCents,
        createdBy: user?._id,
      },
    ],
    { session }
  );

  // Supplier side: a supplier payment with no account.
  const bulk = await paySupplier(session, {
    supplierId: supplier._id,
    amountCents,
    offsetLabel: `${label} (customer ${customer.name})`,
    paymentDate: date || new Date(),
    note: `${label}: set off against what ${customer.name} owes us${note ? ` -- ${note}` : ''}`,
    user,
  });

  const [doc] = await Offset.create(
    [
      {
        offsetNumber: number,
        customer: customer._id,
        customerName: customer.name,
        supplier: supplier._id,
        supplierName: supplier.name,
        amountCents,
        customerBeforeCents: owesUs,
        customerAfterCents: owesUs - amountCents,
        supplierBeforeCents: weOwe,
        supplierAfterCents: weOwe - amountCents,
        customerPayment: payment._id,
        customerReceipt: receiptNumber,
        supplierPayment: bulk._id,
        supplierReceipt: bulk.bulkNumber,
        date: date || new Date(),
        note: String(note || '').trim(),
        createdBy: user?._id || null,
        createdByName: user?.name || '',
      },
    ],
    { session }
  );
  return doc;
}

// Undoes an offset: the customer owes it again (on the same invoices) and the
// supplier is owed it again.
export async function cancelOffset(session, id, { reason = '', user }) {
  const doc = await Offset.findById(id).session(session);
  if (!doc) throw new ApiError(404, 'Offset not found.');
  if (doc.status === 'CANCELLED') throw new ApiError(409, `${doc.offsetNumber} is already cancelled.`);

  const payment = await Payment.findById(doc.customerPayment).session(session);
  const customer = await Customer.findById(doc.customer).session(session);
  if (payment && payment.status === 'POSTED' && customer) {
    for (const a of payment.allocations) {
      if (!a.sale) continue;
      const sale = await Sale.findById(a.sale).session(session);
      if (sale) {
        sale.outstandingCents += a.amountCents;
        await sale.save({ session });
      }
    }
    const before = customer.balanceCents;
    customer.balanceCents += payment.amountCents;
    customer.totalPaidCents -= payment.amountCents;
    await customer.save({ session });
    payment.status = 'CANCELLED';
    payment.cancelledAt = new Date();
    payment.cancelReason = `${doc.offsetNumber} cancelled${reason ? `: ${reason}` : ''}`;
    payment.cancelledByName = user?.name || '';
    await payment.save({ session });
    await CustomerLedger.create(
      [
        {
          customer: customer._id,
          type: 'PAYMENT_CANCELLED',
          amountCents: payment.amountCents,
          payment: payment._id,
          description: `${doc.offsetNumber} cancelled -- owed again`,
          balanceBeforeCents: before,
          balanceAfterCents: customer.balanceCents,
          createdBy: user?._id,
        },
      ],
      { session }
    );
  }
  if (doc.supplierPayment) {
    const bulk = await BulkPurchasePayment.findById(doc.supplierPayment).session(session);
    if (bulk && bulk.status !== 'CANCELLED') await cancelBulkPayment(session, bulk._id, { reason: `${doc.offsetNumber} cancelled`, user });
  }
  doc.status = 'CANCELLED';
  doc.cancelledAt = new Date();
  doc.cancelReason = String(reason || '').trim();
  await doc.save({ session });
  return doc;
}

export { OUTSTANDING };

// Deletes an offset completely: if still standing it is undone first (the
// customer owes it again, the supplier is owed it again), then the offset
// and its customer receipt / supplier payment records are removed. No
// account is touched -- an offset never moved money.
export async function deleteOffset(session, id, { user }) {
  let doc = await Offset.findById(id).session(session);
  if (!doc) throw new ApiError(404, 'Offset not found.');
  if (doc.status !== 'CANCELLED') doc = await cancelOffset(session, id, { reason: 'Deleted', user });
  if (doc.customerPayment) {
    await CustomerLedger.deleteMany({ payment: doc.customerPayment }, { session });
    await Payment.deleteOne({ _id: doc.customerPayment }, { session });
  }
  if (doc.supplierPayment) {
    await PurchasePayment.deleteMany({ bulkPayment: doc.supplierPayment }, { session });
    await BulkPurchasePayment.deleteOne({ _id: doc.supplierPayment }, { session });
  }
  await Offset.deleteOne({ _id: doc._id }, { session });
  return doc;
}
