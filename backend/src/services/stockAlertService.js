import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import Branch from '../models/Branch.js';

const DAY = 24 * 60 * 60 * 1000;
export const EXPIRY_WINDOW_DAYS = 30;
// Stock IN receipts (stockReceiptService): RESTOCK when the item was at 0.
const RECEIPT_TYPES = ['RECEIPT', 'RESTOCK'];

// The pop-up alerts shown to whoever looks after the stock:
//  - expiring: stock that expires within a month (or already has), from the
//    batches still holding it -- or the item's own expiry date when it has
//    no dated batches;
//  - stock: items running down since their last restock. Measured against
//    the quantity right after that restock ("base"): one alert at 80%, 60%
//    and 40% left (500 -> 400, 300, 200), and a red one at 20% (100), at the
//    item's minimum stock, or when it runs out. `key` changes with each step,
//    so each step alerts once; a new restock starts again from the top.
export async function stockAlerts() {
  const now = Date.now();
  const soon = new Date(now + EXPIRY_WINDOW_DAYS * DAY);

  // The level to measure against: the quantity right after the last stock
  // receipt -- a return, a cancelled sale or an undone adjustment is not a
  // restock. An item never received through Stock uses the highest level its
  // history shows.
  const items = await InventoryItem.aggregate([
    { $match: { status: { $ne: 'inactive' } } },
    {
      $project: {
        name: 1,
        itemCode: 1,
        quantity: 1,
        lowStockThreshold: 1,
        expiryDate: 1,
        branch: 1,
        lastReceipt: { $last: { $filter: { input: { $ifNull: ['$stockEvents', []] }, cond: { $in: ['$$this.type', RECEIPT_TYPES] } } } },
        highest: { $max: { $concatArrays: [{ $ifNull: ['$stockEvents.quantityAfter', []] }, { $ifNull: ['$stockEvents.quantityBefore', []] }] } },
      },
    },
  ]);
  const byId = new Map(items.map((i) => [String(i._id), i]));
  const branchName = new Map((await Branch.find().select('name').lean()).map((b) => [String(b._id), b.name]));
  const where = (i) => branchName.get(String(i.branch)) || '';

  // Expiry, from the batches.
  const datedLots = await InventoryLot.find({ remainingQuantity: { $gt: 0 }, expiryDate: { $ne: null } })
    .select('item expiryDate remainingQuantity')
    .lean();
  const hasDatedLots = new Set(datedLots.map((l) => String(l.item)));
  const expiringByItem = new Map();
  for (const lot of datedLots) {
    if (lot.expiryDate > soon) continue;
    const item = byId.get(String(lot.item));
    if (!item) continue;
    const e = expiringByItem.get(String(lot.item)) || { item, expiryDate: lot.expiryDate, quantity: 0 };
    if (lot.expiryDate < e.expiryDate) e.expiryDate = lot.expiryDate;
    e.quantity += lot.remainingQuantity;
    expiringByItem.set(String(lot.item), e);
  }
  for (const item of items) {
    if (hasDatedLots.has(String(item._id)) || !item.expiryDate || item.expiryDate > soon || item.quantity <= 0) continue;
    expiringByItem.set(String(item._id), { item, expiryDate: item.expiryDate, quantity: item.quantity });
  }
  const expiring = [...expiringByItem.values()]
    .map(({ item, expiryDate, quantity }) => ({
      item: item._id,
      name: item.name,
      itemCode: item.itemCode,
      branchName: where(item),
      expiryDate,
      daysLeft: Math.ceil((new Date(expiryDate).getTime() - now) / DAY),
      quantity,
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  // Running down since the last restock.
  const stock = [];
  for (const item of items) {
    const restock = item.lastReceipt;
    const base = Number(restock ? restock.quantityAfter : item.highest) || 0;
    if (base < 5) continue;
    const left = item.quantity / base;
    let step = left <= 0.2 ? 4 : left <= 0.4 ? 3 : left <= 0.6 ? 2 : left <= 0.8 ? 1 : 0;
    if (item.quantity <= (item.lowStockThreshold ?? 0) || item.quantity <= 0) step = 4;
    if (!step) continue;
    stock.push({
      item: item._id,
      name: item.name,
      itemCode: item.itemCode,
      branchName: where(item),
      quantity: item.quantity,
      base,
      percentLeft: Math.round(left * 100),
      red: step === 4,
      key: `${item._id}:${base}:${step}:${restock ? new Date(restock.at).getTime() : 0}`,
    });
  }
  stock.sort((a, b) => a.percentLeft - b.percentLeft);

  return { expiring, stock, expiryWindowDays: EXPIRY_WINDOW_DAYS };
}
