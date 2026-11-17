import mongoose from 'mongoose';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import StockEntry from '../models/StockEntry.js';
import Supplier from '../models/Supplier.js';
import Category from '../models/Category.js';
import { nextSequence, nextSequenceBlock } from '../models/Counter.js';
import { currentBranch } from './branchContext.js';
import { calculateWeightedAverageCost } from './costingService.js';
import StockRevaluation from '../models/StockRevaluation.js';
import { stockValueGap } from './stockRevaluationService.js';
import { ApiError } from '../utils/ApiError.js';
import { toCents } from '../utils/money.js';
import { sameNameFilter } from '../utils/regex.js';

export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Receives stock (Stock IN) inside the caller's transaction: creates one
// StockEntry, one InventoryLot per row, blends the Weighted Average Cost, and
// creates any item that does not exist yet (matched by exact name,
// case-insensitive). This is the single implementation behind both the Stock
// page and the POS quick-create, so the WAC/lot/serial rules cannot drift.
//
// rows: [{ itemId? | name, quantity, costPrice, sellingPrice, expiryDate?, categoryId? }]
// `categoryId` is only applied when the row creates a brand-new item.
// `appendTo`: a long list is sent in parts; every part after the first adds
// its rows to the entry the first part created (same serial and supplier).
// `uniqueNames`: the Stock page. A typed name is a new item, so a name that is
// already saved, or typed twice, is refused; picking the item (itemId) still
// receives more of it. Checked here, inside the transaction, so two people
// saving the same new name at once cannot both get through.
// One Stock Serial is one database record, and a record can hold about
// 40,000 rows; a longer list carries on under the next serial by itself, so
// the person saving never meets a limit.
export const MAX_ENTRY_ROWS = 40000;

export async function receiveStock(session, { rows, externalSerialNumber = '', supplierId = null, user, appendTo = null, uniqueNames = false, opening = false }) {
  let supplier = null;
  let entry;
  if (appendTo) {
    entry = await StockEntry.findById(appendTo).session(session);
    if (!entry) throw new ApiError(404, 'The stock entry being added to no longer exists.');
    if (String(entry.createdBy) !== String(user._id) || Date.now() - entry.createdAt > 12 * 3600 * 1000) throw new ApiError(400, 'Only your own stock entry from today can be added to.');
    if (entry.purchaseInvoice) throw new ApiError(400, `${entry.stockSerial} already has a supplier invoice and cannot take more rows.`);
    if (!!entry.opening !== !!opening) throw new ApiError(400, `${entry.stockSerial} is ${entry.opening ? 'opening stock' : 'not opening stock'}: start a new stock entry.`);
    if (entry.rows.length + rows.length > MAX_ENTRY_ROWS) throw new ApiError(400, `${entry.stockSerial} is full (${MAX_ENTRY_ROWS} rows at most).`);
    if (entry.supplier) supplier = await Supplier.findById(entry.supplier).session(session);
  } else {
    if (supplierId) {
      supplier = await Supplier.findById(supplierId).session(session);
      if (!supplier) throw new ApiError(404, 'Selected supplier no longer exists.');
    }
    // This shared counter also serializes concurrent inline item creation.
    const seq = await nextSequence('stockEntry', session);
    const serial = `STK-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;
    entry = new StockEntry({ stockSerial: serial, externalSerialNumber: externalSerialNumber.trim(), supplier: supplier?._id || null, createdBy: user._id, rows: [], opening: !!opening });
  }
  const stockSerial = entry.stockSerial;
  const touched = [];

  // Everything is read and written in a few batched calls (not several per
  // row), so a list of a thousand rows still saves in seconds.
  const items = await findItems(session, rows);
  if (uniqueNames) {
    const typed = new Set();
    for (const row of rows) {
      if (row.itemId) continue;
      const key = normalName(row.name);
      const existing = items.byName.get(key);
      if (existing) throw new ApiError(409, `"${existing.name}" is already saved. Pick it from the list to receive more of it.`);
      if (typed.has(key)) throw new ApiError(409, `"${String(row.name).trim()}" is on the list twice. A name can only be saved once.`);
      typed.add(key);
    }
  }
  const lots = [];
  const revaluations = [];
  const changed = new Set();
  const newNames = [...new Set(rows.filter((r) => !r.itemId && !items.byName.has(normalName(r.name))).map((r) => normalName(r.name)))];
  let code = newNames.length ? await nextSequenceBlock('itemCode', newNames.length, session) : 0;

  for (const row of rows) {
    const name = String(row.name || '').trim().replace(/\s+/g, ' ');
    let item = row.itemId ? items.byId.get(String(row.itemId)) : items.byName.get(normalName(name));
    if (!item && row.itemId) throw new ApiError(404, 'Selected item no longer exists.');
    if (!item) {
      let category = null;
      if (row.categoryId) {
        category = (await Category.findById(row.categoryId).session(session))?._id;
        if (!category) throw new ApiError(400, 'Selected category no longer exists.');
      }
      code += 1;
      item = new InventoryItem({ name, itemCode: `ITM-${String(code).padStart(6, '0')}`, quantity: 0, category, branch: currentBranch() });
      items.byName.set(normalName(name), item);
    }

    // What is left blank keeps what the item already has (0 for a new item),
    // so a blank cost never pulls an average down and a blank price never wipes one.
    const given = (value) => value !== '' && value != null;
    const quantity = given(row.quantity) ? Number(row.quantity) : 0;
    // costPriceCents: an exact cost already worked out (a supplier invoice's
    // discount shared over its items), kept as it is.
    const costPriceCents = row.costPriceCents != null ? Number(row.costPriceCents) : given(row.costPrice) ? toCents(row.costPrice) : item.costPriceCents;
    const sellingPriceCents = given(row.sellingPrice) ? toCents(row.sellingPrice) : item.sellingPriceCents;
    // No quantity: only the item is added (or its selling price updated). No
    // batch, no stock movement, and its average cost stays unless it is new.
    if (quantity === 0) {
      if (item.isNew) item.costPriceCents = costPriceCents;
      item.sellingPriceCents = sellingPriceCents;
      if (supplier && !item.supplier) item.supplier = supplier._id;
      if (item.isNew || item.isModified()) changed.add(item);
      entry.rows.push({ item: item._id, itemName: item.name, batch: null, quantity: 0, costPriceCents, sellingPriceCents, expiryDate: null, ...(row.key ? { clientKey: String(row.key) } : {}) });
      touched.push(item);
      continue;
    }
    // A minus quantity (e.g. -10 brought over from QuickBooks): the item is
    // short by that many -- as if sold ahead of stock. No batch is made and
    // its average cost is not touched; the next receipt makes the units up.
    if (quantity < 0) {
      if (item.isNew) item.costPriceCents = costPriceCents;
      item.sellingPriceCents = sellingPriceCents;
      if (supplier && !item.supplier) item.supplier = supplier._id;
      item.stockEvents.push({ type: 'NEGATIVE_STOCK', reference: stockSerial, quantityBefore: item.quantity, quantityAfter: item.quantity + quantity });
      item.quantity += quantity;
      changed.add(item);
      entry.rows.push({ item: item._id, itemName: item.name, batch: null, quantity, costPriceCents, sellingPriceCents, expiryDate: null, ...(row.key ? { clientKey: String(row.key) } : {}) });
      touched.push(item);
      continue;
    }
    const expiryDate = row.expiryDate ? new Date(`${row.expiryDate}T23:59:59.999Z`) : null;
    // Units sold ahead of stock (quantity below zero) are made up first: the
    // batch keeps only what is left over (-200 + 300 received leaves 100).
    const owedUnits = Math.max(0, -item.quantity);
    const batch = { _id: new mongoose.Types.ObjectId(), item: item._id, stockEntry: entry._id, stockSerial, supplier: supplier?._id || item.supplier || null, unitCostCents: costPriceCents, sellingPriceCents, expiryDate, originalQuantity: quantity, remainingQuantity: quantity - Math.min(quantity, owedUnits) };
    lots.push(batch);
    // WAC recalculated here, inside this transaction, from the item's
    // CURRENT quantity/average -- never from a value read earlier or
    // computed on the frontend. If another request receives stock for the
    // same item concurrently, runInTransaction's session.withTransaction
    // retries this whole callback on write conflict, so this always blends
    // against the latest committed state (no lost update).
    const oldQuantity = item.quantity;
    const oldAverageCostCents = item.costPriceCents;
    const newAverageCostCents = calculateWeightedAverageCost({
      oldQuantity,
      oldAverageCostCents,
      incomingQuantity: quantity,
      incomingUnitCostCents: costPriceCents,
    });
    item.stockEvents.push({
      type: item.quantity === 0 ? 'RESTOCK' : 'RECEIPT',
      reference: stockSerial,
      quantityBefore: item.quantity,
      quantityAfter: item.quantity + quantity,
      averageCostBeforeCents: oldAverageCostCents,
      averageCostAfterCents: newAverageCostCents,
    });
    const gapCents = stockValueGap({ oldQuantity, oldCostCents: oldAverageCostCents, newQuantity: oldQuantity + quantity, newCostCents: newAverageCostCents, incomingQuantity: quantity, incomingUnitCostCents: costPriceCents });
    if (gapCents) revaluations.push({ item: item._id, itemName: item.name, quantity, oldCostCents: oldAverageCostCents, newCostCents: newAverageCostCents, changeCents: gapCents, reason: `${stockSerial}: units sold ahead of stock`, createdBy: user?._id || null, createdByName: user?.name || '' });
    item.quantity += quantity;
    item.sellingPriceCents = sellingPriceCents;
    item.costPriceCents = newAverageCostCents;
    if (supplier && !item.supplier) item.supplier = supplier._id;
    changed.add(item);
    entry.rows.push({ item: item._id, itemName: item.name, batch: batch._id, quantity, costPriceCents, sellingPriceCents, expiryDate, ...(row.key ? { clientKey: String(row.key) } : {}) });
    touched.push(item);
  }
  await InventoryLot.insertMany([...items.legacyLots, ...lots], { session });
  if (revaluations.length) await StockRevaluation.insertMany(revaluations, { session });
  const docs = [...changed];
  for (const doc of docs) await doc.validate();
  await InventoryItem.bulkSave(docs, { session });
  await entry.save({ session });
  return { entry, items: touched };
}

const normalName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

// The items the rows go to, read in one go: by id, and by name (same name,
// any case or spacing). Items whose quantity is more than their tracked
// batches also get the legacy batch ensureLegacyLots would add (returned in
// legacyLots, inserted with the new batches).
async function findItems(session, rows) {
  const byId = new Map();
  const byName = new Map();
  const ids = [...new Set(rows.filter((r) => r.itemId).map((r) => String(r.itemId)))];
  const names = [...new Set(rows.filter((r) => !r.itemId).map((r) => normalName(r.name)))];
  for (const item of ids.length ? await InventoryItem.find({ _id: { $in: ids } }).session(session) : []) byId.set(String(item._id), item);

  let matched = [];
  if (names.length <= 20) {
    // A few names (the POS quick-create, a short entry): one lookup each.
    for (const name of names) {
      const item = await InventoryItem.findOne(sameNameFilter(name)).session(session);
      if (item) matched.push(item);
    }
  } else {
    // Many names: read every item's name once and match here.
    const wanted = new Set(names);
    const hits = (await InventoryItem.find().select('name').session(session).lean()).filter((i) => wanted.has(normalName(i.name)));
    matched = hits.length ? await InventoryItem.find({ _id: { $in: hits.map((i) => i._id) } }).session(session) : [];
  }
  for (const item of matched) {
    const key = normalName(item.name);
    if (!byName.has(key)) byName.set(key, byId.get(String(item._id)) || item);
  }

  // One item object per id, wherever it was found.
  for (const [key, item] of byName) if (byId.has(String(item._id))) byName.set(key, byId.get(String(item._id)));
  const existing = new Map([...byId.values(), ...byName.values()].map((i) => [String(i._id), i]));
  const tracked = existing.size
    ? new Map((await InventoryLot.aggregate([{ $match: { item: { $in: [...existing.values()].map((i) => i._id) } } }, { $group: { _id: '$item', qty: { $sum: '$remainingQuantity' } } }]).session(session)).map((t) => [String(t._id), t.qty]))
    : new Map();
  const legacyLots = [];
  for (const item of existing.values()) {
    const missing = item.quantity - (tracked.get(String(item._id)) || 0);
    if (missing > 0) legacyLots.push({ item: item._id, supplier: item.supplier, originalQuantity: missing, remainingQuantity: missing, unitCostCents: item.costPriceCents, sellingPriceCents: item.sellingPriceCents, expiryDate: item.expiryDate, receivedAt: item.createdAt, isLegacy: true });
  }
  return { byId, byName, legacyLots };
}
