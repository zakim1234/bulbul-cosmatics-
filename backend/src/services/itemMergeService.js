import mongoose from 'mongoose';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import Sale from '../models/Sale.js';
import Quotation from '../models/Quotation.js';
import Purchase from '../models/Purchase.js';
import StockEntry from '../models/StockEntry.js';
import StockAdjustment from '../models/StockAdjustment.js';
import StockRevaluation from '../models/StockRevaluation.js';
import DayClose from '../models/DayClose.js';
import { ApiError } from '../utils/ApiError.js';
import { compareBatches } from './batchService.js';

// Two items that are really one (e.g. "RAT" made by mistake for "RAT KILL
// (BOX)"): everything of `fromId` moves onto `intoId`, then `fromId` is
// removed. Its stock and batches join the other's, the average cost is the
// two stocks' value over the new quantity (so the stock is worth exactly
// what it was -- the Balance Sheet does not move), and every invoice,
// quotation, purchase, stock entry, adjustment and Close Day line that named
// it now names the item it was merged into.
export async function mergeItems(session, { fromId, intoId, user }) {
  if (!mongoose.isValidObjectId(fromId) || !mongoose.isValidObjectId(intoId)) throw new ApiError(400, 'Choose the item to merge into.');
  if (String(fromId) === String(intoId)) throw new ApiError(400, 'Choose a different item to merge into.');
  const [from, into] = await Promise.all([InventoryItem.findById(fromId).session(session), InventoryItem.findById(intoId).session(session)]);
  if (!from || !into) throw new ApiError(404, 'Item not found.');
  if ((from.reservedQuantity || 0) > 0) throw new ApiError(409, `${from.name} is held by a pending invoice. Finish or cancel that invoice first.`);

  // Stock: the two quantities and their value added together.
  const valueCents = from.quantity * from.costPriceCents + into.quantity * into.costPriceCents;
  const quantityBefore = into.quantity;
  const costBefore = into.costPriceCents;
  const quantity = from.quantity + into.quantity;
  if (quantity > 0 && valueCents >= 0) into.costPriceCents = valueCents / quantity;
  else if (into.quantity <= 0 && from.quantity > 0) into.costPriceCents = from.costPriceCents;
  into.quantity = quantity;
  // A value the merged stock cannot hold (e.g. it ends at or below zero) is
  // booked as a gain or loss, so nothing is lost from the Balance Sheet.
  const gapCents = quantity * into.costPriceCents - valueCents;
  if (!into.sellingPriceCents && from.sellingPriceCents) into.sellingPriceCents = from.sellingPriceCents;
  if (!into.supplier && from.supplier) into.supplier = from.supplier;
  into.stockEvents.push({ type: 'MERGE_IN', reference: `${from.name} (${from.itemCode})`, quantityBefore, quantityAfter: quantity, averageCostBeforeCents: costBefore, averageCostAfterCents: into.costPriceCents });
  await into.save({ session });

  // Its batches join the other's. Units the other had sold ahead of stock
  // (below zero) are made up from them first, oldest first -- just as a new
  // receipt would -- so the batches match the quantity.
  await InventoryLot.updateMany({ item: from._id }, { $set: { item: into._id } }, { session });
  const lots = (await InventoryLot.find({ item: into._id, remainingQuantity: { $gt: 0 } }).session(session)).sort(compareBatches);
  let extra = lots.reduce((s, l) => s + l.remainingQuantity, 0) - Math.max(0, quantity);
  for (const lot of lots) {
    if (extra <= 0) break;
    const take = Math.min(extra, lot.remainingQuantity - (lot.reservedQuantity || 0));
    if (take <= 0) continue;
    lot.remainingQuantity -= take;
    await lot.save({ session });
    extra -= take;
  }

  // Every document that named it now names the item it was merged into.
  const line = (path) => [{ [`${path}.item`]: from._id }, { $set: { [`${path}.$[l].item`]: into._id, [`${path}.$[l].itemName`]: into.name } }, { arrayFilters: [{ 'l.item': from._id }], session }];
  await Promise.all([
    Sale.updateMany(...line('items')),
    Sale.updateMany({ 'returns.items.item': from._id }, { $set: { 'returns.$[].items.$[l].item': into._id, 'returns.$[].items.$[l].itemName': into.name } }, { arrayFilters: [{ 'l.item': from._id }], session }),
    Quotation.updateMany(...line('items')),
    Purchase.updateMany(...line('items')),
    StockEntry.updateMany(...line('rows')),
    DayClose.updateMany(...line('itemsSold')),
    StockAdjustment.updateMany({ item: from._id }, { $set: { item: into._id, itemName: into.name } }, { session }),
    StockRevaluation.updateMany({ item: from._id }, { $set: { item: into._id, itemName: into.name } }, { session }),
  ]);
  if (Math.abs(gapCents) > 1e-6) {
    await StockRevaluation.create([{ item: into._id, itemName: into.name, quantity: from.quantity, oldCostCents: costBefore, newCostCents: into.costPriceCents, changeCents: gapCents, reason: `${from.name} merged into ${into.name}`, createdBy: user?._id || null, createdByName: user?.name || '' }], { session });
  }
  await from.deleteOne({ session });
  return { from: { id: from._id, name: from.name, quantity: from.quantity }, into };
}
