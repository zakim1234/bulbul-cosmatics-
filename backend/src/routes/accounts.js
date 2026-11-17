import { Router } from 'express';
import { requireAuth, requireRole, requirePermission, requireSuperAdmin } from '../middleware/auth.js';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  getAccountTransactions,
  deleteCancelledPair,
  getAccountStatement,
  accountsReport,
} from '../controllers/accountController.js';
import { clearAccounts } from '../controllers/clearController.js';
import { moveReceipt } from '../controllers/moveReceiptController.js';
import { transferBetweenAccounts } from '../controllers/accountTransferController.js';

const router = Router();
router.use(requireAuth);

// The account-picker surface: every payment (POS, Purchases, Wallet
// Deposit) needs the list of accounts to choose from, regardless of
// whether the current user has the standalone Accounts module.
router.get('/', listAccounts);

// The actual Accounts module: reports, per-account detail/ledger, and
// creating/editing accounts (already admin/manager only).
router.get('/report', requirePermission('accounts'), accountsReport);
// Empty every account: history deleted, balances back to 0 (Super Admin).
router.post('/clear', clearAccounts);
router.post('/', requirePermission('accounts'), requireRole('admin', 'manager'), createAccount);
// Move money between our own accounts (e.g. everything into one account).
router.post('/transfer', requirePermission('accounts'), requireRole('admin', 'manager'), transferBetweenAccounts);
router.get('/:id', requirePermission('accounts'), getAccount);
router.put('/:id', requirePermission('accounts'), requireRole('admin', 'manager'), updateAccount);
router.get('/:id/transactions', requirePermission('accounts'), getAccountTransactions);
// Cleaning up an account's payments: the Super Admin only.
router.delete('/transactions/:txnId', requireSuperAdmin, deleteCancelledPair);
router.get('/:id/statement', requirePermission('accounts'), getAccountStatement);
// A customer payment put on the wrong account: move it to the right one.
router.post('/transactions/:txnId/move', requirePermission('accounts'), requireRole('admin', 'manager'), moveReceipt);

export default router;
