import InventoryItem from '../models/InventoryItem.js';
import StockRevaluation from '../models/StockRevaluation.js';

// Units came in (a receipt, a sale undone, a customer return) at
// incomingUnitCostCents each, so the stock should now be worth exactly that
// much more. When the item was below zero (sold ahead of stock), the average
// starts again from the new cost and the stock's worth moves by a different
// amount: the units sold ahead were charged at the old cost. That
// difference is booked as a gain or loss, so the Balance Sheet stays balanced.
export function stockValueGap({ oldQuantity, oldCostCents, newQuantity, newCostCents, incomingQuantity, incomingUnitCostCents }) {
  const gap = newQuantity * newCostCents - oldQuantity * oldCostCents - incomingQuantity * incomingUnitCostCents;
  return Math.abs(gap) > 1e-6 ? gap : 0;
}

export async function bookStockValueGap(session, item, values, { reason, user }) {
  const changeCents = stockValueGap(values);
  if (!changeCents) return 0;
  await StockRevaluation.create(
    [{ item: item._id, itemName: item.name, quantity: values.incomingQuantity, oldCostCents: values.oldCostCents, newCostCents: values.newCostCents, changeCents, reason, createdBy: user?._id || null, createdByName: user?.name || '' }],
    { session }
  );
  return changeCents;
}

// Takes back units that came in on a receipt now being undone (a supplier
// invoice deleted, a purchase voided). The units leave at what they cost
// (unitCostCents), so the average cost of the rest is worked back to what it
// was before they came in.
//
// `receivedValueCents` is what the receipt added to stock when it came in
// (its quantity x cost). Whatever of that is not taken back here (units
// already sold, or stock that cannot hold the value any more) is booked as
// a gain or loss in Profit & Loss, so the Balance Sheet stays balanced.
export async function takeBackReceivedUnits(session, { itemId, quantity, unitCostCents, receivedValueCents, type, reference, user }) {
  const item = await InventoryItem.findById(itemId).session(session);
  if (!item) return { removed: 0 };
  const before = item.quantity;
  const oldCostCents = item.costPriceCents;
  const valueBeforeCents = before * oldCostCents;
  const after = before - quantity;
  const wantedValueCents = valueBeforeCents - quantity * unitCostCents;
  if (after > 0 && wantedValueCents >= 0) item.costPriceCents = wantedValueCents / after;
  if (quantity) {
    item.quantity = after;
    item.stockEvents = [...(item.stockEvents || []), { at: new Date(), type, reference, quantityBefore: before, quantityAfter: after, averageCostBeforeCents: oldCostCents, averageCostAfterCents: item.costPriceCents }];
    await item.save({ session });
  }

  const removedValueCents = valueBeforeCents - after * item.costPriceCents;
  const changeCents = receivedValueCents - removedValueCents;
  if (Math.abs(changeCents) > 1e-6) {
    await StockRevaluation.create(
      [{ item: item._id, itemName: item.name, quantity, oldCostCents, newCostCents: item.costPriceCents, changeCents, reason: `${reference} undone`, createdBy: user?._id || null, createdByName: user?.name || '' }],
      { session }
    );
  }
  return { removed: quantity };
}
