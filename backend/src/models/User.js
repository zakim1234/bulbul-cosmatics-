import mongoose from 'mongoose';

// Every permission-restrictable module. Kept here (not derived from routes)
// so both the backend middleware and the Users admin UI validate against
// exactly the same canonical list.
export const PERMISSION_MODULES = [
  'stock',
  'stockAdjustments',
  'inventory',
  'categories',
  'pos',
  'quotations',
  'purchases',
  'accounts',
  'customers',
  'suppliers',
  'supplierInvoices',
  'reports',
  'expenses',
  'createItems',
  // Cancel invoices (pending or confirmed). Admins always can; anyone else
  // only when an admin switches it on for them.
  'cancelInvoices',
  // Edit an invoice. Admins always can; anyone else only when an admin
  // switches it on for them.
  'editInvoices',
  // Changing or removing saved records, one area each (was one broad "Edit
  // records" / "Delete records"; see LEGACY_PERMISSIONS). Admins have them;
  // anyone else when given. Checked in middleware/auth.js changeNotAllowed.
  'editCustomers',
  'deleteCustomers',
  'editItems', // items and categories
  'deleteItems',
  'deleteSuppliers', // (editing one: editSuppliers -- name & phone)
  'editPurchases', // purchase invoices and their payments
  'deletePurchases', // delete, void, reverse a payment, cancel a bulk payment
  'editAccounts',
  'cancelExpenses',
  'cancelCustomerPayments',
  // Money on a customer, one thing each (was one "Customer money").
  'takeDebtPayments',
  'walletMoney', // wallet deposit, withdraw, pay debt from the wallet
  'customerReturns',
  'changeOpeningDebt',
  // The customers sheet (Edit / Add Many), supplier opening balances (add
  // one, and their sheet) and Vendor Balances: hidden unless switched on.
  'customersSheet',
  'openingBalances',
  'vendorBalances',
  // Move an invoice put on the wrong customer to the right one.
  'transferInvoices',
  // Add new customers (Customers page, the sheet, POS and Quotation).
  'createCustomers',
  // Pay suppliers: Pay this supplier, Add Payment, Pay allocations. A branch
  // admin the Super Admin allowed can pass it on to their staff.
  'paySuppliers',
  // Change an item's quantity in the Inventory edit window.
  'editItemQuantity',
  // The Salaries pages: workers, salary sheets and paying them.
  'salaries',
  'partners',
  'fixedAssets',
  'zakat',
  // Edit a customer's wallet balance. Super Admin always; a branch admin only
  // when the Super Admin turns it on; that admin may pass it on to staff.
  'editWallet',
  // Delete a stock adjustment. Super Admin always; a branch admin only when
  // the Super Admin turns it on; never other staff.
  'deleteStockAdjustments',
  'staffDailyDelete',
  // Customer <-> Supplier offsets page.
  'offsets',
  // Cancel a paid Vendor Balances sheet (supplier payments). Off unless given.
  'cancelVendorPayments',
  // Edit an invoice after Close Day (off unless given).
  'editClosedInvoices',
  // Edit or cancel an invoice the Super Admin edited (off unless given).
  'changeLockedInvoices',
  'walletTakesReport',
  // Company Wallet: Super Admin always; others only when the Super Admin turns it on.
  'companyWallet',
  // Report pages that were admin-only: an admin has them, anyone else when
  // given. Each opens just its own page (not the other reports).
  'itemsSoldReport',
  'refundsReport',
  'merchantVatReport',
  'staffDailyReport',
  // Edit a supplier (name, phone...) without the general Edit records;
  // deleting one is not part of it.
  'editSuppliers',
  // Item Report: one item's in / out, suppliers and customers.
  'itemReport',
  // Merge an item entered twice into the one it really is (off unless given).
  'mergeItems',
  // Lend a customer money in cash (it becomes their debt). Off unless given.
  'customerLoans',
  // Manual Entry Invoice: put its goods into stock without the whole Stock page.
  'manualEntryStock',
  // Set customers' credit limits (one, or many in the Credit limits sheet).
  'creditLimits',
  // Edit a supplier invoice (Supplier Invoices -> Edit). Admins have it; others when given.
  'editSupplierInvoices',
];

// Abilities a branch admin has only when the Super Admin turns them on (off
// by default, unlike everything else).
export const ADMIN_OPT_IN = ['customerLoans', 'mergeItems', 'changeLockedInvoices', 'editClosedInvoices', 'cancelVendorPayments', 'transferInvoices', 'createCustomers', 'paySuppliers', 'editItemQuantity', 'salaries', 'editWallet', 'deleteStockAdjustments', 'companyWallet', 'staffDailyDelete', 'walletTakesReport'];
// Other staff never have these, even if ticked.
// The Company Wallet is the whole company's money, not one branch's.
export const STAFF_NEVER = ['companyWallet', 'walletTakesReport'];
// Only the Super Admin hands these out, to admins and staff alike.
export const SUPER_ADMIN_GRANTS = ['companyWallet', 'walletTakesReport'];

// The old broad names (see LEGACY_PERMISSIONS below), still readable.
const LEGACY_KEYS = { editRecords: 1, deleteRecords: 1, customerMoney: 1 };

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    // When the password last changed: sign-ins from before then are refused.
    passwordChangedAt: { type: Date, default: null },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true, maxlength: 30 },
    // 'admin'/'manager'/'cashier' are the original built-in roles; 'custom'
    // lets an admin hand-pick permissions without pretending the user fits
    // one of the templates. An admin always has full access regardless of
    // `permissions` -- see middleware/permissions.js.
    role: { type: String, enum: ['admin', 'manager', 'cashier', 'custom'], default: 'admin' },
    // Effective only for non-admin roles. Manager/cashier still start with
    // no modules granted -- an admin must explicitly grant each one, this
    // is not a role-template shortcut.
    permissions: { type: [String], enum: [...PERMISSION_MODULES, ...Object.keys(LEGACY_KEYS)], default: [] },
    // A branch admin has every module except these, which the Super Admin
    // took away (empty: everything, as always).
    adminDenied: { type: [String], enum: [...PERMISSION_MODULES, ...Object.keys(LEGACY_KEYS)], default: [] },
    // A branch admin: the ADMIN_OPT_IN abilities the Super Admin turned on.
    adminGranted: { type: [String], enum: [...PERMISSION_MODULES, ...Object.keys(LEGACY_KEYS)], default: [] },
    active: { type: Boolean, default: true },
    // The branch this user works in. The Super Admin has none: they see
    // every branch and switch between them.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    isSuperAdmin: { type: Boolean, default: false },
    // Super Admin setting: show Clear All / Import Excel (off until switched on).
    showBulkTools: { type: Boolean, default: false },
    // With branches: the branches where Clear All / Import Excel are switched on
    // (every other branch keeps them hidden and refused).
    bulkToolsBranches: { type: [mongoose.Schema.Types.ObjectId], ref: 'Branch', default: [] },
  },
  { timestamps: true }
);

// The broad permissions that were split: whoever had one has every part of
// it, so nobody loses anything (users are moved over on start-up; this also
// covers a list saved before that).
export const LEGACY_PERMISSIONS = {
  editRecords: ['editCustomers', 'editItems', 'editSuppliers', 'editPurchases', 'editAccounts'],
  deleteRecords: ['deleteCustomers', 'deleteItems', 'deleteSuppliers', 'deletePurchases', 'cancelExpenses', 'cancelCustomerPayments'],
  customerMoney: ['takeDebtPayments', 'walletMoney', 'customerReturns', 'changeOpeningDebt'],
};
export const expandLegacy = (list = []) => [...new Set(list.flatMap((p) => LEGACY_PERMISSIONS[p] || [p]))];

// What a user may do: the Super Admin everything; a branch admin everything
// except what the Super Admin took away; anyone else what was granted.
export function effectivePermissions(user) {
  if (!user) return [];
  if (user.isSuperAdmin) return [...PERMISSION_MODULES];
  if (user.role === 'admin') {
    const denied = expandLegacy(user.adminDenied);
    const granted = expandLegacy(user.adminGranted);
    return PERMISSION_MODULES.filter((m) => !denied.includes(m) && (!ADMIN_OPT_IN.includes(m) || granted.includes(m)));
  }
  return expandLegacy(user.permissions).filter((m) => PERMISSION_MODULES.includes(m) && !STAFF_NEVER.includes(m));
}
export const userHas = (user, moduleKey) => effectivePermissions(user).includes(moduleKey);

export default mongoose.model('User', userSchema);
