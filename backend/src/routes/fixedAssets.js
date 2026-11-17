import { Router } from 'express';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.js';
import { listFixedAssets, createFixedAsset, updateFixedAsset, removeFixedAsset } from '../controllers/fixedAssetController.js';
import { getFund, setAside, payOut, deleteFundEntry } from '../controllers/fixedAssetFundController.js';

const router = Router();
router.use(requireAuth);
router.use(requirePermission('fixedAssets'));

// The Fixed Asset Wallet: profit set aside for the owners, and paid out to
// them. Moving the business's profit is for the admin (and Super Admin).
router.get('/fund', getFund);
router.post('/fund/set-aside', requireRole('admin'), setAside);
router.post('/fund/payout', requireRole('admin'), payOut);
router.delete('/fund/:entryId', requireRole('admin'), deleteFundEntry);

router.get('/', listFixedAssets);
router.post('/', requireRole('admin', 'manager'), createFixedAsset);
router.put('/:id', requireRole('admin', 'manager'), updateFixedAsset);
router.post('/:id/remove', requireRole('admin', 'manager'), removeFixedAsset);

export default router;
