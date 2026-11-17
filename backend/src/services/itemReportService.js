import mongoose from 'mongoose';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import StockEntry from '../models/StockEntry.js';
import Supplier from '../models/Supplier.js';
import Sale from '../models/Sale.js';
import Purchase from '../models/Purchase.js';
import SupplierInvoiceArchive from '../models/SupplierInvoiceArchive.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents } from '../utils/money.js';
import { periodKey } from './itemsSoldService.js';

// One item's story for a period: every unit that came in (from which
// supplier invoice), every unit that went out (to which customer), and the
// day-by-day in / out -- built from the item's own stock history, its
// batches and the sales invoices.

// What a stock movement was, from its type and reference.
function kindOf(e) {
  const ref = String(e.reference || '');
  const delta = (e.quantityAfter ?? 0) - (e.quantityBefore ?? 0);
  if (e.type === 'RECEIPT' || e.type === 'RESTOCK') return 'Received';
  if (e.type === 'NEGATIVE_STOCK') return 'Opening (minus)';
  if (e.type === 'SALE' || (e.type === 'OUT_OF_STOCK' && /^INV-/.test(ref))) return 'Sold';
  if (e.type === 'SALE_REVERSAL') return 'Sale cancelled / edited';
  if (e.type === 'CUSTOMER_RETURN') return 'Customer return';
  if (e.type === 'RECEIPT_DELETED') return 'Supplier invoice deleted';
  if (e.type === 'PURCHASE_VOIDED') return 'Purchase voided';
  if (e.type === 'ADJUSTMENT_UNDONE') return 'Adjustment undone';
  if (e.type === 'MERGE_IN') return 'Merged in';
  if (/ADJUSTMENT|OUT_OF_STOCK/.test(e.type || '') || /^B?ADJ-/.test(ref)) return delta < 0 ? 'Adjustment (out)' : 'Adjustment (in)';
  return delta < 0 ? 'Out' : 'In';
}

export async function getItemReport({ itemId, from, to }) {
  if (!mongoose.isValidObjectId(itemId)) throw new ApiError(400, 'Unknown item.');
  const item = await InventoryItem.findById(itemId).lean();
  if (!item) throw new ApiError(404, 'Item not found.');
  const start = from ? new Date(`${from}T00:00:00`) : new Date(0); // no 'from': everything
  const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw new ApiError(400, 'Choose the days (from and to, YYYY-MM-DD).');

  // Movements in the period, oldest first, and what was there before.
  const all = [...(item.stockEvents || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  const inPeriod = all.filter((e) => new Date(e.at) >= start && new Date(e.at) <= end);
  const before = all.filter((e) => new Date(e.at) < start).pop();
  const opening = before ? before.quantityAfter ?? 0 : inPeriod.length ? inPeriod[0].quantityBefore ?? 0 : item.quantity;

  const movements = inPeriod.map((e) => {
    const change = (e.quantityAfter ?? 0) - (e.quantityBefore ?? 0);
    return { at: e.at, kind: kindOf(e), reference: e.reference || '', in: change > 0 ? change : 0, out: change < 0 ? -change : 0, balance: e.quantityAfter ?? 0 };
  });
  const daysMap = new Map();
  for (const m of movements) {
    const day = periodKey('day', m.at);
    const d = daysMap.get(day) || { day, in: 0, out: 0, closing: 0 };
    d.in += m.in;
    d.out += m.out;
    d.closing = m.balance;
    daysMap.set(day, d);
  }
  const days = [...daysMap.values()].sort((a, b) => (a.day < b.day ? 1 : -1));

  // Where it came in from: each batch received in the period.
  const lots = await InventoryLot.find({ item: item._id, receivedAt: { $gte: start, $lte: end }, originalQuantity: { $gt: 0 } }).sort({ receivedAt: -1 }).lean();
  // The supplier is looked for wherever it was written: the batch, its stock
  // entry, the supplier invoice it came on, its purchase invoice, and last
  // the item's own supplier.
  const receivedRefs = movements.filter((m) => m.kind === 'Received' && m.reference).map((m) => m.reference);
  const entries = await StockEntry.find({ $or: [{ _id: { $in: lots.map((l) => l.stockEntry).filter(Boolean) } }, { stockSerial: { $in: receivedRefs } }] })
    .select('stockSerial externalSerialNumber supplier purchaseInvoice')
    .lean();
  const [archives, purchases] = await Promise.all([
    SupplierInvoiceArchive.find({ stockEntry: { $in: entries.map((e) => e._id) } }).select('stockEntry supplier supplierName serialNumber').lean(),
    Purchase.find({ _id: { $in: [...lots.map((l) => l.purchase), ...entries.map((e) => e.purchaseInvoice)].filter(Boolean) } }).select('supplier supplierName supplierInvoiceNumber').lean(),
  ]);
  const supplierIds = [...lots.map((l) => l.supplier), ...entries.map((e) => e.supplier), item.supplier].filter(Boolean);
  const suppliers = await Supplier.find({ _id: { $in: supplierIds } }).select('name').lean();
  const supplierOf = new Map(suppliers.map((s) => [String(s._id), s.name]));
  const entryOf = new Map(entries.map((e) => [String(e._id), e]));
  const entryBySerial = new Map(entries.map((e) => [e.stockSerial, e]));
  const archiveOf = new Map(archives.map((a) => [String(a.stockEntry), a]));
  const purchaseOf = new Map(purchases.map((p) => [String(p._id), p]));
  const sourceOf = (entry, lot) => {
    const archive = entry ? archiveOf.get(String(entry._id)) : null;
    const purchase = purchaseOf.get(String(lot?.purchase || entry?.purchaseInvoice || ''));
    const name =
      (lot?.supplier && supplierOf.get(String(lot.supplier))) ||
      (entry?.supplier && supplierOf.get(String(entry.supplier))) ||
      archive?.supplierName ||
      purchase?.supplierName ||
      (lot?.isLegacy && item.supplier && supplierOf.get(String(item.supplier))) ||
      '';
    return { supplier: name, supplierInvoice: entry?.externalSerialNumber || archive?.serialNumber || purchase?.supplierInvoiceNumber || '' };
  };
  const receipts = lots.map((l) => {
    const entry = l.stockEntry ? entryOf.get(String(l.stockEntry)) : null;
    const src = sourceOf(entry, l);
    return {
      at: l.receivedAt,
      stockSerial: entry?.stockSerial || l.stockSerial || (l.isLegacy ? 'Stock before batches' : ''),
      supplierInvoice: src.supplierInvoice,
      supplier: src.supplier,
      quantity: l.originalQuantity,
      stillInStock: Math.max(0, l.remainingQuantity || 0),
      unitCost: fromCents(l.unitCostCents),
    };
  });
  // Each "Received" movement says from whom.
  for (const m of movements) {
    if (m.kind !== 'Received') continue;
    const entry = entryBySerial.get(m.reference);
    const src = entry ? sourceOf(entry, lots.find((l) => String(l.stockEntry) === String(entry._id))) : null;
    if (src?.supplier) m.supplier = src.supplier;
    if (src?.supplierInvoice) m.supplierInvoice = src.supplierInvoice;
  }

  // Who took it: every customer's units on invoices in the period (less
  // what they returned), with each invoice.
  const rows = await Sale.aggregate([
    { $match: { status: 'CONFIRMED', createdAt: { $gte: start, $lte: end }, 'items.item': item._id } },
    { $unwind: '$items' },
    { $match: { 'items.item': item._id } },
    { $project: { customer: 1, customerName: 1, receiptNumber: 1, createdAt: 1, quantity: { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] }, amountCents: { $subtract: ['$items.subtotalCents', { $ifNull: ['$items.discountCents', 0] }] } } },
    { $sort: { createdAt: -1 } },
  ]);
  const byCustomer = new Map();
  for (const r of rows) {
    const key = String(r.customer || 'walk-in');
    const c = byCustomer.get(key) || { customer: r.customer || null, name: r.customerName || 'Walk-in', quantity: 0, amountCents: 0, invoices: [] };
    c.quantity += r.quantity;
    c.amountCents += r.amountCents;
    c.invoices.push({ id: r._id, receiptNumber: r.receiptNumber, at: r.createdAt, quantity: r.quantity });
    byCustomer.set(key, c);
  }
  const customers = [...byCustomer.values()].filter((c) => c.quantity > 0 || c.invoices.length).sort((a, b) => b.quantity - a.quantity).map((c) => ({ ...c, amount: fromCents(c.amountCents), amountCents: undefined }));

  const totalIn = movements.reduce((s, m) => s + m.in, 0);
  const totalOut = movements.reduce((s, m) => s + m.out, 0);
  return {
    item: { id: item._id, name: item.name, itemCode: item.itemCode, unit: item.unit || 'pcs', quantity: item.quantity, averageCost: fromCents(item.costPriceCents) },
    from: from ? periodKey('day', start) : periodKey('day', inPeriod[0]?.at || item.createdAt || end),
    to: periodKey('day', end),
    summary: {
      opening,
      received: receipts.reduce((s, r) => s + r.quantity, 0),
      soldToCustomers: customers.reduce((s, c) => s + c.quantity, 0),
      totalIn,
      totalOut,
      closing: opening + totalIn - totalOut,
    },
    receipts,
    customers,
    days,
    movements: movements.reverse(),
  };
}
