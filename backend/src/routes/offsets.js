import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { listOffsets, getOffset, listParties, previewOffset, postOffset, postCancelOffset, removeOffset } from '../controllers/offsetController.js';

// Customer <-> supplier offsets: whoever has the Customer <-> Supplier
// permission (admins have it unless the Super Admin took it away).
const router = Router();
router.use(requireAuth, requirePermission('offsets'));
router.get('/', listOffsets);
router.get('/parties', listParties);
router.get('/preview', previewOffset);
router.get('/:id', getOffset);
router.post('/', postOffset);
router.post('/:id/cancel', postCancelOffset);
router.delete('/:id', removeOffset);
export default router;
