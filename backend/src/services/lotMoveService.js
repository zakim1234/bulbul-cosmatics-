import mongoose from 'mongoose';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import StockEntry from '../models/StockEntry.js';
import SupplierInvoiceArchive from '../models/SupplierInvoiceArchive.js';
import { ApiError } from '../utils/ApiError.js';
import { calculateWeightedAverageCost } from './costingService.js';
import { takeBackReceivedUnits, bookStockValueGap } from './stockRevaluationService.js';

// A batch put on the wrong item (e.g. 30 tablets received under, or merged
// into, the wrong name): what is left of it moves to the right item, at its
// own cost, with its supplier and expiry. The wrong item's average goes back
// to what it was without them; the right item's average blends them in. The
// stock is worth the same, so the Balance Sheet does not move. Units of the
// batch already sold stay sold under the item they were sold as.
export async function moveLotToItem(session, { lotId, toItemId, user }) {
  if (!mongoose.isValidObjectId(lotId) || !mongoose.isValidObjectId(toItemId)) throw new ApiError(400, 'Choose the item to move the batch to.');
  const lot = await InventoryLot.findById(lotId).session(session);
  if (!lot) throw new ApiError(404, 'Batch not found.');
  if (String(lot.item) === String(toItemId)) throw new ApiError(400, 'The batch is already on this item.');
  const [from, into] = await Promise.all([InventoryItem.findById(lot.item).session(session), InventoryItem.findById(toItemId).session(session)]);
  if (!from || !into) throw new ApiError(404, 'Item not found.');
  if ((lot.reservedQuantity || 0) > 0) throw new ApiError(409, 'Part of this batch is held by a pending invoice. Finish or cancel it first.');
  const quantity = Math.max(0, lot.remainingQuantity || 0);
  if (!quantity) throw new ApiError(409, 'Nothing of this batch is left to move.');
  const reference = lot.stockSerial || 'batch';

  // Out of the wrong item, at the batch's own cost.
  await takeBackReceivedUnits(session, { itemId: from._id, quantity, unitCostCents: lot.unitCostCents, receivedValueCents: quantity * lot.unitCostCents, type: 'BATCH_MOVED_OUT', reference: `${reference} → ${into.name}`, user });

  // Into the right item, blended at the same cost.
  const target = await InventoryItem.findById(into._id).session(session);
  const oldQuantity = target.quantity;
  const oldCostCents = target.costPriceCents;
  const newCostCents = calculateWeightedAverageCost({ oldQuantity, oldAverageCostCents: oldCostCents, incomingQuantity: quantity, incomingUnitCostCents: lot.unitCostCents });
  await bookStockValueGap(session, target, { oldQuantity, oldCostCents, newQuantity: oldQuantity + quantity, newCostCents, incomingQuantity: quantity, incomingUnitCostCents: lot.unitCostCents }, { reason: `${reference} moved from ${from.name}`, user });
  target.stockEvents.push({ type: 'BATCH_MOVED_IN', reference: `${reference} ← ${from.name}`, quantityBefore: oldQuantity, quantityAfter: oldQuantity + quantity, averageCostBeforeCents: oldCostCents, averageCostAfterCents: newCostCents });
  target.quantity = oldQuantity + quantity;
  target.costPriceCents = newCostCents;
  if (!target.supplier && lot.supplier) target.supplier = lot.supplier;
  await target.save({ session });

  const whole = (lot.originalQuantity || 0) === quantity;
  if (whole) {
    // Nothing of it was sold: the batch itself, its stock entry row and its
    // supplier invoice row now name the right item.
    lot.item = target._id;
    await lot.save({ session });
    if (lot.stockEntry) {
      const entry = await StockEntry.findById(lot.stockEntry).session(session);
      const i = entry ? entry.rows.findIndex((r) => String(r.batch) === String(lot._id)) : -1;
      if (i >= 0) {
        entry.rows[i].item = target._id;
        entry.rows[i].itemName = target.name;
        entry.markModified('rows');
        await entry.save({ session });
        await SupplierInvoiceArchive.updateOne({ stockEntry: entry._id }, { $set: { [`rows.${i}.itemName`]: target.name } }, { session });
      }
    }
  } else {
    // Part was sold under the wrong item: that part stays; the rest becomes
    // its own batch on the right item.
    lot.remainingQuantity = 0;
    lot.originalQuantity -= quantity;
    await lot.save({ session });
    await InventoryLot.create([{ item: target._id, stockEntry: lot.stockEntry, stockSerial: lot.stockSerial, supplier: lot.supplier, purchase: lot.purchase, unitCostCents: lot.unitCostCents, sellingPriceCents: lot.sellingPriceCents, originalQuantity: quantity, remainingQuantity: quantity, expiryDate: lot.expiryDate, receivedAt: lot.receivedAt }], { session });
  }
  return { quantity, from: from.name, into: target.name };
}
