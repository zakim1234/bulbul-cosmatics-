import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import StockEntry from '../models/StockEntry.js';
import Customer from '../models/Customer.js';
import CustomerLedger from '../models/CustomerLedger.js';
import CustomerWalletTransaction from '../models/CustomerWalletTransaction.js';
import Purchase from '../models/Purchase.js';
import Account from '../models/Account.js';
import Supplier from '../models/Supplier.js';
import AccountTransaction from '../models/AccountTransaction.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { runInTransaction } from '../utils/transaction.js';
import { logAudit } from '../services/auditService.js';
import { removePurchase } from '../services/archivePurchaseService.js';
import Sale from '../models/Sale.js';
import Payment from '../models/Payment.js';
import Expense from '../models/Expense.js';
import StockAdjustment from '../models/StockAdjustment.js';
import StockRevaluation from '../models/StockRevaluation.js';
import SalarySheet from '../models/SalarySheet.js';
import CommissionPayment from '../models/CommissionPayment.js';
import Liability from '../models/Liability.js';

// "Clear" buttons on Inventory, Customers and Purchase Invoices: delete every
// record of that kind in the open branch, for good. Super Admin only, when
// switched on in Settings, with
// the word DELETE typed to confirm, and only inside a branch the Super Admin
// actually opened (never the all-branches view, which would otherwise fall
// back to the first branch). Sales already made keep their own copy of the
// item and customer names, so old invoices and reports still read right.

const CONFIRM_WORD = 'DELETE';

function checkClear(req) {
  if (!req.user?.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin can clear all records.');
  const on = req.branchId
    ? (req.user.bulkToolsBranches || []).map(String).includes(String(req.branchId))
    : req.user.showBulkTools;
  if (!on) throw new ApiError(403, req.branchId ? 'Clear All is switched off for this branch. Switch it on in Settings first.' : 'Clear All is switched off. Switch it on in Settings first.');
  if (String(req.body?.confirm || '').trim().toUpperCase() !== CONFIRM_WORD) throw new ApiError(400, `Type ${CONFIRM_WORD} to confirm.`);
  if (req.branchId && String(req.headers['x-branch-id'] || '') !== String(req.branchId)) {
    throw new ApiError(400, 'Open the branch you want to clear first (not the all-branches view).');
  }
}

// POST /api/inventory/clear { confirm: 'DELETE' } -- every item, its stock
// batches and stock receipts.
export const clearInventory = asyncHandler(async (req, res) => {
  checkClear(req);
  const result = await runInTransaction(async (session) => {
    const lots = await InventoryLot.deleteMany({}, { session });
    const entries = await StockEntry.deleteMany({}, { session });
    const items = await InventoryItem.deleteMany({}, { session });
    return { items: items.deletedCount, batches: lots.deletedCount, stockEntries: entries.deletedCount };
  });
  await logAudit({ user: req.user, action: 'inventory.clear_all', entityType: 'InventoryItem', details: result });
  res.json({ success: true, data: result });
});

// POST /api/customers/clear { confirm: 'DELETE' } -- every customer with
// their debt ledger and wallet history.
export const clearCustomers = asyncHandler(async (req, res) => {
  checkClear(req);
  const result = await runInTransaction(async (session) => {
    const ledger = await CustomerLedger.deleteMany({}, { session });
    const wallet = await CustomerWalletTransaction.deleteMany({}, { session });
    const customers = await Customer.deleteMany({}, { session });
    return { customers: customers.deletedCount, ledgerEntries: ledger.deletedCount, walletEntries: wallet.deletedCount };
  });
  await logAudit({ user: req.user, action: 'customer.clear_all', entityType: 'Customer', details: result });
  res.json({ success: true, data: result });
});

// POST /api/accounts/clear { confirm: 'DELETE' } -- every account's money
// history is deleted and every balance (opening and current) goes back to
// 0. The accounts themselves stay, so payments can still be taken into them.
export const clearAccounts = asyncHandler(async (req, res) => {
  checkClear(req);
  const result = await runInTransaction(async (session) => {
    const txns = await AccountTransaction.deleteMany({}, { session });
    const accounts = await Account.updateMany({}, { $set: { openingBalanceCents: 0, currentBalanceCents: 0 } }, { session });
    return { transactions: txns.deletedCount, accounts: accounts.modifiedCount };
  });
  await logAudit({ user: req.user, action: 'account.clear_all', entityType: 'Account', details: result });
  res.json({ success: true, data: result });
});

// POST /api/reports/clear { confirm: 'DELETE' } -- everything the profit
// reports are made of, in the open branch: sales invoices (with their
// returns), customer payments and refunds, expenses (salary sheets and
// commissions with them) and stock adjustments. Net Income starts again
// from 0. What they did elsewhere is put back so nothing is left half:
//  - accounts lose exactly the money those records moved (the rest stays);
//  - customers lose the debt and wallet movements of those records; their
//    opening balances and plain wallet deposits/withdrawals stay.
// Items, stock quantities, customers, suppliers, purchases and Close Day
// history are not touched.
export const clearReports = asyncHandler(async (req, res) => {
  checkClear(req);
  if (req.branchId === 'all') throw new ApiError(400, 'Open the branch you want to clear first (not the all-branches view).');
  const result = await runInTransaction(async (session) => {
    const ids = (docs) => docs.map((d) => d._id);
    const sales = await Sale.find({}).select('_id').session(session).lean();
    const payments = await Payment.find({}).select('_id accountTransaction').session(session).lean();
    const expenses = await Expense.find({}).select('_id accountTransaction').session(session).lean();
    // Wallet money spent on an invoice or refunded from one; plain deposits
    // and withdrawals are the customer's own and stay.
    const walletTxns = await CustomerWalletTransaction.find({ $or: [{ sale: { $ne: null } }, { type: { $in: ['SALE_PAYMENT', 'REFUND'] } }] })
      .select('_id customer amountCents accountTransaction')
      .session(session)
      .lean();
    const saleIds = ids(sales);
    const paymentIds = ids(payments);

    // The account movements those records made.
    // Expenses charged to Liabilities: their lines go too, and the money
    // paid on them comes back (their payments are account movements).
    const linked = await Liability.find({ expense: { $in: ids(expenses) } }).select('_id payments').session(session).lean();
    const refIds = [...saleIds, ...paymentIds, ...ids(expenses), ...ids(walletTxns)];
    const txnIds = [...payments, ...expenses, ...walletTxns, ...linked.flatMap((l) => l.payments)].map((d) => d.accountTransaction).filter(Boolean);
    const txns = await AccountTransaction.find({ $or: [{ _id: { $in: txnIds } }, { referenceType: { $in: ['Sale', 'Payment', 'Expense', 'CustomerWalletTransaction'] }, referenceId: { $in: refIds } }] })
      .select('_id account status direction amountCents')
      .session(session)
      .lean();
    const byAccount = new Map();
    for (const t of txns) {
      if (t.status !== 'POSTED') continue; // pending/reversed never moved the balance
      const k = String(t.account);
      byAccount.set(k, (byAccount.get(k) || 0) + (t.direction === 'IN' ? t.amountCents : -t.amountCents));
    }
    for (const [account, cents] of byAccount) if (cents) await Account.updateOne({ _id: account }, { $inc: { currentBalanceCents: -cents } }, { session });
    await AccountTransaction.deleteMany({ _id: { $in: ids(txns) } }, { session });
    await Liability.deleteMany({ _id: { $in: ids(linked) } }, { session });

    // Customer debt: every ledger line of an invoice or payment goes; the
    // opening balance (ADJUSTMENT) stays.
    const ledger = await CustomerLedger.find({ $or: [{ sale: { $in: saleIds } }, { payment: { $in: paymentIds } }, { type: { $ne: 'ADJUSTMENT' } }] })
      .select('_id customer amountCents')
      .session(session)
      .lean();
    const debt = new Map();
    for (const l of ledger) debt.set(String(l.customer), (debt.get(String(l.customer)) || 0) + l.amountCents);
    for (const [customer, cents] of debt) if (cents) await Customer.updateOne({ _id: customer }, { $inc: { balanceCents: -cents } }, { session });
    await CustomerLedger.deleteMany({ _id: { $in: ids(ledger) } }, { session });

    const wallet = new Map();
    for (const w of walletTxns) wallet.set(String(w.customer), (wallet.get(String(w.customer)) || 0) + w.amountCents);
    for (const [customer, cents] of wallet) {
      const c = await Customer.findById(customer).select('walletBalanceCents').session(session).lean();
      if (c && cents) await Customer.updateOne({ _id: customer }, { $set: { walletBalanceCents: Math.max(0, c.walletBalanceCents - cents) } }, { session });
    }
    await CustomerWalletTransaction.deleteMany({ _id: { $in: ids(walletTxns) } }, { session });
    await Customer.updateMany({}, { $set: { totalPurchasedCents: 0, totalPaidCents: 0 } }, { session });

    const removed = {
      sales: (await Sale.deleteMany({ _id: { $in: saleIds } }, { session })).deletedCount,
      payments: (await Payment.deleteMany({ _id: { $in: paymentIds } }, { session })).deletedCount,
      expenses: (await Expense.deleteMany({}, { session })).deletedCount,
      salarySheets: (await SalarySheet.deleteMany({}, { session })).deletedCount,
      commissions: (await CommissionPayment.deleteMany({}, { session })).deletedCount,
      stockAdjustments: (await StockAdjustment.deleteMany({}, { session })).deletedCount,
      stockRevaluations: (await StockRevaluation.deleteMany({}, { session })).deletedCount,
      accountTransactions: txns.length,
    };
    return removed;
  });
  await logAudit({ user: req.user, action: 'reports.clear_all', entityType: 'Sale', details: result });
  res.json({ success: true, data: result });
});

// POST /api/purchases/clear { confirm: 'DELETE' } -- every purchase invoice,
// deleted the same way as the Delete button: its payments are cancelled
// (the money goes back to the account it was paid from) and the supplier's
// totals follow. Stock already received stays in Inventory; it is only no
// longer linked to the invoice. One invoice at a time, so a problem with
// one does not stop the rest -- those are reported back.
async function removeAllPurchases(user) {
  const ids = (await Purchase.find({}).select('_id').lean()).map((p) => p._id);
  let deleted = 0;
  let refundedCents = 0;
  const failed = [];
  for (const id of ids) {
    try {
      // Counted after the transaction commits (it may run its body again).
      const refunded = await runInTransaction(async (session) => {
        const purchase = await Purchase.findById(id).session(session);
        if (!purchase) return null;
        await InventoryLot.updateMany({ purchase: id }, { $set: { purchase: null } }, { session });
        await StockEntry.updateMany({ purchaseInvoice: id }, { $set: { purchaseInvoice: null } }, { session });
        return removePurchase(session, purchase, { user, reason: 'all purchase invoices cleared' });
      });
      if (refunded != null) {
        deleted += 1;
        refundedCents += refunded;
      }
    } catch (err) {
      failed.push({ id: String(id), message: err.message });
    }
  }
  return { deleted, refundedCents, failed };
}

export const clearPurchases = asyncHandler(async (req, res) => {
  checkClear(req);
  const { deleted, refundedCents, failed } = await removeAllPurchases(req.user);
  const result = { purchases: deleted, refunded: refundedCents / 100, failed: failed.length };
  await logAudit({ user: req.user, action: 'purchase.clear_all', entityType: 'Purchase', details: { ...result, failures: failed.slice(0, 20) } });
  res.json({ success: true, data: { ...result, failures: failed.slice(0, 20) } });
});

// POST /api/suppliers/clear { confirm: 'DELETE' } -- every supplier, with
// every purchase invoice first (deleted as Clear All on Purchase Invoices
// does: payments cancelled, money back to its account). Items, stock and
// supplier invoices that named a supplier keep the rest of their data; they
// just no longer point at one (supplier invoices keep the supplier's name). A supplier whose invoice could not be
// deleted stays.
export const clearSuppliers = asyncHandler(async (req, res) => {
  checkClear(req);
  const { deleted, refundedCents, failed } = await removeAllPurchases(req.user);
  const keep = await Purchase.distinct('supplier');
  const result = await runInTransaction(async (session) => {
    const gone = (await Supplier.find({ _id: { $nin: keep } }).select('_id').session(session).lean()).map((s) => s._id);
    if (gone.length) {
      await InventoryItem.updateMany({ supplier: { $in: gone } }, { $set: { supplier: null } }, { session });
      await InventoryLot.updateMany({ supplier: { $in: gone } }, { $set: { supplier: null } }, { session });
      await StockEntry.updateMany({ supplier: { $in: gone } }, { $set: { supplier: null } }, { session });
    }
    const removed = await Supplier.deleteMany({ _id: { $in: gone } }, { session });
    return { suppliers: removed.deletedCount };
  });
  const data = { ...result, purchases: deleted, refunded: refundedCents / 100, failed: failed.length, failures: failed.slice(0, 20) };
  await logAudit({ user: req.user, action: 'supplier.clear_all', entityType: 'Supplier', details: data });
  res.json({ success: true, data });
});
