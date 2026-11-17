import { reserveBatches, releaseBatches } from './batchService.js';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import { ApiError } from '../utils/ApiError.js';

// Reserves `quantity` units of an item for a Draft sale. Never touches
// physical `quantity` -- only shrinks what is still available to sell. More
// than is in stock may be sold: the batches give what they have and the item
// goes below zero at Close Day, made up by the next stock received.
export async function reserveStock(itemId, quantity, session) {
  const item = await InventoryItem.findById(itemId).session(session);
  if (!item) throw new ApiError(404, `Product not found (id: ${itemId}).`);
  const allocations = await reserveBatches(item, quantity, session);
  const short = quantity - allocations.reduce((sum, a) => sum + a.quantity, 0);
  if (short > 0) {
    // Never sell ahead of stock while expired units of it are still on hand:
    // that would hide expired medicine behind a sale. They are removed with
    // Stock Adjustment first.
    const [expired] = await InventoryLot.aggregate([{ $match: { item: item._id, remainingQuantity: { $gt: 0 }, expiryDate: { $ne: null, $lt: new Date() } } }, { $group: { _id: null, qty: { $sum: '$remainingQuantity' } } }]).session(session);
    if (expired?.qty > 0) throw new ApiError(409, `"${item.name}": ${expired.qty} unit(s) on hand are expired and cannot be sold. Remove them with Stock Adjustment, then it can be sold even with no stock.`);
  }
  item.reservedQuantity += quantity;
  await item.save({ session });
  return allocations;
}

// Releases a previously reserved quantity (Draft edited down, or cancelled).
export async function releaseReservation(itemId, quantity, session, allocations = []) {
  if (quantity <= 0) return;
  if (!(await InventoryItem.exists({ _id: itemId }).session(session))) return; // item was deleted
  await releaseBatches(allocations, session);
  await InventoryItem.findByIdAndUpdate(
    itemId,
    [{ $set: { reservedQuantity: { $max: [0, { $subtract: ['$reservedQuantity', quantity] }] } } }],
    { session }
  );
}

// Close Day: converts a reservation into a permanent stock deduction.
export async function confirmReservation(itemId, quantity, session, reference = '') {
  const item = await InventoryItem.findById(itemId).session(session);
  if (!item) throw new ApiError(404, `Product not found (id: ${itemId}).`);
  if (item.reservedQuantity < quantity) throw new ApiError(409, 'Stock reservation is inconsistent.');
  item.reservedQuantity -= quantity;
  item.stockEvents.push({ type: item.quantity - quantity <= 0 ? 'OUT_OF_STOCK' : 'SALE', reference, quantityBefore: item.quantity, quantityAfter: item.quantity - quantity });
  item.quantity -= quantity;
  await item.save({ session });
  return item;
}
