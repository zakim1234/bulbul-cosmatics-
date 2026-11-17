import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { listPayments, getPaymentReceipt } from '../controllers/paymentController.js';

const router = Router();
router.use(requireAuth);
// Customer debt payments (names, phones, balances) belong to the Customers
// module -- the same permission the payment receipt page needs.
router.use(requirePermission('customers'));
router.get('/', listPayments);
router.get('/:id/receipt', getPaymentReceipt);

export default router;
