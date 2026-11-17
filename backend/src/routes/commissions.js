import { Router } from 'express';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { commissionPreview, commissionBranchesPreview, createCommissionAllBranches, listCommissions, getCommission, createCommission, cancelCommissionHandler } from '../controllers/commissionController.js';
import { getCommissionAccount, createCommissionAccount, moveCommissionMoney } from '../controllers/commissionAccountController.js';

// Commission (staff and admin) is the Super Admin's only.
const router = Router();
router.use(requireAuth);
router.use(requireSuperAdmin);

router.get('/preview', commissionPreview);
router.get('/branches-preview', commissionBranchesPreview);
router.post('/all-branches', createCommissionAllBranches);
// The branch's commission account (the staff's 30% is kept there).
router.get('/account', getCommissionAccount);
router.post('/account', createCommissionAccount);
router.post('/account/move', moveCommissionMoney);
router.get('/', listCommissions);
router.get('/:id', getCommission);
router.post('/', createCommission);
router.post('/:id/cancel', cancelCommissionHandler);

export default router;
