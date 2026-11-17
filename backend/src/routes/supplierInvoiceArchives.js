import { Router } from 'express';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import { createArchive, searchArchives, archivesBySupplier, getArchive, updateArchive, deleteArchive, sendArchiveToPurchases } from '../controllers/supplierInvoiceArchiveController.js';

const router = Router();
router.use(requireAuth);
router.use(requirePermission('supplierInvoices'));
router.post('/', createArchive);
router.get('/', searchArchives);
router.get('/by-supplier', archivesBySupplier);
router.get('/:id', getArchive);
router.post('/:id/to-purchase', sendArchiveToPurchases);
// Editing: its own permission (Edit supplier invoices). Deleting: admin/manager.
router.put('/:id', requirePermission('editSupplierInvoices'), updateArchive);
router.delete('/:id', requireRole('admin', 'manager'), deleteArchive);

export default router;
