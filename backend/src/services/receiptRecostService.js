import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import StockEntry from '../models/StockEntry.js';
import StockRevaluation from '../models/StockRevaluation.js';

// A supplier invoice already received into stock has its cost (or discount)
// corrected. What we owe the supplier follows the invoice (its purchase
// invoice is synced by the caller); here the stock follows too:
//  - each batch now costs the corrected amount;
//  - what is still on the shelf is worth the difference more or less, so the
//    item's average cost moves with it;
//  - what was already sold went out at the old cost: that difference is a
//    gain or loss in Profit & Loss.
// Owed (supplier) change = stock change + P&L change, so the Balance Sheet
// stays balanced. `factor` turns an invoice cost into what each unit really
// cost (the discount shared over the rows).
export async function recostReceivedInvoice(session, { entryId, rows, factor, reference, user }) {
  const entry = await StockEntry.findById(entryId).session(session);
  if (!entry) return;
  for (let i = 0; i < rows.length; i += 1) {
    const er = entry.rows[i];
    if (!er || !er.batch) continue;
    const lot = await InventoryLot.findById(er.batch).session(session);
    if (!lot) continue;
    const newUnit = rows[i].costCents * factor;
    const delta = newUnit - lot.unitCostCents;
    if (Math.abs(delta) < 1e-9) continue;
    const item = await InventoryItem.findById(lot.item).session(session);
    if (!item) continue;
    const remaining = Math.max(0, lot.remainingQuantity || 0);
    const valueBefore = item.quantity * item.costPriceCents;
    const target = valueBefore + remaining * delta;
    const costBefore = item.costPriceCents;
    if (item.quantity > 0 && target >= 0) item.costPriceCents = target / item.quantity;
    const stockChange = item.quantity * item.costPriceCents - valueBefore;
    item.stockEvents.push({ type: 'COST_CORRECTED', reference, quantityBefore: item.quantity, quantityAfter: item.quantity, averageCostBeforeCents: costBefore, averageCostAfterCents: item.costPriceCents });
    await item.save({ session });
    // The supplier is now owed (originalQuantity x delta) more; the stock
    // took stockChange of it; the rest is profit or loss.
    const changeCents = stockChange - lot.originalQuantity * delta;
    if (Math.abs(changeCents) > 1e-6) {
      await StockRevaluation.create([{ item: item._id, itemName: item.name, quantity: lot.originalQuantity, oldCostCents: lot.unitCostCents, newCostCents: newUnit, changeCents, reason: `${reference}: cost corrected`, createdBy: user?._id || null, createdByName: user?.name || '' }], { session });
    }
    lot.unitCostCents = newUnit;
    await lot.save({ session });
    er.costPriceCents = newUnit;
  }
  entry.markModified('rows');
  await entry.save({ session });
}
