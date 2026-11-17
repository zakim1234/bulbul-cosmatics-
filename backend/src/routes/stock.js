import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { runInTransaction } from '../utils/transaction.js';
import { nextSequence } from '../models/Counter.js';
import { toCents } from '../utils/money.js';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import StockEntry from '../models/StockEntry.js';
import Supplier from '../models/Supplier.js';
import { receiveStock, escapeRegex } from '../services/stockReceiptService.js';
const router = Router();
router.use(requireAuth);
router.use(requirePermission('stock'));
router.post('/', asyncHandler(async (req, res) => {
  const { rows, externalSerialNumber = '', supplierId = null, appendTo = null } = req.body;
  // Opening stock from "Import Excel file" (Super Admin): quantities allowed,
  // and their value is counted as Opening stock in equity.
  const opening = req.body.opening === true;
  if (opening && !req.user?.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin imports opening stock.');
  if (typeof externalSerialNumber !== 'string' || externalSerialNumber.length > 100) throw new ApiError(400, 'Shop/supplier serial number must be text of at most 100 characters.');
  // One request holds at most 1000 rows; the Stock page sends longer lists in
  // parts (appendTo), so the person typing never meets a limit.
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new ApiError(400, 'Enter between 1 and 1000 stock rows.');
  if (appendTo !== null && !mongoose.isValidObjectId(appendTo)) throw new ApiError(400, 'Invalid stock entry to add to.');
  for (const [i, row] of rows.entries()) {
    if (!row.itemId && !String(row.name || '').trim()) throw new ApiError(400, `Row ${i + 1}: select or name an item.`);
    // Only the name is needed: quantity, cost and selling price may be left
    // blank (a list of names just adds the items). What is typed must be valid.
    const blank = (v) => v === '' || v == null;
    // A minus quantity (e.g. -10 from QuickBooks: sold ahead of stock) is allowed.
    if (!blank(row.quantity) && !Number.isSafeInteger(Number(row.quantity))) throw new ApiError(400, `Row ${i + 1}: quantity must be a whole number.`);
    for (const key of ['costPrice', 'sellingPrice']) if (!blank(row[key]) && (!Number.isFinite(Number(row[key])) || Number(row[key]) < 0)) throw new ApiError(400, `Row ${i + 1}: enter a valid ${key}.`);
    if (row.expiryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(row.expiryDate) || !Number.isFinite(Date.parse(row.expiryDate)) || new Date(row.expiryDate).toISOString().slice(0, 10) !== row.expiryDate)) throw new ApiError(400, `Row ${i + 1}: expiry is invalid.`);
    if (row.key !== undefined && (typeof row.key !== 'string' || row.key.length > 64)) throw new ApiError(400, `Row ${i + 1}: invalid row key.`);
    // Stock comes in only on a Supplier Invoice (Manual Entry), which also
    // records what is owed for it -- stock added here had nothing against it
    // and put the Balance Sheet out. Here: items and prices only.
    if (!opening && !blank(row.quantity) && Number(row.quantity) !== 0 && process.env.ALLOW_STOCK_PAGE_QUANTITIES !== '1') {
      throw new ApiError(400, `Row ${i + 1}: stock is added from Supplier Invoices → Manual Entry Invoice ("Add to stock"), which also records what is owed to the supplier. Here you can add items and prices only (leave the quantity empty).`);
    }
  }
  // A part sent again because the answer to the first send never arrived:
  // its rows are already in stock, so they are not received a second time.
  const keys = rows.map((r) => r.key).filter(Boolean);
  const already = keys.length ? await StockEntry.find({ 'rows.clientKey': { $in: keys } }).select('_id rows.clientKey') : [];
  const done = new Set(already.flatMap((e) => e.rows.map((r) => r.clientKey)));
  const fresh = rows.filter((r) => !r.key || !done.has(r.key));
  if (!fresh.length) {
    res.status(201).json({ success: true, data: await StockEntry.findById(already[0]._id) });
    return;
  }
  // categoryId is honoured only by the POS quick-create; never from this route.
  const entry = await runInTransaction(async (session) => (await receiveStock(session, { rows: fresh.map(({ categoryId, ...row }) => row), externalSerialNumber, supplierId, user: req.user, appendTo, uniqueNames: true, opening })).entry);
  res.status(201).json({ success: true, data: entry });
}));
router.get('/', asyncHandler(async (req, res) => {
  const q = escapeRegex(String(req.query.q || '').trim());
  const filter = q ? { $or: [{ stockSerial: { $regex: q, $options: 'i' } }, { externalSerialNumber: { $regex: q, $options: 'i' } }, { 'rows.itemName': { $regex: q, $options: 'i' } }] } : {};
  if (req.query.supplier) filter.supplier = req.query.supplier;
  const page = Math.max(1, Number(req.query.page) || 1);
  const data = await StockEntry.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).populate('rows.batch').populate('supplier', 'name phone email address');
  res.json({ success: true, data, total: await StockEntry.countDocuments(filter) });
}));
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await StockEntry.findById(req.params.id).populate('rows.batch').populate('createdBy', 'name').populate('supplier', 'name phone email address');
  if (!data) throw new ApiError(404, 'Stock entry not found.');
  res.json({ success: true, data });
}));
export default router;
