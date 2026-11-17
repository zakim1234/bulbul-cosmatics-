import { Router } from 'express';
import { giveLoan, cancelLoan } from '../controllers/customerLoanController.js';
import { moveCustomerPayment } from '../controllers/movePaymentController.js';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import {
  listCustomers,
  searchCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  setCreditLimit,
  setCreditLimitsBulk,
  getCreditLimitsSheet,
  getCustomerHistory,
  getCustomerDebt,
  payCustomerDebt,
  cancelCustomerPayment,
  getCustomerStatement,
  getCancelledStatement,
  depositToWallet,
  getCustomerItemsReport,
  withdrawFromWallet,
  editWalletBalance,
  payDebtFromWallet,
  setWalletAutoPay,
  getWalletHistory,
  listDebtors,
  createCustomersBulk,
  updateCustomerOpeningBalance,
  getCustomersSheet,
} from '../controllers/customerController.js';
import { clearCustomers } from '../controllers/clearController.js';

const router = Router();
router.use(requireAuth);

// Picking a customer: needed by Seller/POS and Quotation regardless of whether
// the current user has the standalone Customers module. Adding a new one needs
// its own permission, wherever it is done from.
router.get('/search', searchCustomers);
router.post('/', requirePermission('createCustomers'), createCustomer);
router.post('/bulk', requirePermission('customers'), requirePermission('customersSheet'), createCustomersBulk);
router.get('/sheet', requirePermission('customers'), requirePermission('customersSheet'), getCustomersSheet);
router.get('/debtors', requirePermission('customers'), listDebtors);
// Delete every customer in the branch (Super Admin + bulk tools on, see
// clearController). Must stay: the Customers page "Clear All" button calls it.
router.post('/clear', clearCustomers);
// Before '/:id', or "credit-limits" would be read as a customer id.
router.get('/credit-limits', requirePermission('creditLimits'), getCreditLimitsSheet);
router.get('/:id', getCustomer);

// The actual Customers module: browsing, editing, debt/wallet management.
router.get('/', requirePermission('customers'), listCustomers);
router.put('/:id', requirePermission('customers'), updateCustomer);
router.put('/:id/opening-balance', requirePermission('customers'), requirePermission('changeOpeningDebt'), updateCustomerOpeningBalance);
router.delete('/:id', requirePermission('customers'), deleteCustomer);
// The most a customer may owe: set by an admin only.
// Credit limits: one (the window) or many (the sheet) -- the Credit limits permission.
router.put('/:id/credit-limit', requirePermission('creditLimits'), setCreditLimit);
router.post('/credit-limits', requirePermission('creditLimits'), setCreditLimitsBulk);
router.get('/:id/history', requirePermission('customers'), getCustomerHistory);
router.get('/:id/statement', requirePermission('customers'), getCustomerStatement);
router.get('/:id/cancelled-statement', requirePermission('customers'), getCancelledStatement);
router.get('/:id/items', requirePermission('customers'), getCustomerItemsReport);
router.get('/:id/debt', requirePermission('customers'), getCustomerDebt);
// Money on a customer, one permission each: debt payments, the wallet, returns
// (on the sales route) and the opening debt. Admins have them; others when given.
router.post('/:id/payments', requirePermission('customers'), requirePermission('takeDebtPayments'), payCustomerDebt);
// Cash lent to a customer (becomes their debt): its own permission, off unless given.
router.post('/:id/loans', requirePermission('customers'), requirePermission('customerLoans'), giveLoan);
router.post('/:id/loans/:loanId/cancel', requirePermission('customers'), requirePermission('customerLoans'), cancelLoan);
router.post('/:id/payments/:paymentId/cancel', requirePermission('customers'), requireRole('admin', 'manager'), cancelCustomerPayment);
// A debt payment entered on the wrong customer: move it to the right one.
router.post('/:id/payments/:paymentId/move', requirePermission('customers'), requireRole('admin', 'manager'), moveCustomerPayment);
router.post('/:id/wallet/deposit', requirePermission('customers'), requirePermission('walletMoney'), depositToWallet);
router.put('/:id/wallet/balance', requirePermission('customers'), requirePermission('editWallet'), editWalletBalance);
router.post('/:id/wallet/withdraw', requirePermission('customers'), requirePermission('walletMoney'), withdrawFromWallet);
router.post('/:id/wallet/pay-debt', requirePermission('customers'), requirePermission('walletMoney'), payDebtFromWallet);
router.put('/:id/wallet/auto-pay', requirePermission('customers'), setWalletAutoPay);
router.get('/:id/wallet/history', requirePermission('customers'), getWalletHistory);

export default router;
