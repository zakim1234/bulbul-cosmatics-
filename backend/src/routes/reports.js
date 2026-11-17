import { Router } from 'express';
import { itemsSoldReport, itemsSoldPeriods } from '../controllers/dayCloseController.js';
import { quotationReport } from '../controllers/quotationController.js';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import { userHas } from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { toCents, fromCents } from '../utils/money.js';
import { logAudit } from '../services/auditService.js';
import CompanySetting, { getCompanySetting } from '../models/CompanySetting.js';
import Sale from '../models/Sale.js';
import { getStaffDaily } from '../services/staffDailyService.js';
import {
  salesReport,
  profitReport,
  profitByItemDrilldown,
  inventoryReport,
  customersReport,
  purchasesReport,
  itemProfitReport,
  listReportableUsers,
  userPerformanceReport,
} from '../controllers/reportController.js';
import {
  profitLossReport,
  profitLossExport,
  balanceSheetReport,
  balanceSheetExport,
  balanceSheetCheck,
  expenseReport,
  paymentMethodReport,
  expiredProductsReport,
  lowStockReport,
  salesReturnReport,
  purchaseReturnReport,
} from '../controllers/financialReportController.js';
import { getCustomerHistory } from '../controllers/customerController.js';
import { clearReports } from '../controllers/clearController.js';

const router = Router();
router.use(requireAuth);
// Report pages that can be opened for one person on their own: each needs
// only its own permission (an admin has them unless the Super Admin took one
// away). The people list is what the Staff Daily page picks from.
const OWN_PAGE = {
  '/items-sold': 'itemsSoldReport',
  '/items-sold/periods': 'itemsSoldReport',
  '/staff-daily': 'staffDailyReport',
  '/users': 'staffDailyReport',
  '/merchant-vat': 'merchantVatReport',
};
const reportsForAdmin = [requirePermission('reports'), requireRole('admin')];
router.use((req, res, next) => {
  const path = req.path.toLowerCase().replace(/\/+$/, '');
  const key = req.method === 'GET' ? OWN_PAGE[path] : null;
  if (key && userHas(req.user, key)) return next();
  // Those pages need their own permission, even an admin (the Super Admin
  // may have taken it away). The people list is also used by other reports,
  // so without Staff Daily it is checked like them.
  if (key && path !== '/users') return next(new ApiError(403, 'You do not have permission to open this report.'));
  // The business as a whole is for the admin. Everyone else has My Report
  // (GET /api/sales/my-day): only their own work since the last Close Day.
  reportsForAdmin[0](req, res, (err) => (err ? next(err) : reportsForAdmin[1](req, res, next)));
});

router.get('/sales', salesReport);
router.get('/items-sold', itemsSoldReport);
router.get('/items-sold/periods', itemsSoldPeriods);
// Admin only: each person's sales and money taken, day by day for a month.
router.get('/staff-daily', asyncHandler(async (req, res) => res.json({ success: true, data: await getStaffDaily({ month: req.query.month, from: req.query.from, to: req.query.to, userId: req.query.userId || undefined, customerId: req.query.customerId || undefined, allTime: req.query.all === '1' }) })));
router.get('/quotations', quotationReport);
router.get('/profit', profitReport);
router.get('/profit/items/:itemId', profitByItemDrilldown);
router.get('/inventory', inventoryReport);
router.get('/customers', customersReport);
router.get('/customers/:id', getCustomerHistory);
router.get('/purchases', purchasesReport);
router.get('/item-profit/:itemId', itemProfitReport);
router.get('/profit-loss', profitLossReport);
router.get('/profit-loss/export', profitLossExport);
router.get('/balance-sheet', balanceSheetReport);
// Where an out-of-balance gap may come from (read-only).
router.get('/balance-sheet/check', balanceSheetCheck);
// GET /api/reports/merchant-vat?year=2026 -- every invoice whose customer paid
// Merchant VAT (it went to the merchant company, not to us): the totals per
// year, and the invoices of the year asked for. Cancelled invoices left out.
router.get('/merchant-vat', asyncHandler(async (req, res) => {
  const all = await Sale.find({ vatCents: { $gt: 0 }, status: { $ne: 'CANCELLED' } })
    .select('receiptNumber createdAt customerName paidAmountCents totalCents vatPercent vatCents vatDeducted paymentAccount status')
    .populate('paymentAccount', 'name')
    .sort({ createdAt: -1 })
    .lean();
  const byYear = new Map();
  for (const s of all) {
    const y = new Date(s.createdAt).getFullYear();
    const t = byYear.get(y) || { year: y, count: 0, vatCents: 0, paidCents: 0 };
    t.count += 1;
    t.vatCents += s.vatCents || 0;
    t.paidCents += s.paidAmountCents || 0;
    byYear.set(y, t);
  }
  const years = [...byYear.values()].sort((a, b) => b.year - a.year).map((t) => ({ year: t.year, count: t.count, vat: fromCents(t.vatCents), paid: fromCents(t.paidCents) }));
  const year = Number(req.query.year) || years[0]?.year || new Date().getFullYear();
  const rows = all.filter((s) => new Date(s.createdAt).getFullYear() === year).map((s) => ({
    id: s._id,
    receiptNumber: s.receiptNumber,
    date: s.createdAt,
    customerName: s.customerName,
    account: s.paymentAccount?.name || '',
    paid: fromCents(s.paidAmountCents || 0),
    vatPercent: s.vatPercent || 0,
    vat: fromCents(s.vatCents || 0),
    // New sales: the customer sent the paid amount and the account got it less the VAT.
    customerSent: fromCents((s.paidAmountCents || 0) + (s.vatDeducted ? 0 : s.vatCents || 0)),
    accountGot: fromCents((s.paidAmountCents || 0) - (s.vatDeducted ? s.vatCents || 0 : 0)),
    status: s.status,
  }));
  const allVat = all.reduce((t, s) => t + (s.vatCents || 0), 0);
  res.json({ success: true, data: { year, years, rows, yearVat: fromCents(rows.reduce((t, r) => t + toCents(r.vat), 0)), allTimeVat: fromCents(allVat) } });
}));
// Opening Retained Earnings: the profit the company had before moving to this
// system. Everyone who sees the Balance Sheet can read it; only the Super
// Admin sets it.
router.get('/opening-equity', asyncHandler(async (req, res) => {
  const s = await getCompanySetting();
  res.json({ success: true, data: { openingRetainedEarnings: fromCents(s.openingRetainedEarningsCents || 0), openingNetIncome: fromCents(s.openingNetIncomeCents || 0), openingNetIncomeYear: s.openingNetIncomeYear || null, note: s.openingRetainedEarningsNote || '', updatedAt: s.updatedAt || null, updatedByName: s.updatedByName || '' } });
}));
// Clear All: the Super Admin empties what the profit reports are made of in
// the open branch (switched on in Settings; see clearController).
router.post('/clear', clearReports);
router.put('/opening-equity', asyncHandler(async (req, res) => {
  if (!req.user.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin can set the opening balance.');
  const n = Number(req.body.openingRetainedEarnings || 0);
  const ni = Number(req.body.openingNetIncome || 0);
  if (!Number.isFinite(n) || !Number.isFinite(ni)) throw new ApiError(400, 'Enter a valid amount.');
  const s = await CompanySetting.findOneAndUpdate(
    { _id: 'company' },
    { $set: { openingRetainedEarningsCents: toCents(n), openingNetIncomeCents: toCents(ni), openingNetIncomeYear: new Date().getFullYear(), openingRetainedEarningsNote: String(req.body.note || '').trim(), updatedByName: req.user.name } },
    { upsert: true, new: true }
  );
  await logAudit({ user: req.user, action: 'equity.opening_set', entityType: 'CompanySetting', details: { openingRetainedEarnings: n, openingNetIncome: ni } });
  res.json({ success: true, data: { openingRetainedEarnings: fromCents(s.openingRetainedEarningsCents), openingNetIncome: fromCents(s.openingNetIncomeCents) } });
}));
router.get('/balance-sheet/export', balanceSheetExport);
router.get('/expenses', expenseReport);
router.get('/payment-methods', paymentMethodReport);
router.get('/expired-products', expiredProductsReport);
router.get('/low-stock', lowStockReport);
router.get('/sales-returns', salesReturnReport);
router.get('/purchase-returns', purchaseReturnReport);
router.get('/users', listReportableUsers);
router.get('/user-performance', userPerformanceReport);

export default router;
