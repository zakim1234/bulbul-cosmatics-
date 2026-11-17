import { Router } from 'express';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getMyDay } from '../services/myDayService.js';
import {
  createSale,
  updateSale,
  cancelSale,
  listRefunds,
  listTodayDrafts,
  listSales,
  getSale,
  getReceipt,
  reverseSale,
  transferSale,
  returnSale,
} from '../controllers/saleController.js';

const router = Router();
router.use(requireAuth);
// My Report: the signed-in person's own sales and money since the last Close
// Day. It is everyone's home page, so it needs no POS permission (someone
// who only does stock simply sees zeros).
router.get('/my-day', asyncHandler(async (req, res) => res.json({ success: true, data: await getMyDay(req.user) })));
// Refunds page: its own permission (an admin has it unless taken away).
router.get('/refunds', requirePermission('refundsReport'), listRefunds);
router.use(requirePermission('pos'));

router.get('/drafts/today', listTodayDrafts);
router.get('/', listSales);
router.post('/', createSale);
router.get('/:id', getSale);
router.get('/:id/receipt', getReceipt);
router.put('/:id', requirePermission('editInvoices'), updateSale);
router.post('/:id/cancel', requirePermission('cancelInvoices'), cancelSale);
router.post('/:id/reverse', requirePermission('cancelInvoices'), reverseSale);
router.post('/:id/transfer', requirePermission('transferInvoices'), transferSale);
router.post('/:id/return', requireRole('admin', 'manager'), requirePermission('customerReturns'), returnSale);

export default router;
