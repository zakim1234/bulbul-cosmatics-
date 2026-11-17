import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RequirePermission from './components/RequirePermission.jsx';
import AppLayout from './layouts/AppLayout.jsx';

import Login from './pages/Login.jsx';
import { useAuth } from './context/AuthContext.jsx';
import BusyOverlay from './components/BusyOverlay.jsx';
import { lazy, Suspense, useEffect } from 'react';

// Each page is its own file, downloaded the first time it is opened -- the
// app starts small. Once the app is idle, the rest are fetched quietly in
// the background so moving between pages stays instant.
const pageLoaders = [];
function page(load) {
  pageLoaders.push(load);
  return lazy(load);
}
function preloadPages() {
  pageLoaders.forEach((load) => load().catch(() => {}));
}

const StockPage = page(() => import('./pages/stock/StockPage.jsx'));
const StockAdjustmentsPage = page(() => import('./pages/stock/StockAdjustmentsPage.jsx'));
const StockAdjustmentStatementPage = page(() => import('./pages/stock/StockAdjustmentStatementPage.jsx'));
const SalesInvoicePage = page(() => import('./pages/pos/SalesInvoicePage.jsx'));
const QuotationsPage = page(() => import('./pages/quotations/QuotationsPage.jsx'));
const QuotationDetailPage = page(() => import('./pages/quotations/QuotationDetailPage.jsx'));
const Dashboard = page(() => import('./pages/Dashboard.jsx'));
const MyReportPage = page(() => import('./pages/reports/MyReportPage.jsx'));
const StaffDashboard = page(() => import('./pages/StaffDashboard.jsx'));
const InventoryPage = page(() => import('./pages/inventory/InventoryPage.jsx'));
const InventoryPrintPage = page(() => import('./pages/inventory/InventoryPrintPage.jsx'));
const CategoriesPage = page(() => import('./pages/categories/CategoriesPage.jsx'));
const POSPage = page(() => import('./pages/pos/POSPage.jsx'));
const DayItemsSoldPage = page(() => import('./pages/pos/DayItemsSoldPage.jsx'));
const ItemsSoldPage = page(() => import('./pages/reports/ItemsSoldPage.jsx'));
const ItemReportPage = page(() => import('./pages/reports/ItemReportPage.jsx'));
const RefundsPage = page(() => import('./pages/reports/RefundsPage.jsx'));
const StaffDailyPage = page(() => import('./pages/reports/StaffDailyPage.jsx'));
const CloseDayHistoryPage = page(() => import('./pages/pos/CloseDayHistoryPage.jsx'));
const PurchasesPage = page(() => import('./pages/purchases/PurchasesPage.jsx'));
const PurchaseDetailPage = page(() => import('./pages/purchases/PurchaseDetailPage.jsx'));
const CustomersPage = page(() => import('./pages/customers/CustomersPage.jsx'));
const CustomersBulkPage = page(() => import('./pages/customers/CustomersBulkPage.jsx'));
const CreditLimitsSheetPage = page(() => import('./pages/customers/CreditLimitsSheetPage.jsx'));
const OpeningBalancesBulkPage = page(() => import('./pages/purchases/OpeningBalancesBulkPage.jsx'));
const CustomerDetailPage = page(() => import('./pages/customers/CustomerDetailPage.jsx'));
const CustomerStatementPage = page(() => import('./pages/customers/CustomerStatementPage.jsx'));
const CancelledStatementPage = page(() => import('./pages/customers/CancelledStatementPage.jsx'));
const SuppliersPage = page(() => import('./pages/suppliers/SuppliersPage.jsx'));
const SupplierDetailPage = page(() => import('./pages/suppliers/SupplierDetailPage.jsx'));
const SupplierInvoicesPage = page(() => import('./pages/suppliers/SupplierInvoicesPage.jsx'));
const AccountsPage = page(() => import('./pages/accounts/AccountsPage.jsx'));
const ExpensesPage = page(() => import('./pages/expenses/ExpensesPage.jsx'));
const PartnersPage = page(() => import('./pages/partners/PartnersPage.jsx'));
const CompanyWalletPage = page(() => import('./pages/companyWallet/CompanyWalletPage.jsx'));
const BranchTakesPage = page(() => import('./pages/companyWallet/BranchTakesPage.jsx'));
const SettingsPage = page(() => import('./pages/settings/SettingsPage.jsx'));
const MerchantVatPage = page(() => import('./pages/reports/MerchantVatPage.jsx'));
const ProfitSharingPage = page(() => import('./pages/partners/ProfitSharingPage.jsx'));
const ProfitDistributionPage = page(() => import('./pages/partners/ProfitDistributionPage.jsx'));
const FixedAssetsPage = page(() => import('./pages/fixedAssets/FixedAssetsPage.jsx'));
const LiabilitiesPage = page(() => import('./pages/liabilities/LiabilitiesPage.jsx'));
const ZakatPage = page(() => import('./pages/zakat/ZakatPage.jsx'));
const ReportsPage = page(() => import('./pages/reports/ReportsPage.jsx'));
const ReceiptPage = page(() => import('./pages/receipt/ReceiptPage.jsx'));
const PaymentReceiptPage = page(() => import('./pages/receipt/PaymentReceiptPage.jsx'));
const PurchaseReceiptPage = page(() => import('./pages/receipt/PurchaseReceiptPage.jsx'));
const BulkPaymentReceiptPage = page(() => import('./pages/receipt/BulkPaymentReceiptPage.jsx'));
const VendorBalancesPage = page(() => import('./pages/purchases/VendorBalancesPage.jsx'));
const VendorPlanPage = page(() => import('./pages/purchases/VendorPlanPage.jsx'));
const SupplierStatementPage = page(() => import('./pages/purchases/SupplierStatementPage.jsx'));
const SalariesPage = page(() => import('./pages/salaries/SalariesPage.jsx'));
const SalaryStatementPage = page(() => import('./pages/salaries/SalaryStatementPage.jsx'));
const AllBranchesPage = page(() => import('./pages/branches/AllBranchesPage.jsx'));
const SuperDashboardPage = page(() => import('./pages/branches/SuperDashboardPage.jsx'));
const DebtorsStatementPage = page(() => import('./pages/customers/DebtorsStatementPage.jsx'));
const BranchesPage = page(() => import('./pages/branches/BranchesPage.jsx'));
const ReturnReceiptPage = page(() => import('./pages/receipt/ReturnReceiptPage.jsx'));
const UsersPage = page(() => import('./pages/users/UsersPage.jsx'));
const CommissionsPage = page(() => import('./pages/commissions/CommissionsPage.jsx'));
const OffsetsPage = page(() => import('./pages/offsets/OffsetsPage.jsx'));
const OffsetVoucherPage = page(() => import('./pages/offsets/OffsetVoucherPage.jsx'));
const OffsetStatementPage = page(() => import('./pages/offsets/OffsetStatementPage.jsx'));
const CommissionDocPage = page(() => import('./pages/commissions/CommissionDocPage.jsx'));
const WalletStatementPage = page(() => import('./pages/customers/WalletStatementPage.jsx'));
const CustomerItemsPage = page(() => import('./pages/customers/CustomerItemsPage.jsx'));
const NotFound = page(() => import('./pages/NotFound.jsx'));

// The admin's dashboard is the whole business; everyone else's is My Report.
function Home() {
  const { user } = useAuth();
  return user?.role === 'admin' || user?.isSuperAdmin ? <Dashboard /> : <StaffDashboard />;
}

// Pages about the whole business: the admin only; anyone else goes to My Report.
function RequireAdmin({ children }) {
  const { user } = useAuth();
  return user?.role === 'admin' || user?.isSuperAdmin ? children : <Navigate to="/my-report" replace />;
}

function POSWorkspace() { const location = useLocation(); return <POSPage key={location.search} />; }

export default function App() {
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 2000));
    idle(preloadPages);
  }, []);

  return (
    <ToastProvider>
      <AuthProvider>
        <BusyOverlay />
        <BrowserRouter>
          <Suspense fallback={null}>
          <Routes>
            <Route path="/login" element={<Login />} />

            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/dashboard" element={<Home />} />
              <Route path="/my-report" element={<MyReportPage />} />
              <Route path="/inventory" element={<RequirePermission module="inventory"><InventoryPage /></RequirePermission>} />
              <Route path="/inventory/:id/print" element={<RequirePermission module="inventory"><InventoryPrintPage /></RequirePermission>} />
              <Route path="/categories" element={<RequirePermission module="categories"><CategoriesPage /></RequirePermission>} />
              <Route path="/pos" element={<RequirePermission module="pos"><SalesInvoicePage /></RequirePermission>} />
              <Route path="/pos/new" element={<RequirePermission module="pos"><POSWorkspace /></RequirePermission>} />
              <Route path="/quotations" element={<RequirePermission module="quotations"><QuotationsPage /></RequirePermission>} />
              <Route path="/quotations/new" element={<RequirePermission module="quotations"><QuotationDetailPage key="new" /></RequirePermission>} />
              <Route path="/quotations/:id" element={<RequirePermission module="quotations"><QuotationDetailPage /></RequirePermission>} />
              {/* Close Day now lives inside Daily Closing; old links redirect there. */}
              <Route path="/pos/close-day" element={<Navigate to="/daily-closing" replace />} />
              <Route path="/pos/close-day/history" element={<Navigate to="/daily-closing" replace />} />
              <Route path="/daily-closing" element={<RequirePermission roles={["admin", "manager"]}><CloseDayHistoryPage /></RequirePermission>} />
              <Route path="/daily-closing/items" element={<RequirePermission roles={["admin", "manager"]}><DayItemsSoldPage /></RequirePermission>} />
              <Route path="/staff-daily" element={<RequirePermission module="staffDailyReport"><StaffDailyPage /></RequirePermission>} />
              <Route path="/refunds" element={<RequirePermission module="refundsReport"><RefundsPage /></RequirePermission>} />
              <Route path="/item-report" element={<RequirePermission module="itemReport"><ItemReportPage /></RequirePermission>} />
              <Route path="/items-sold" element={<RequirePermission module="itemsSoldReport"><ItemsSoldPage /></RequirePermission>} />
              <Route path="/items-sold/view" element={<RequirePermission module={["itemsSoldReport", "reports"]}><DayItemsSoldPage /></RequirePermission>} />
              <Route path="/stock" element={<RequirePermission module="stock"><StockPage /></RequirePermission>} />
              <Route path="/stock-adjustments" element={<RequirePermission module="stockAdjustments"><StockAdjustmentsPage /></RequirePermission>} />
              <Route path="/stock-adjustments/statement/:number" element={<RequirePermission module="stockAdjustments"><StockAdjustmentStatementPage /></RequirePermission>} />
              <Route path="/purchases" element={<RequirePermission module="purchases"><PurchasesPage /></RequirePermission>} />
              <Route path="/purchases/opening-balances/bulk" element={<RequirePermission module="openingBalances"><OpeningBalancesBulkPage /></RequirePermission>} />
              <Route path="/purchases/vendor-balances" element={<RequirePermission module="vendorBalances"><VendorBalancesPage /></RequirePermission>} />
              <Route path="/super-dashboard" element={<RequirePermission superAdmin><SuperDashboardPage /></RequirePermission>} />
              <Route path="/all-branches" element={<RequirePermission superAdmin><AllBranchesPage /></RequirePermission>} />
              <Route path="/branches" element={<RequirePermission superAdmin><BranchesPage /></RequirePermission>} />
              <Route path="/commissions" element={<RequirePermission superAdmin><CommissionsPage /></RequirePermission>} />
              <Route path="/offsets" element={<RequirePermission module="offsets"><OffsetsPage /></RequirePermission>} />
              <Route path="/offsets/statement" element={<RequirePermission module="offsets"><OffsetStatementPage /></RequirePermission>} />
              <Route path="/offsets/:id" element={<RequirePermission module="offsets"><OffsetVoucherPage /></RequirePermission>} />
              <Route path="/commissions/:id" element={<RequirePermission superAdmin><CommissionDocPage /></RequirePermission>} />
              <Route path="/salaries" element={<RequirePermission module="salaries"><SalariesPage /></RequirePermission>} />
              <Route path="/salaries/statement" element={<RequirePermission module="salaries"><SalaryStatementPage /></RequirePermission>} />
              <Route path="/salaries/:id" element={<RequirePermission module="salaries"><SalariesPage /></RequirePermission>} />
              <Route path="/purchases/suppliers/:supplierId/statement" element={<RequirePermission module="purchases"><SupplierStatementPage /></RequirePermission>} />
              <Route path="/purchases/vendor-balances/:planId" element={<RequirePermission module="vendorBalances"><VendorPlanPage /></RequirePermission>} />
              <Route path="/purchases/:id" element={<RequirePermission module="purchases"><PurchaseDetailPage /></RequirePermission>} />
              <Route path="/purchases/:id/receipt" element={<RequirePermission module="purchases"><PurchaseReceiptPage /></RequirePermission>} />
              <Route path="/purchases/bulk-payments/:bulkId" element={<RequirePermission module="purchases"><BulkPaymentReceiptPage /></RequirePermission>} />
              <Route path="/customers" element={<RequirePermission module="customers"><CustomersPage /></RequirePermission>} />
              <Route path="/customers/credit-limits" element={<RequirePermission module="creditLimits"><CreditLimitsSheetPage /></RequirePermission>} />
              <Route path="/customers/bulk" element={<RequirePermission module="customersSheet"><CustomersBulkPage /></RequirePermission>} />
              <Route path="/customers/debtors" element={<RequirePermission module="customers"><DebtorsStatementPage /></RequirePermission>} />
              <Route path="/customers/:id" element={<RequirePermission module="customers"><CustomerDetailPage /></RequirePermission>} />
              <Route path="/customers/:id/items" element={<RequirePermission module="customers"><CustomerItemsPage /></RequirePermission>} />
              <Route path="/customers/:id/wallet-statement" element={<RequirePermission module="customers"><WalletStatementPage /></RequirePermission>} />
              <Route path="/customers/:id/statement" element={<RequirePermission module="customers"><CustomerStatementPage /></RequirePermission>} />
              <Route path="/customers/:id/cancelled-statement" element={<RequirePermission module="customers"><CancelledStatementPage /></RequirePermission>} />
              <Route path="/suppliers" element={<RequirePermission module="suppliers"><SuppliersPage /></RequirePermission>} />
              <Route path="/suppliers/:id" element={<RequirePermission module="suppliers"><SupplierDetailPage /></RequirePermission>} />
              <Route path="/supplier-invoices" element={<RequirePermission module="supplierInvoices"><SupplierInvoicesPage /></RequirePermission>} />
              <Route path="/accounts" element={<RequirePermission module="accounts"><AccountsPage /></RequirePermission>} />
              <Route path="/expenses" element={<RequirePermission module="expenses"><ExpensesPage /></RequirePermission>} />
              <Route path="/partners" element={<RequirePermission module="partners"><PartnersPage /></RequirePermission>} />
              <Route path="/partners/profit-sharing" element={<RequirePermission module="partners"><ProfitSharingPage /></RequirePermission>} />
              <Route path="/partners/profit-sharing/:id" element={<RequirePermission module="partners"><ProfitDistributionPage /></RequirePermission>} />
              <Route path="/fixed-assets" element={<RequirePermission module="fixedAssets"><FixedAssetsPage /></RequirePermission>} />
              <Route path="/liabilities" element={<RequirePermission module="fixedAssets"><LiabilitiesPage /></RequirePermission>} />
              <Route path="/zakat" element={<RequirePermission superAdmin><ZakatPage /></RequirePermission>} />
              <Route path="/company-wallet" element={<RequirePermission module="companyWallet"><CompanyWalletPage /></RequirePermission>} />
              <Route path="/wallet-report" element={<RequirePermission module="walletTakesReport"><BranchTakesPage /></RequirePermission>} />
              <Route path="/settings" element={<RequirePermission superAdmin><SettingsPage /></RequirePermission>} />
              <Route path="/reports" element={<RequireAdmin><ReportsPage /></RequireAdmin>} />
              <Route path="/merchant-vat" element={<RequirePermission module="merchantVatReport"><MerchantVatPage /></RequirePermission>} />
              <Route path="/receipt/:id" element={<RequirePermission module="pos"><ReceiptPage /></RequirePermission>} />
              <Route path="/receipt/:id/return/:index" element={<RequirePermission module="pos"><ReturnReceiptPage /></RequirePermission>} />
              <Route path="/payment-receipt/:id" element={<RequirePermission module="customers"><PaymentReceiptPage /></RequirePermission>} />
              <Route path="/users" element={<RequirePermission adminOnly><UsersPage /></RequirePermission>} />
            </Route>

            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
