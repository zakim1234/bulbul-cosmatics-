import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  listInventory,
  searchInventory,
  listItemNames,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  getAlertsSummary,
} from '../controllers/inventoryController.js';
import { clearInventory } from '../controllers/clearController.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { stockAlerts } from '../services/stockAlertService.js';
import { getItemReport } from '../services/itemReportService.js';
import { mergeItems } from '../services/itemMergeService.js';
import { moveLotToItem } from '../services/lotMoveService.js';
import { runInTransaction } from '../utils/transaction.js';
import { logAudit } from '../services/auditService.js';

const router = Router();
router.use(requireAuth);

// Shared lookup/create surface: Seller/POS (product search, editing a
// Draft's existing lines, "+ Add New Item") and Stock both depend on this
// regardless of whether the current user has the standalone Inventory
// module -- gating these would break product search at the register.
router.get('/search', searchInventory);
router.get('/names', listItemNames);
// Delete every item in the branch (Super Admin, typed DELETE).
router.post('/clear', clearInventory);
router.post('/', createInventoryItem);
// Item Report: what came in (from which supplier), what went out (to which
// customer) and each day's in / out. Its own permission.
router.get('/:id/report', requirePermission('itemReport'), asyncHandler(async (req, res) => res.json({ success: true, data: await getItemReport({ itemId: req.params.id, from: req.query.from, to: req.query.to }) })));
router.get('/:id', getInventoryItem);
// Merge two items that are really one: this one's stock, batches and
// history move onto intoId, then this one is removed. Its own permission,
// off for everyone (admins too) until given.
// A batch put on the wrong item: what is left of it moves to the right one.
// Same permission as merging (fixing an item mix-up).
router.post('/lots/:lotId/move', requirePermission('mergeItems'), asyncHandler(async (req, res) => {
  const result = await runInTransaction((session) => moveLotToItem(session, { lotId: req.params.lotId, toItemId: req.body.toItemId, user: req.user }));
  await logAudit({ user: req.user, action: 'inventory.lot_move', entityType: 'InventoryLot', entityId: req.params.lotId, details: result });
  res.json({ success: true, data: result });
}));
router.post('/:id/merge', requirePermission('mergeItems'), asyncHandler(async (req, res) => {
  const result = await runInTransaction((session) => mergeItems(session, { fromId: req.params.id, intoId: req.body.intoId, user: req.user }));
  await logAudit({ user: req.user, action: 'inventory.merge', entityType: 'InventoryItem', entityId: result.into._id, details: { merged: result.from.name, quantity: result.from.quantity, into: result.into.name } });
  res.json({ success: true, data: { merged: result.from.name, into: { id: result.into._id, name: result.into.name, quantity: result.into.quantity } } });
}));

// The actual Inventory module: browsing, editing, deleting, alerts.
// Stock staff see stock health on their dashboard too.
router.get('/alerts/summary', requirePermission('inventory', 'stock'), getAlertsSummary);
// The pop-up alerts: stock expiring within a month, and stock running down.
router.get('/alerts/popup', requirePermission('inventory'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await stockAlerts() });
}));
router.get('/', requirePermission('inventory'), listInventory);
router.put('/:id', requirePermission('inventory'), updateInventoryItem);
router.delete('/:id', requirePermission('inventory'), deleteInventoryItem);

export default router;
