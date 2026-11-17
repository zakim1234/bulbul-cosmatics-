import mongoose from 'mongoose';
import { sameNameFilter } from '../utils/regex.js';
import { moveLotToItem } from '../services/lotMoveService.js';
import InventoryItem from '../models/InventoryItem.js';
import { recostReceivedInvoice } from '../services/receiptRecostService.js';
import SupplierInvoiceArchive from '../models/SupplierInvoiceArchive.js';
import Supplier from '../models/Supplier.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { logAudit } from '../services/auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import Purchase from '../models/Purchase.js';
import InventoryLot from '../models/InventoryLot.js';
import StockEntry from '../models/StockEntry.js';
import { userHas } from '../models/User.js';
import { receiveStock } from '../services/stockReceiptService.js';
import { takeBackReceivedUnits } from '../services/stockRevaluationService.js';
import { syncArchivePurchase, removePurchase } from '../services/archivePurchaseService.js';
import { assertInvoiceNumberFree } from '../services/invoiceNumberService.js';
const MAX_INVOICE_ROWS = 40000;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toDTO(doc) {
  return {
    id: doc._id,
    archiveNumber: doc.archiveNumber,
    serialNumber: doc.serialNumber,
    supplier: doc.supplier?._id || doc.supplier,
    supplierName: doc.supplierName,
    rows: doc.rows.map((r) => ({
      itemName: r.itemName,
      quantity: r.quantity,
      cost: fromCents(r.costCents),
      total: fromCents(r.totalCents),
      sellingPrice: r.sellingPriceCents == null ? null : fromCents(r.sellingPriceCents),
      expiryDate: r.expiryDate || null,
    })),
    subtotal: fromCents(doc.grandTotalCents + (doc.discountCents || 0)),
    discount: fromCents(doc.discountCents || 0),
    grandTotal: fromCents(doc.grandTotalCents),
    notes: doc.notes,
    purchase: doc.purchase?._id || doc.purchase || null,
    purchaseNumber: doc.purchaseNumber || doc.purchase?.purchaseNumber || null,
    stockEntry: doc.stockEntry?._id || doc.stockEntry || null,
    stockSerial: doc.stockSerial || doc.stockEntry?.stockSerial || null,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
  };
}

async function generateArchiveNumber() {
  const seq = await nextSequence('supplierInvoiceArchive');
  const year = new Date().getFullYear();
  return `SINV-${year}-${String(seq).padStart(6, '0')}`;
}

// Validates the fields shared by create and edit and builds the stored
// rows/total. `excludeId` lets an edit keep its own serial number.
async function buildArchiveFields(body, excludeId = null) {
  const { serialNumber, supplierId, rows, notes = '' } = body;
  if (typeof serialNumber !== 'string' || !serialNumber.trim()) throw new ApiError(400, 'Shop/Supplier serial number is required.');
  if (serialNumber.length > 100) throw new ApiError(400, 'Serial number is too long.');
  // No set row limit: the only ceiling is what one database record can hold
  // (about 40,000 rows on one invoice).
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(400, 'Add at least one row.');
  if (rows.length > MAX_INVOICE_ROWS) throw new ApiError(400, `One invoice can hold up to ${MAX_INVOICE_ROWS.toLocaleString()} rows; save the rest as a second invoice.`);
  if (String(notes || '').length > 2000) throw new ApiError(400, 'Notes are too long (2000 characters max).');

  // Backend-enforced uniqueness (frontend validation alone is never
  // sufficient) -- checked up front for a clear message, with the schema's
  // own unique index (see the model) as the race-condition backstop.
  const trimmedSerial = serialNumber.trim();
  let supplier = null;
  if (supplierId) {
    supplier = await Supplier.findById(supplierId);
    if (!supplier) throw new ApiError(404, 'Selected supplier no longer exists.');
  }
  // Unique per supplier: 1155 can belong to Cali and to Cumar, never twice to one.
  const current = excludeId ? await SupplierInvoiceArchive.findById(excludeId).select('purchase') : null;
  await assertInvoiceNumberFree({ supplierId: supplier?._id, number: trimmedSerial, supplierName: supplier?.name, exceptArchive: excludeId, exceptPurchase: current?.purchase });

  let grandTotalCents = 0;
  const builtRows = rows.map((row, i) => {
    const itemName = String(row.itemName || '').trim();
    if (!itemName) throw new ApiError(400, `Row ${i + 1}: item name is required.`);
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new ApiError(400, `Row ${i + 1}: quantity must be a positive number.`);
    if (row.cost === '' || row.cost == null || !Number.isFinite(Number(row.cost)) || Number(row.cost) < 0) {
      throw new ApiError(400, `Row ${i + 1}: enter a valid cost.`);
    }
    const costCents = toCents(row.cost);
    const totalCents = Math.round(quantity * costCents);
    grandTotalCents += totalCents;
    return { itemName, quantity, costCents, totalCents };
  });
  // The supplier's discount on the whole invoice: what is owed is less.
  const discount = body.discount === '' || body.discount == null ? 0 : Number(body.discount);
  if (!Number.isFinite(discount) || discount < 0) throw new ApiError(400, 'Enter a valid discount.');
  const discountCents = toCents(discount);
  if (discountCents > grandTotalCents) throw new ApiError(400, 'The discount cannot be more than the invoice total.');
  grandTotalCents -= discountCents;

  return {
    serialNumber: trimmedSerial,
    supplier: supplier?._id || null,
    supplierName: supplier?.name || '',
    rows: builtRows,
    grandTotalCents,
    discountCents,
    notes: String(notes || ''),
  };
}

const validExpiry = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// With addToStock, every row also needs a whole quantity and a selling price
// (expiry optional): the same rules as the Stock page.
function stockRows(body) {
  return body.rows.map((row, i) => {
    if (!Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity) <= 0) throw new ApiError(400, `Row ${i + 1}: quantity must be a whole number to go into stock.`);
    if (row.sellingPrice === '' || row.sellingPrice == null || !Number.isFinite(Number(row.sellingPrice)) || Number(row.sellingPrice) < 0) throw new ApiError(400, `Row ${i + 1} (${String(row.itemName || '').trim()}): enter the selling price.`);
    if (row.expiryDate && !validExpiry(row.expiryDate)) throw new ApiError(400, `Row ${i + 1}: expiry is invalid.`);
    return { name: String(row.itemName).trim(), quantity: Number(row.quantity), costPrice: Number(row.cost), sellingPrice: Number(row.sellingPrice), expiryDate: row.expiryDate || null };
  });
}

// POST /api/supplier-invoice-archives -- saves the supplier's paper invoice
// exactly as entered. With a supplier it is also a purchase invoice (owed),
// and with addToStock its items are received into stock in the same save:
// an item already in stock gets the quantity added and its average cost
// blended; a new name becomes a new item.
export const createArchive = asyncHandler(async (req, res) => {
  const fields = await buildArchiveFields(req.body);
  const addToStock = req.body.addToStock === true;
  // Stock, or just "Manual Entry: add goods to stock", lets the invoice's items go into stock.
  if (addToStock && !userHas(req.user, 'stock') && !userHas(req.user, 'manualEntryStock')) throw new ApiError(403, 'You do not have permission to add goods to stock from a Manual Entry Invoice.');
  const toReceive = addToStock ? stockRows(req.body) : null;
  if (toReceive) {
    // With a discount, each item goes into stock at what it really cost:
    // its share of the discount off (the paper cost stays on the invoice),
    // so the stock is worth exactly what is owed.
    const subtotalCents = fields.grandTotalCents + fields.discountCents;
    const factor = fields.discountCents && subtotalCents ? fields.grandTotalCents / subtotalCents : 1;
    fields.rows.forEach((r, i) => {
      if (factor !== 1) toReceive[i].costPriceCents = r.costCents * factor;
      r.sellingPriceCents = toCents(toReceive[i].sellingPrice);
      r.expiryDate = toReceive[i].expiryDate ? new Date(`${toReceive[i].expiryDate}T23:59:59.999Z`) : null;
    });
  }
  const archiveNumber = await generateArchiveNumber();
  let archive;
  try {
    // With a supplier, the same save also records the purchase invoice
    // (their serial number, the grand total owed) -- no second entry.
    archive = await runInTransaction(async (session) => {
      const [doc] = await SupplierInvoiceArchive.create([{ archiveNumber, ...fields, createdBy: req.user?._id }], { session });
      const purchase = await syncArchivePurchase(session, doc, { user: req.user });
      if (toReceive) {
        const { entry } = await receiveStock(session, { rows: toReceive, externalSerialNumber: fields.serialNumber, supplierId: fields.supplier, user: req.user });
        // Tied to its purchase invoice: no more rows can be added to the
        // entry, and the invoice can only be voided, never deleted.
        if (purchase) {
          entry.purchaseInvoice = purchase._id;
          await entry.save({ session });
          await InventoryLot.updateMany({ stockEntry: entry._id }, { $set: { purchase: purchase._id } }, { session });
        }
        doc.stockEntry = entry._id;
        doc.stockSerial = entry.stockSerial;
      }
      await doc.save({ session });
      doc.purchaseNumber = purchase?.purchaseNumber || null;
      return doc;
    });
  } catch (err) {
    // Race-condition backstop: two concurrent saves for the same serial can
    // both pass the pre-check above -- the schema's unique index (once
    // built, see runMigrateSupplierArchive.js) catches that case here.
    if (err?.code === 11000) throw new ApiError(409, `Invoice number "${fields.serialNumber}" is already saved${fields.supplierName ? ` for ${fields.supplierName}` : ''}.`);
    throw err;
  }

  if (archive.stockEntry) await logAudit({ user: req.user, action: 'supplierInvoiceArchive.toStock', entityType: 'SupplierInvoiceArchive', entityId: archive._id, details: { archiveNumber: archive.archiveNumber, stockSerial: archive.stockSerial, rows: archive.rows.length } });
  res.status(201).json({ success: true, data: toDTO(archive) });
});

// Stock was received from this invoice: its items, quantities, costs and
// supplier are in stock now, so they stay as they are.
async function assertStockUnchanged(archive, fields, bodyRows = []) {
  if (!archive.stockEntry) return;
  const entry = await StockEntry.findById(archive.stockEntry).select('stockSerial');
  const same =
    String(archive.supplier || '') === String(fields.supplier || '') &&
    archive.rows.length === fields.rows.length &&
    archive.rows.every((r, i) => r.quantity === fields.rows[i].quantity);
  if (!same) throw new ApiError(409, `This invoice was received into stock (${entry?.stockSerial || 'stock entry'}), so its supplier and quantities cannot change (item names, costs and the discount can). Correct the quantity with Stock Adjustment.`);
  fields.rows.forEach((r, i) => {
    // A new selling price may be typed; otherwise it stays.
    const typed = bodyRows[i]?.sellingPrice;
    const valid = typed !== '' && typed != null && Number.isFinite(Number(typed)) && Number(typed) >= 0;
    r.sellingPriceCents = valid ? toCents(typed) : archive.rows[i].sellingPriceCents;
    r.expiryDate = archive.rows[i].expiryDate;
  });
}

// PUT /api/supplier-invoice-archives/:id -- corrects an archived invoice
// (serial, supplier, rows, notes). Like create, it touches nothing but this
// archive record, so editing it can never change Stock or Accounts.
export const updateArchive = asyncHandler(async (req, res) => {
  const archive = await SupplierInvoiceArchive.findById(req.params.id);
  if (!archive) throw new ApiError(404, 'Supplier invoice archive not found.');
  const fields = await buildArchiveFields(req.body, archive._id);
  await assertStockUnchanged(archive, fields, Array.isArray(req.body.rows) ? req.body.rows : []);
  try {
    await runInTransaction(async (session) => {
      const doc = await SupplierInvoiceArchive.findById(archive._id).session(session);
      // Received into stock and a cost or the discount corrected: the stock
      // (and profit on what was sold) follows the invoice -- see the service.
      const recost = doc.stockEntry && ((doc.discountCents || 0) !== fields.discountCents || doc.rows.some((r, i) => r.costCents !== fields.rows[i].costCents));
      Object.assign(doc, fields);
      // An item name corrected: that row's units go to the item of that name
      // (made if there is none), at their own cost -- the stock is worth the same.
      if (doc.stockEntry) {
        const entry = await StockEntry.findById(doc.stockEntry).select('rows').session(session);
        for (let i = 0; i < fields.rows.length; i += 1) {
          if (fields.rows[i].itemName === archive.rows[i]?.itemName) continue;
          const lotId = entry?.rows[i]?.batch;
          if (!lotId) throw new ApiError(409, `Row ${i + 1}: this row has no stock batch to move.`);
          let target = await InventoryItem.findOne(sameNameFilter(fields.rows[i].itemName)).session(session);
          if (!target) {
            const made = await receiveStock(session, { rows: [{ name: fields.rows[i].itemName, quantity: 0, costPrice: fromCents(fields.rows[i].costCents), sellingPrice: fromCents(fields.rows[i].sellingPriceCents ?? archive.rows[i].sellingPriceCents ?? 0) }], user: req.user });
            target = made.items[0];
          }
          if (String(target._id) === String(entry.rows[i].item)) continue;
          await moveLotToItem(session, { lotId, toItemId: target._id, user: req.user });
        }
      }
      // A selling price changed: the item sells at it from now on.
      if (doc.stockEntry) {
        const entry = await StockEntry.findById(doc.stockEntry).select('rows.item').session(session);
        for (let i = 0; i < fields.rows.length; i += 1) {
          const itemId = entry?.rows[i]?.item;
          const cents = fields.rows[i].sellingPriceCents;
          if (itemId && cents != null && cents !== archive.rows[i]?.sellingPriceCents) await InventoryItem.updateOne({ _id: itemId }, { $set: { sellingPriceCents: cents } }, { session });
        }
      }
      if (recost) {
        const subtotalCents = fields.grandTotalCents + fields.discountCents;
        const factor = fields.discountCents && subtotalCents ? fields.grandTotalCents / subtotalCents : 1;
        await recostReceivedInvoice(session, { entryId: doc.stockEntry, rows: fields.rows, factor, reference: doc.archiveNumber, user: req.user });
      }
      const purchase = await syncArchivePurchase(session, doc, { user: req.user });
      if (doc.stockEntry) await StockEntry.updateOne({ _id: doc.stockEntry }, { $set: { externalSerialNumber: fields.serialNumber } }, { session });
      await doc.save({ session });
      Object.assign(archive, fields, { purchase: doc.purchase, purchaseNumber: purchase?.purchaseNumber || null });
    });
  } catch (err) {
    if (err?.code === 11000) throw new ApiError(409, `Invoice number "${fields.serialNumber}" is already saved${fields.supplierName ? ` for ${fields.supplierName}` : ''}.`);
    throw err;
  }
  await logAudit({
    user: req.user,
    action: 'supplierInvoiceArchive.update',
    entityType: 'SupplierInvoiceArchive',
    entityId: archive._id,
    details: { archiveNumber: archive.archiveNumber, serialNumber: archive.serialNumber },
  });
  res.json({ success: true, data: toDTO(archive) });
});

// DELETE /api/supplier-invoice-archives/:id -- removes an archived invoice;
// the audit log keeps a record of what was removed. If it was received into
// stock, that receipt is taken back out: whatever of it is still on the
// shelf leaves Inventory, its batches and stock entry are deleted. What was
// already sold stays sold (those sales and reports do not change).
export const deleteArchive = asyncHandler(async (req, res) => {
  const archive = await SupplierInvoiceArchive.findById(req.params.id);
  if (!archive) throw new ApiError(404, 'Supplier invoice archive not found.');
  // Its purchase invoice goes too (any payment on it is cancelled and the
  // money returned to the account).
  let refundedCents = 0;
  let unitsRemoved = 0;
  await runInTransaction(async (session) => {
    refundedCents = 0;
    unitsRemoved = 0;
    if (archive.stockEntry) {
      const lots = await InventoryLot.find({ stockEntry: archive.stockEntry }).session(session);
      // What is still on the shelf leaves at what it cost (the average of the
      // rest goes back to what it was); what was already sold stays sold and
      // its cost is booked back as a gain -- see takeBackReceivedUnits.
      for (const lot of lots) {
        const left = Math.max(0, lot.remainingQuantity || 0);
        await takeBackReceivedUnits(session, { itemId: lot.item, quantity: left, unitCostCents: lot.unitCostCents, receivedValueCents: lot.originalQuantity * lot.unitCostCents, type: 'RECEIPT_DELETED', reference: archive.archiveNumber, user: req.user });
        unitsRemoved += left;
      }
      await InventoryLot.deleteMany({ stockEntry: archive.stockEntry }, { session });
      await StockEntry.deleteOne({ _id: archive.stockEntry }, { session });
    }
    const purchase = archive.purchase ? await Purchase.findById(archive.purchase).session(session) : null;
    if (purchase) refundedCents = await removePurchase(session, purchase, { user: req.user, reason: `supplier invoice ${archive.archiveNumber} deleted` });
    await SupplierInvoiceArchive.deleteOne({ _id: archive._id }, { session });
  });
  await logAudit({
    user: req.user,
    action: 'supplierInvoiceArchive.delete',
    entityType: 'SupplierInvoiceArchive',
    entityId: archive._id,
    details: { archiveNumber: archive.archiveNumber, serialNumber: archive.serialNumber, supplierName: archive.supplierName, grandTotal: fromCents(archive.grandTotalCents), stockSerial: archive.stockSerial || null, unitsRemovedFromStock: unitsRemoved },
  });
  res.json({ success: true, data: { id: archive._id, refunded: fromCents(refundedCents), unitsRemoved } });
});

// GET /api/supplier-invoice-archives?q=...&serial=...&supplier=... -- with
// no filter at all, returns every archive (paginated, newest first) so the
// default page can behave like a file browser. `q` is a general live-search
// box matching either the Shop/Supplier Serial Number or the supplier name
// (never today's Inventory prices); `serial`/`supplier` (id) remain as
// narrower filters for backward compatibility with existing call sites.
export const searchArchives = asyncHandler(async (req, res) => {
  const filter = {};
  const q = String(req.query.q || '').trim();
  const serial = String(req.query.serial || '').trim();
  if (q) {
    const escaped = escapeRegex(q);
    filter.$or = [{ serialNumber: { $regex: escaped, $options: 'i' } }, { supplierName: { $regex: escaped, $options: 'i' } }];
  } else if (serial) {
    filter.serialNumber = { $regex: escapeRegex(serial), $options: 'i' };
  }
  // 'none': the invoices saved without a supplier.
  if (req.query.supplier === 'none') filter.supplier = null;
  else if (req.query.supplier) {
    if (!mongoose.isValidObjectId(req.query.supplier)) throw new ApiError(400, 'Unknown supplier.');
    filter.supplier = req.query.supplier;
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const [rows, total] = await Promise.all([
    SupplierInvoiceArchive.find(filter).populate('purchase', 'purchaseNumber').populate('stockEntry', 'stockSerial').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    SupplierInvoiceArchive.countDocuments(filter),
  ]);
  res.json({ success: true, data: rows.map(toDTO), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// GET /api/supplier-invoice-archives/by-supplier -- one folder per supplier:
// how many invoices, their total and the latest date (newest first).
export const archivesBySupplier = asyncHandler(async (req, res) => {
  const rows = await SupplierInvoiceArchive.aggregate([
    { $group: { _id: '$supplier', name: { $last: '$supplierName' }, count: { $sum: 1 }, totalCents: { $sum: '$grandTotalCents' }, lastAt: { $max: '$createdAt' } } },
    { $sort: { lastAt: -1 } },
  ]);
  res.json({ success: true, data: rows.map((r) => ({ supplier: r._id ? String(r._id) : 'none', name: r._id ? r.name || '(supplier)' : '(no supplier)', count: r.count, total: fromCents(r.totalCents), lastAt: r.lastAt })) });
});

export const getArchive = asyncHandler(async (req, res) => {
  const archive = await SupplierInvoiceArchive.findById(req.params.id).populate('stockEntry', 'stockSerial');
  if (!archive) throw new ApiError(404, 'Supplier invoice archive not found.');
  res.json({ success: true, data: toDTO(archive) });
});

// POST /api/supplier-invoice-archives/:id/to-purchase -- for an archive saved
// before archives were added to Purchase Invoices automatically: records
// its purchase invoice (serial number, grand total owed) now, once.
export const sendArchiveToPurchases = asyncHandler(async (req, res) => {
  const result = await runInTransaction(async (session) => {
    const doc = await SupplierInvoiceArchive.findById(req.params.id).session(session);
    if (!doc) throw new ApiError(404, 'Supplier invoice archive not found.');
    if (!doc.supplier) throw new ApiError(400, 'Choose the supplier on this invoice first (Edit), then add it to Purchase Invoices.');
    if (doc.purchase && (await Purchase.exists({ _id: doc.purchase }).session(session))) throw new ApiError(409, 'This invoice is already in Purchase Invoices.');
    doc.purchase = null;
    const purchase = await syncArchivePurchase(session, doc, { user: req.user });
    await doc.save({ session });
    doc.purchaseNumber = purchase?.purchaseNumber || null;
    return doc;
  });
  await logAudit({ user: req.user, action: 'supplierInvoiceArchive.toPurchase', entityType: 'SupplierInvoiceArchive', entityId: result._id, details: { archiveNumber: result.archiveNumber, purchaseNumber: result.purchaseNumber } });
  res.json({ success: true, data: toDTO(result) });
});
