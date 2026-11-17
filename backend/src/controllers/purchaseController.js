import mongoose from 'mongoose';
import Purchase from '../models/Purchase.js';
import Supplier from '../models/Supplier.js';
import { userHas } from '../models/User.js';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import Account from '../models/Account.js';
import PurchasePayment from '../models/PurchasePayment.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';
import { resolveDateRange } from '../utils/dateRange.js';
import { logAudit } from '../services/auditService.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { reversePayment } from '../services/supplierPaymentService.js';
import { removePurchase } from '../services/archivePurchaseService.js';
import SupplierInvoiceArchive from '../models/SupplierInvoiceArchive.js';
import { NAME_ORDER, startsWith, codeMatch } from '../utils/regex.js';
import { assertInvoiceNumberFree } from '../services/invoiceNumberService.js';
import { takeBackReceivedUnits } from '../services/stockRevaluationService.js';

// Derived, never persisted: Unpaid/Partial/Paid always reflects the
// authoritative paidAmountCents/totalCostCents pair, so it can never drift
// out of sync with them.
export function paymentStatusOf(p) {
  if (p.paidAmountCents <= 0) return 'Unpaid';
  if (p.paidAmountCents >= p.totalCostCents) return 'Paid';
  return 'Partial';
}

function toDTO(p) {
  return {
    id: p._id,
    purchaseNumber: p.purchaseNumber,
    supplierInvoiceNumber: p.supplierInvoiceNumber,
    sourceArchive: p.sourceArchive || null,
    isOpeningBalance: !!p.isOpeningBalance,
    supplier: p.supplier,
    supplierName: p.supplierName,
    items: p.items.map((i) => ({
      item: i.item,
      name: i.itemName,
      quantity: i.quantity,
      unitCost: fromCents(i.unitCostCents),
      subtotal: fromCents(i.subtotalCents),
    })),
    totalCost: fromCents(p.totalCostCents),
    totalAmount: fromCents(p.totalCostCents),
    paidAmount: fromCents(p.paidAmountCents),
    balance: fromCents(p.balanceCents),
    balanceDue: fromCents(p.balanceCents),
    paymentStatus: paymentStatusOf(p),
    paymentAccount: p.paymentAccount?._id || p.paymentAccount,
    paymentAccountName: p.paymentAccount?.name || '',
    purchaseDate: p.purchaseDate,
    notes: p.notes,
    status: p.status,
    createdAt: p.createdAt,
  };
}

export function paymentToDTO(pay) {
  return {
    id: pay._id,
    paymentNumber: pay.paymentNumber,
    purchase: pay.purchase,
    amount: fromCents(pay.amountCents),
    paymentAccount: pay.paymentAccount?._id || pay.paymentAccount,
    paymentAccountName: pay.paymentAccountName,
    previousBalance: fromCents(pay.previousBalanceCents),
    newBalance: fromCents(pay.newBalanceCents),
    note: pay.note,
    receiptNo: pay.receiptNo || '',
    paymentDate: pay.paymentDate || pay.createdAt,
    bulkPayment: pay.bulkPayment || null,
    editedAt: pay.editedAt || null,
    status: pay.status,
    reversedAt: pay.reversedAt,
    reversalReason: pay.reversalReason,
    createdBy: pay.createdBy,
    createdAt: pay.createdAt,
  };
}

export async function generatePurchaseNumber(session) {
  const seq = await nextSequence('purchase', session);
  const year = new Date().getFullYear();
  return `PUR-${year}-${String(seq).padStart(6, '0')}`;
}

export async function generatePurchasePaymentNumber(session) {
  const seq = await nextSequence('purchasePayment', session);
  const year = new Date().getFullYear();
  return `PPAY-${year}-${String(seq).padStart(6, '0')}`;
}

// A payment's business date: a YYYY-MM-DD from the form (anchored at local
// noon so it never slips a day), not in the future; defaults to now.
export function parsePaymentDate(value) {
  if (!value) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new ApiError(400, 'Enter a valid payment date.');
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'Enter a valid payment date.');
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (date > endOfToday) throw new ApiError(400, 'Payment date cannot be in the future.');
  return date;
}

// POST /api/purchases -- purchase invoices are recorded immediately (there
// is no Draft state for purchases), but payment can now be partial: Amount
// Paid defaults to 0 (Unpaid) and may be anything up to Total Amount. The
// payment account is required only when something is actually being paid
// now. The account is allowed to go negative -- a purchase payment is never
// rejected for insufficient balance, and the full amount always comes from
// the one selected account (never split across accounts or silently pulled
// from another one).
export const createPurchase = asyncHandler(async (req, res) => {
  const { supplierId, supplierInvoiceNumber = '', amount, amountPaid, purchaseAccountId, notes = '' } = req.body;
  // An opening balance is money owed from before, so nothing is paid now.
  const isOpeningBalance = req.body.isOpeningBalance === true;
  if (typeof supplierInvoiceNumber !== 'string') throw new ApiError(400, 'Supplier invoice number must be text.');
  if (String(notes).length > 1000) throw new ApiError(400, 'Notes are too long (1000 characters max).');
  if (isOpeningBalance && !userHas(req.user, 'openingBalances')) throw new ApiError(403, 'You do not have access to supplier opening balances.');
  if (isOpeningBalance && toCents(amountPaid ?? 0) !== 0) throw new ApiError(400, 'An opening balance cannot be paid when it is entered.');
  if (!supplierId) throw new ApiError(400, 'Please select or create a supplier.');
  // An opening balance below zero is money we had paid the supplier ahead
  // (they owe us): it lowers what we owe them.
  if (!Number.isFinite(Number(amount)) || (isOpeningBalance ? toCents(amount) === 0 : toCents(amount) <= 0)) {
    throw new ApiError(400, isOpeningBalance ? 'Opening balance cannot be zero.' : 'Total amount must be greater than zero.');
  }
  const totalCostCents = toCents(amount);
  // amountPaid omitted entirely still means "pay in full now" -- this keeps
  // the existing one-shot-payment call sites (and their tests) working
  // exactly as before; only an explicit amountPaid changes the behavior.
  const paidAmountCents = isOpeningBalance ? 0 : amountPaid === undefined ? totalCostCents : toCents(amountPaid);
  if (!Number.isFinite(Number(amountPaid ?? 0)) || paidAmountCents < 0) throw new ApiError(400, 'Amount paid cannot be negative.');
  if (!isOpeningBalance && paidAmountCents > totalCostCents) throw new ApiError(400, 'Amount paid cannot exceed the total amount.');
  // Money going out with a new invoice is paying the supplier too.
  if (paidAmountCents > 0 && !userHas(req.user, 'paySuppliers')) throw new ApiError(403, 'You do not have permission to pay suppliers.');
  if (req.body.items?.length) throw new ApiError(400, 'Enter physical goods through Stock.');
  // The day the goods/invoice came in (YYYY-MM-DD); today when not given.
  const purchaseDate = req.body.purchaseDate ? parsePaymentDate(req.body.purchaseDate) : new Date();
  const result = await runInTransaction(async (session) => {
    const supplier = await Supplier.findById(supplierId).session(session);
    if (!supplier) throw new ApiError(404, 'Supplier not found.');
    await assertInvoiceNumberFree({ supplierId: supplier._id, number: supplierInvoiceNumber, supplierName: supplier.name, session });
    const balanceCents = totalCostCents - paidAmountCents;
    let account = null;
    if (paidAmountCents > 0) {
      if (!purchaseAccountId) throw new ApiError(400, 'Please select the account this purchase is being paid from.');
      account = await Account.findById(purchaseAccountId).session(session);
      if (!account || !account.isActive) throw new ApiError(400, 'Selected payment account is not available.');
      // Negative balances are allowed for purchase payments: the account is
      // debited for the full amount regardless of its current balance.
    }

    const purchaseNumber = await generatePurchaseNumber(session);

    const [purchase] = await Purchase.create(
      [
        {
          purchaseNumber,
          supplierInvoiceNumber: supplierInvoiceNumber.trim(),
          supplier: supplier._id,
          supplierName: supplier.name,
          items: [],
          totalCostCents,
          paidAmountCents,
          balanceCents,
          paymentAccount: account?._id || null,
          purchaseDate,
          notes: String(notes).trim(),
          isOpeningBalance,
          createdBy: req.user?._id,
        },
      ],
      { session }
    );

    if (account && paidAmountCents > 0) {
      const txn = await postImmediateTransaction(
        {
          account,
          direction: 'OUT',
          type: 'PURCHASE_PAYMENT',
          amountCents: paidAmountCents,
          referenceType: 'Purchase',
          referenceId: purchase._id,
          description: `Purchase invoice ${purchaseNumber} (${supplier.name})`,
          createdBy: req.user,
        },
        session
      );
      purchase.accountTransaction = txn?._id || null;
      await purchase.save({ session });

      const paymentNumber = await generatePurchasePaymentNumber(session);
      await PurchasePayment.create(
        [
          {
            paymentNumber,
            purchase: purchase._id,
            amountCents: paidAmountCents,
            paymentAccount: account._id,
            paymentAccountName: account.name,
            accountTransaction: txn?._id || null,
            previousBalanceCents: totalCostCents,
            newBalanceCents: balanceCents,
            note: 'Initial payment at purchase creation',
            createdBy: req.user?._id,
          },
        ],
        { session }
      );
    }

    supplier.totalSpentCents += totalCostCents;
    await supplier.save({ session });

    return purchase;
  });

  await logAudit({
    user: req.user,
    action: isOpeningBalance ? 'purchase.opening_balance' : 'purchase.create',
    entityType: 'Purchase',
    entityId: result._id,
    details: { purchaseNumber: result.purchaseNumber, totalCost: fromCents(result.totalCostCents) },
  });

  res.status(201).json({ success: true, data: toDTO(result) });
});

const normalizeName = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

// GET /api/purchases/opening-balances/sheet -- every supplier opening balance
// as a sheet row, so they can all be seen and corrected at once.
// Every supplier is a row: its opening balance (blank when it has none --
// typing one adds it) and what it is owed now across all its invoices.
export const getOpeningBalancesSheet = asyncHandler(async (req, res) => {
  const [suppliers, openings, purchases] = await Promise.all([
    Supplier.find().collation(NAME_ORDER).sort({ name: 1 }).select('name').lean(),
    Purchase.find({ isOpeningBalance: true, status: { $ne: 'voided' } }).select('supplier totalCostCents paidAmountCents').lean(),
    Purchase.find({ status: { $ne: 'voided' } }).select('supplier balanceCents').lean(),
  ]);
  const opening = new Map(openings.map((p) => [String(p.supplier), p]));
  const owed = new Map();
  for (const p of purchases) owed.set(String(p.supplier), (owed.get(String(p.supplier)) || 0) + (p.balanceCents || 0));
  res.json({
    success: true,
    data: suppliers.map((s) => {
      const o = opening.get(String(s._id));
      return {
        // An opening balance is edited by its invoice; a supplier without one
        // gets one added when an amount is typed.
        id: o ? String(o._id) : `sup:${s._id}`,
        supplierName: s.name,
        amount: o ? fromCents(o.totalCostCents) : '',
        owed: fromCents(owed.get(String(s._id)) || 0),
      };
    }),
  });
});

// The supplier opening balances sheet: new rows (no id) add what we owed a
// supplier -- one not in the system yet is created; existing rows (id) get
// the amount typed in (never below what has been paid on it). All or
// nothing. A supplier listed twice, or a new row for a supplier that already
// has an opening balance, is refused, and a new row sent again because the
// answer to the first send was lost (same importKey) is skipped -- nothing
// is ever owed twice.
export const createOpeningBalancesBulk = asyncHandler(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new ApiError(400, 'Send between 1 and 500 suppliers at a time.');
  const purchaseDate = req.body.purchaseDate ? parsePaymentDate(req.body.purchaseDate) : new Date();
  const clean = rows.map((r, i) => {
    const name = String(r?.supplierName || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new ApiError(400, `Row ${i + 1}: enter the supplier's name.`);
    if (name.length > 200) throw new ApiError(400, `Row ${i + 1}: the name is too long.`);
    // Below zero: we had paid this supplier ahead, so they owe us.
    if (!Number.isFinite(Number(r.amount)) || toCents(r.amount) === 0) throw new ApiError(400, `Row ${i + 1} (${name}): enter the opening balance (it cannot be zero; use minus when the supplier owes you).`);
    if (r.key !== undefined && (typeof r.key !== 'string' || r.key.length > 64)) throw new ApiError(400, `Row ${i + 1}: invalid row key.`);
    // "sup:<id>" is a listed supplier with no opening balance yet: an add.
    const id = r.id == null || String(r.id).startsWith('sup:') ? null : String(r.id);
    if (id && !mongoose.isValidObjectId(id)) throw new ApiError(400, `Row ${i + 1}: invalid opening balance.`);
    return { row: i + 1, id, key: r.key || null, name, normalized: normalizeName(name), cents: toCents(r.amount) };
  });
  const edits = clean.filter((c) => c.id);
  if (edits.length && !(req.user?.isSuperAdmin || ['admin', 'manager'].includes(req.user?.role))) throw new ApiError(403, 'Only an admin or manager can change an opening balance.');

  const done = new Set(
    (await Purchase.find({ importKey: { $in: clean.filter((c) => !c.id).map((c) => c.key).filter(Boolean) } }).select('importKey')).map((p) => p.importKey)
  );
  const fresh = clean.filter((c) => c.id || !c.key || !done.has(c.key));
  const adds = fresh.filter((c) => !c.id);
  const inSheet = new Map();
  for (const c of fresh) {
    if (inSheet.has(c.normalized)) throw new ApiError(400, `Rows ${inSheet.get(c.normalized)} and ${c.row} are both "${c.name}". Put the whole amount on one row.`);
    inSheet.set(c.normalized, c.row);
  }

  const created = await runInTransaction(async (session) => {
    const suppliers = new Map((await Supplier.find().session(session)).map((s) => [normalizeName(s.name), s]));
    const existing = await Purchase.find({ isOpeningBalance: true, status: { $ne: 'voided' }, supplier: { $in: [...suppliers.values()].map((s) => s._id) } }).select('supplier purchaseNumber').session(session);
    const hasOpening = new Map(existing.map((p) => [String(p.supplier), p.purchaseNumber]));
    const clash = adds.filter((c) => suppliers.has(c.normalized) && hasOpening.has(String(suppliers.get(c.normalized)._id)));
    if (clash.length) {
      const list = clash.slice(0, 5).map((c) => `${suppliers.get(c.normalized).name} (${hasOpening.get(String(suppliers.get(c.normalized)._id))})`).join(', ');
      throw new ApiError(409, `Already has an opening balance: ${list}${clash.length > 5 ? ` and ${clash.length - 5} more` : ''}. Change the amount on that supplier's own row instead of adding a new one.`);
    }
    let updated = 0;
    const openings = new Map((await Purchase.find({ _id: { $in: edits.map((c) => c.id) } }).session(session)).map((p) => [String(p._id), p]));
    for (const c of edits) {
      const purchase = openings.get(c.id);
      if (!purchase || !purchase.isOpeningBalance || purchase.status === 'voided') throw new ApiError(404, `Row ${c.row} (${c.name}): this opening balance no longer exists.`);
      if (purchase.totalCostCents === c.cents) continue;
      if (purchase.paidAmountCents > 0 && c.cents < purchase.paidAmountCents) throw new ApiError(400, `Row ${c.row} (${purchase.supplierName}): ${fromCents(purchase.paidAmountCents).toFixed(2)} is already paid, so the balance cannot be less than that.`);
      const supplier = await Supplier.findById(purchase.supplier).session(session);
      if (supplier) {
        supplier.totalSpentCents += c.cents - purchase.totalCostCents;
        await supplier.save({ session });
      }
      purchase.totalCostCents = c.cents;
      purchase.balanceCents = c.cents - purchase.paidAmountCents;
      await purchase.save({ session });
      updated += 1;
    }
    let newSuppliers = 0;
    for (const c of adds) {
      let supplier = suppliers.get(c.normalized);
      if (!supplier) {
        supplier = await new Supplier({ name: c.name }).save({ session });
        suppliers.set(c.normalized, supplier);
        newSuppliers += 1;
      }
      const purchaseNumber = await generatePurchaseNumber(session);
      await new Purchase({
        purchaseNumber,
        supplier: supplier._id,
        supplierName: supplier.name,
        items: [],
        totalCostCents: c.cents,
        paidAmountCents: 0,
        balanceCents: c.cents,
        purchaseDate,
        isOpeningBalance: true,
        importKey: c.key || undefined,
        createdBy: req.user?._id,
      }).save({ session });
      supplier.totalSpentCents += c.cents;
      await supplier.save({ session });
    }
    return { newSuppliers, updated };
  });

  if (fresh.length) await logAudit({ user: req.user, action: 'purchase.opening_balance_bulk', entityType: 'Purchase', details: { created: adds.length, updated: created.updated, newSuppliers: created.newSuppliers } });
  res.status(201).json({ success: true, data: { created: adds.length, updated: created.updated, newSuppliers: created.newSuppliers, skipped: clean.length - fresh.length } });
});

// GET /api/purchases/suppliers-summary -- one line per supplier we have
// bought from: how many invoices, total bought, paid and still owed
// (voided invoices are left out of the money and counted apart).
export const listSupplierSummary = asyncHandler(async (req, res) => {
  const rows = await Purchase.aggregate([
    {
      $group: {
        _id: '$supplier',
        name: { $last: '$supplierName' },
        invoiceCount: { $sum: { $cond: [{ $eq: ['$status', 'voided'] }, 0, 1] } },
        voidedCount: { $sum: { $cond: [{ $eq: ['$status', 'voided'] }, 1, 0] } },
        totalCents: { $sum: { $cond: [{ $eq: ['$status', 'voided'] }, 0, '$totalCostCents'] } },
        paidCents: { $sum: { $cond: [{ $eq: ['$status', 'voided'] }, 0, '$paidAmountCents'] } },
        owedCents: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$balanceCents', 0] } },
        lastPurchaseAt: { $max: '$createdAt' },
      },
    },
    { $sort: { name: 1 } },
  ]);
  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r._id,
      name: r.name,
      invoiceCount: r.invoiceCount,
      voidedCount: r.voidedCount,
      total: fromCents(r.totalCents),
      paid: fromCents(r.paidCents),
      owed: fromCents(r.owedCents),
      lastPurchaseAt: r.lastPurchaseAt,
    })),
  });
});

export const listPurchases = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, from, to, range, supplier, status, q, paymentStatus } = req.query;
  const filter = {};
  if (supplier) filter.supplier = supplier;
  if (status) filter.status = status;
  // Search by invoice number (ours or the supplier's) or supplier name.
  if (q && String(q).trim()) {
    const escaped = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { purchaseNumber: codeMatch(escaped) },
      { supplierInvoiceNumber: codeMatch(escaped) },
      { supplierName: startsWith(escaped) },
    ];
  }
  if (paymentStatus === 'Unpaid') filter.paidAmountCents = 0;
  else if (paymentStatus === 'Paid') filter.$expr = { $gte: ['$paidAmountCents', '$totalCostCents'] };
  else if (paymentStatus === 'Partial') filter.$and = [{ paidAmountCents: { $gt: 0 } }, { $expr: { $lt: ['$paidAmountCents', '$totalCostCents'] } }];
  if (range || from || to) {
    const { start, end } = resolveDateRange({ range, from, to });
    filter.createdAt = { $gte: start, $lte: end };
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 20));

  const [items, total] = await Promise.all([
    Purchase.find(filter)
      .populate('paymentAccount', 'name')
      // sort=supplier keeps each supplier's invoices together.
      .sort(req.query.sort === 'supplier' ? { supplierName: 1, supplier: 1, createdAt: -1 } : { createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Purchase.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: items.map(toDTO),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

export const getPurchase = asyncHandler(async (req, res) => {
  const purchase = await Purchase.findById(req.params.id).populate('paymentAccount', 'name');
  if (!purchase) throw new ApiError(404, 'Purchase not found.');
  // The goods on it: an invoice made from a Supplier Invoice shows that
  // invoice's rows (item, quantity, cost) and any discount.
  const dto = toDTO(purchase);
  if (purchase.sourceArchive) {
    const archive = await SupplierInvoiceArchive.findById(purchase.sourceArchive).select('archiveNumber rows discountCents grandTotalCents stockSerial').populate('stockEntry', 'stockSerial').lean();
    if (archive) {
      dto.items = archive.rows.map((r) => ({ item: null, name: r.itemName, quantity: r.quantity, unitCost: fromCents(r.costCents), subtotal: fromCents(r.totalCents) }));
      dto.goodsDiscount = fromCents(archive.discountCents || 0);
      dto.archiveNumber = archive.archiveNumber;
      dto.stockSerial = archive.stockEntry?.stockSerial || null;
    }
  }
  res.json({ success: true, data: dto });
});

// POST /api/purchases/:id/void -- reverses stock increase (does not go below 0)
export const voidPurchase = asyncHandler(async (req, res) => {
  const { reason = '' } = req.body;

  const result = await runInTransaction(async (session) => {
    const purchase = await Purchase.findById(req.params.id).session(session);
    if (!purchase) throw new ApiError(404, 'Purchase not found.');
    if (purchase.status === 'voided') throw new ApiError(409, 'This purchase has already been voided.');

    const lots = await InventoryLot.find({ purchase: purchase._id }).session(session);
    for (const lot of lots) {
      if (lot.remainingQuantity < lot.originalQuantity || lot.reservedQuantity > 0) {
        throw new ApiError(
          409,
          `Cannot void this purchase: some of its stock has already been sold, so the original batch can no longer be fully reversed.`
        );
      }
    }

    // The stock it brought in leaves at what it cost, so the average of the
    // rest goes back to what it was (and the Balance Sheet stays balanced).
    // Its batches say what came in; an old invoice without batches, its lines.
    const received = lots.length
      ? lots.map((l) => ({ item: l.item, quantity: l.originalQuantity, unitCostCents: l.unitCostCents }))
      : purchase.items.map((l) => ({ item: l.item, quantity: l.quantity, unitCostCents: l.unitCostCents }));
    for (const r of received) {
      const item = await InventoryItem.findById(r.item).session(session);
      if (!item) continue;
      if (item.quantity < r.quantity) {
        throw new ApiError(409, `Cannot void: "${item.name}" stock (${item.quantity}) is lower than the purchased quantity (${r.quantity}), likely because some of it was already sold.`);
      }
      await takeBackReceivedUnits(session, { itemId: r.item, quantity: r.quantity, unitCostCents: r.unitCostCents, receivedValueCents: r.quantity * r.unitCostCents, type: 'PURCHASE_VOIDED', reference: purchase.purchaseNumber, user: req.user });
    }

    await InventoryLot.deleteMany({ purchase: purchase._id }).session(session);

    const supplier = await Supplier.findById(purchase.supplier).session(session);
    if (supplier) {
      supplier.totalSpentCents -= purchase.totalCostCents;
      await supplier.save({ session });
    }

    // Refund the money back into the account it was paid from, rather than
    // deleting that account's history.
    if (purchase.paymentAccount && purchase.paidAmountCents > 0) {
      const account = await Account.findById(purchase.paymentAccount).session(session);
      if (account) {
        await postImmediateTransaction(
          {
            account,
            direction: 'IN',
            type: 'REFUND',
            amountCents: purchase.paidAmountCents,
            referenceType: 'Purchase',
            referenceId: purchase._id,
            description: `Refund for voided purchase ${purchase.purchaseNumber}${reason ? ` (${reason})` : ''}`,
            createdBy: req.user,
          },
          session
        );
      }
    }

    // The lump refund above already returns every cent ever paid on this
    // purchase, so no further account movement is needed here -- but mark
    // every payment record as reversed so Payment History never keeps
    // showing POSTED payments against an invoice that no longer exists.
    await PurchasePayment.updateMany(
      { purchase: purchase._id, status: 'POSTED' },
      { $set: { status: 'REVERSED', reversedAt: new Date(), reversalReason: `Purchase voided${reason ? `: ${reason}` : ''}` } },
      { session }
    );

    purchase.status = 'voided';
    purchase.voidedAt = new Date();
    purchase.voidedReason = reason;
    await purchase.save({ session });

    return purchase;
  });

  await logAudit({
    user: req.user,
    action: 'purchase.void',
    entityType: 'Purchase',
    entityId: result._id,
    details: { reason },
  });

  res.json({ success: true, data: toDTO(result) });
});

// PUT /api/purchases/:id -- corrects an invoice's supplier, supplier
// invoice number, total, date and notes (admin/manager, enforced at the
// route). Money already paid is never touched: the total cannot go below
// what has been paid, and the balance / payment status follow the new
// total. The supplier's running "total spent" moves with the invoice.
export const updatePurchase = asyncHandler(async (req, res) => {
  const { supplierId, supplierInvoiceNumber = '', notes = '' } = req.body;
  if (typeof supplierInvoiceNumber !== 'string' || supplierInvoiceNumber.length > 100) throw new ApiError(400, 'Supplier invoice number must be text of at most 100 characters.');
  if (String(notes).length > 1000) throw new ApiError(400, 'Notes are too long (1000 characters max).');
  if (!supplierId) throw new ApiError(400, 'Please select a supplier.');
  if (!Number.isFinite(Number(req.body.amount)) || toCents(req.body.amount) <= 0) throw new ApiError(400, 'Total amount must be greater than zero.');
  const totalCostCents = toCents(req.body.amount);
  const purchaseDate = req.body.purchaseDate ? parsePaymentDate(req.body.purchaseDate) : null;

  const result = await runInTransaction(async (session) => {
    const purchase = await Purchase.findById(req.params.id).session(session);
    if (!purchase) throw new ApiError(404, 'Purchase not found.');
    if (purchase.status === 'voided') throw new ApiError(409, 'A voided purchase cannot be edited.');
    if (totalCostCents < purchase.paidAmountCents) {
      throw new ApiError(400, `Total cannot be less than what has already been paid (${fromCents(purchase.paidAmountCents).toFixed(2)}).`);
    }
    const supplier = await Supplier.findById(supplierId).session(session);
    if (!supplier) throw new ApiError(404, 'Supplier not found.');
    const linkedArchive = await SupplierInvoiceArchive.findOne({ purchase: purchase._id }).select('_id').session(session);
    await assertInvoiceNumberFree({ supplierId: supplier._id, number: supplierInvoiceNumber, supplierName: supplier.name, exceptPurchase: purchase._id, exceptArchive: linkedArchive?._id, session });

    const before = { supplier: purchase.supplierName, supplierInvoiceNumber: purchase.supplierInvoiceNumber, total: fromCents(purchase.totalCostCents) };
    // Keep each supplier's "total spent" in step with the invoice.
    const oldSupplier = String(purchase.supplier) === String(supplier._id) ? supplier : await Supplier.findById(purchase.supplier).session(session);
    if (oldSupplier) {
      oldSupplier.totalSpentCents -= purchase.totalCostCents;
      if (oldSupplier !== supplier) await oldSupplier.save({ session });
    }
    supplier.totalSpentCents += totalCostCents;
    await supplier.save({ session });

    purchase.supplier = supplier._id;
    purchase.supplierName = supplier.name;
    purchase.supplierInvoiceNumber = supplierInvoiceNumber.trim();
    purchase.totalCostCents = totalCostCents;
    purchase.balanceCents = totalCostCents - purchase.paidAmountCents;
    purchase.notes = String(notes).trim();
    if (purchaseDate) purchase.purchaseDate = purchaseDate;
    await purchase.save({ session });
    return { purchase, before };
  });

  await logAudit({
    user: req.user,
    action: 'purchase.edit',
    entityType: 'Purchase',
    entityId: result.purchase._id,
    details: { purchaseNumber: result.purchase.purchaseNumber, before: result.before, after: { supplier: result.purchase.supplierName, supplierInvoiceNumber: result.purchase.supplierInvoiceNumber, total: fromCents(result.purchase.totalCostCents) } },
  });
  res.json({ success: true, data: toDTO(result.purchase) });
});

// DELETE /api/purchases/:id -- permanently removes an invoice
// (admin/manager). Only allowed when no money and no stock depend on it:
// any active payment must be deleted first (that refunds its account), or
// the invoice voided instead. Deleted payment records left on it are
// removed with it; the audit log keeps what was deleted.
export const deletePurchase = asyncHandler(async (req, res) => {
  const result = await runInTransaction(async (session) => {
    const purchase = await Purchase.findById(req.params.id).session(session);
    if (!purchase) throw new ApiError(404, 'Purchase not found.');
    // Its payments are cancelled first: each one's money goes back to the
    // account it came from.
    purchase.refundedCents = await removePurchase(session, purchase, { user: req.user });
    return purchase;
  });

  await logAudit({
    user: req.user,
    action: 'purchase.delete',
    entityType: 'Purchase',
    entityId: result._id,
    details: { purchaseNumber: result.purchaseNumber, supplier: result.supplierName, supplierInvoiceNumber: result.supplierInvoiceNumber, total: fromCents(result.totalCostCents), status: result.status, refunded: fromCents(result.refundedCents || 0) },
  });
  res.json({ success: true, data: { id: result._id, refunded: fromCents(result.refundedCents || 0) } });
});

// POST /api/purchases/:id/payments -- records an additional payment toward
// an Unpaid/Partial purchase's balance. Money leaves the selected Account
// exactly like the initial payment does.
export const addPurchasePayment = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(toCents(amount)) || toCents(amount) <= 0) throw new ApiError(400, 'Amount to pay must be greater than zero.');
  if (!req.body.paymentAccountId) throw new ApiError(400, 'Please select a payment account.');
  const amountCents = toCents(amount);

  const result = await runInTransaction(async (session) => {
    const purchase = await Purchase.findById(req.params.id).session(session);
    if (!purchase) throw new ApiError(404, 'Purchase not found.');
    if (purchase.status === 'voided') throw new ApiError(409, 'This purchase has been voided and can no longer receive payments.');
    if (purchase.balanceCents <= 0) throw new ApiError(409, 'This purchase is already fully paid.');
    if (amountCents > purchase.balanceCents) {
      throw new ApiError(400, `Lacagtu waa ka badan tahay inta hadhay. (Amount exceeds the remaining balance of ${fromCents(purchase.balanceCents).toFixed(2)}.)`);
    }

    const account = await Account.findById(req.body.paymentAccountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'Selected payment account is not available.');

    const previousBalanceCents = purchase.balanceCents;
    purchase.paidAmountCents += amountCents;
    purchase.balanceCents -= amountCents;
    // The invoice's "paid from" account only ever reflects the most recent
    // payment account for display purposes; Payment History (per-payment)
    // is the authoritative record of which account paid what.
    purchase.paymentAccount = account._id;
    await purchase.save({ session });

    const txn = await postImmediateTransaction(
      {
        account,
        direction: 'OUT',
        type: 'PURCHASE_PAYMENT',
        amountCents,
        referenceType: 'Purchase',
        referenceId: purchase._id,
        description: `Payment toward purchase invoice ${purchase.purchaseNumber} (${purchase.supplierName})`,
        createdBy: req.user,
      },
      session
    );

    const paymentNumber = await generatePurchasePaymentNumber(session);
    const [payment] = await PurchasePayment.create(
      [
        {
          paymentNumber,
          purchase: purchase._id,
          amountCents,
          paymentAccount: account._id,
          paymentAccountName: account.name,
          accountTransaction: txn?._id || null,
          previousBalanceCents,
          newBalanceCents: purchase.balanceCents,
          note: req.body.note || '',
          receiptNo: String(req.body.receiptNo || '').trim().slice(0, 60),
          paymentDate: parsePaymentDate(req.body.paymentDate),
          createdBy: req.user?._id,
        },
      ],
      { session }
    );

    return { purchase, payment };
  });

  await logAudit({
    user: req.user,
    action: 'purchase.payment.add',
    entityType: 'Purchase',
    entityId: result.purchase._id,
    details: { amount, paymentNumber: result.payment.paymentNumber },
  });

  res.status(201).json({ success: true, data: { purchase: toDTO(result.purchase), payment: paymentToDTO(result.payment) } });
});

export const listPurchasePayments = asyncHandler(async (req, res) => {
  const purchase = await Purchase.findById(req.params.id);
  if (!purchase) throw new ApiError(404, 'Purchase not found.');
  const payments = await PurchasePayment.find({ purchase: purchase._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: payments.map(paymentToDTO) });
});

// POST /api/purchases/:id/payments/:paymentId/reverse -- reverses ONE
// payment: refunds the account it came from and recalculates the
// purchase's paid/balance/status. Financial data, so this is admin/manager
// only (enforced at the route) and requires the payment still be POSTED.
export const reversePurchasePayment = asyncHandler(async (req, res) => {
  const { reason = '' } = req.body;
  const result = await runInTransaction(async (session) => {
    const purchase = await Purchase.findById(req.params.id).session(session);
    if (!purchase) throw new ApiError(404, 'Purchase not found.');
    const payment = await PurchasePayment.findOne({ _id: req.params.paymentId, purchase: purchase._id }).session(session);
    if (!payment) throw new ApiError(404, 'Payment not found.');
    if (payment.status !== 'POSTED') throw new ApiError(409, 'This payment has already been reversed.');

    await reversePayment(session, payment, { reason, user: req.user, purchase });
    return { purchase, payment };
  });

  await logAudit({
    user: req.user,
    action: 'purchase.payment.reverse',
    entityType: 'Purchase',
    entityId: result.purchase._id,
    details: { paymentNumber: result.payment.paymentNumber, reason },
  });

  res.json({ success: true, data: { purchase: toDTO(result.purchase), payment: paymentToDTO(result.payment) } });
});

export { toDTO as purchaseToDTO };
