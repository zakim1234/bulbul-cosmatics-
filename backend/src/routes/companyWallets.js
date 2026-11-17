import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { userHas } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { listWallets, createWallet, updateWallet, deleteWallet, listEntries, addEntry, deleteEntry, listBranchAccounts, takeFromBranches, giveToBranch, deleteTake, listBranchTakes, listNotices, getAutoTake, saveAutoTake, setBranchOwed } from '../controllers/companyWalletController.js';

const router = Router();
router.use(requireAuth);

// The report an admin may be allowed: money taken out of their branch's
// accounts (amount and account) and what the branch still owes.
router.get('/branch-takes', (req, res, next) =>
  req.user?.isSuperAdmin || userHas(req.user, 'walletTakesReport') || userHas(req.user, 'companyWallet') ? next() : next(new ApiError(403, 'Ask the Super Admin to let you see the company wallet report.')),
  listBranchTakes
);

// Company wallets: Super Admin, or someone they allow.
router.use((req, res, next) =>
  req.user?.isSuperAdmin || userHas(req.user, 'companyWallet') ? next() : next(new ApiError(403, 'Only the Super Admin, or someone they allow, can open the company wallet.'))
);

router.get('/', listWallets);
router.get('/branch-accounts', listBranchAccounts);
// Automatic daily take (Super Admin only -- checked in the controller).
router.get('/auto-take', getAutoTake);
router.get('/notices', listNotices);
router.put('/auto-take', saveAutoTake);
router.put('/auto-take/branches/:branchId', setBranchOwed);
router.post('/', createWallet);
router.put('/:id', updateWallet);
router.delete('/:id', deleteWallet);
router.get('/:id/entries', listEntries);
router.post('/:id/entries', addEntry);
router.post('/:id/take', takeFromBranches);
router.post('/:id/give', giveToBranch);
router.delete('/:id/takes/:batch', deleteTake);
router.delete('/:id/entries/:entryId', deleteEntry);

export default router;
