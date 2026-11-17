// Must match backend/src/models/User.js PERMISSION_MODULES exactly.
export const PERMISSION_MODULES = [
  { key: 'stock', label: 'Stock', hint: 'Stock page: add items and their prices (stock itself comes in on Supplier Invoices)' },
  { key: 'stockAdjustments', label: 'Stock Adjustment', hint: "Stock Adjustment page: damaged, expired, lost or counted stock" },
  { key: 'inventory', label: 'Inventory', hint: "Inventory page: see items, prices and quantities" },
  { key: 'categories', label: 'Categories', hint: "Categories page: item groups" },
  { key: 'pos', label: 'Seller / POS', hint: "Seller / POS page: make sales invoices" },
  { key: 'quotations', label: 'Quotation', hint: "Quotation page: make, edit and convert quotations" },
  { key: 'purchases', label: 'Purchase Invoices', hint: "Purchase Invoices page: what is owed to suppliers" },
  { key: 'accounts', label: 'Accounts', hint: "Accounts page: account balances and statements" },
  { key: 'customers', label: 'Customers', hint: "Customers page: customers, their invoices and debt" },
  { key: 'suppliers', label: 'Suppliers', hint: "Suppliers page" },
  { key: 'supplierInvoices', label: 'Supplier Invoices', hint: "Supplier Invoices page: the supplier's paper invoices" },
  { key: 'reports', label: 'Reports', hint: 'Reports page: sales, P&L, Balance Sheet (the other reports have their own permission below)' },
  { key: 'expenses', label: 'Expenses', hint: "Expenses page: record and pay expenses" },
  { key: 'createItems', label: 'Create new items from POS', hint: "POS: the \"+ New item\" button when an item is not in stock yet" },
  { key: 'cancelInvoices', label: 'Cancel invoices', hint: "Sales invoices: the Cancel button" },
  { key: 'editInvoices', label: 'Edit invoices', hint: "Sales invoices: the Edit button (before Close Day)" },
  { key: 'editCustomers', label: 'Edit customers', hint: 'Customers: the Edit button (name, phone…) and wallet auto-pay' },
  { key: 'deleteCustomers', label: 'Delete customers', hint: 'Customers: the Delete button' },
  { key: 'editItems', label: 'Edit items', hint: 'Inventory and Categories: the Edit button (name, prices, category…)' },
  { key: 'deleteItems', label: 'Delete items', hint: 'Inventory and Categories: the Delete button' },
  { key: 'deleteSuppliers', label: 'Delete suppliers', hint: 'Suppliers: the Delete button' },
  { key: 'editPurchases', label: 'Edit purchase invoices', hint: 'Purchase Invoices: the Edit button, and editing a payment made on one' },
  { key: 'deletePurchases', label: 'Delete / void purchase invoices', hint: 'Purchase Invoices: Delete, Void, reverse a payment, cancel a bulk payment' },
  { key: 'editAccounts', label: 'Edit accounts', hint: 'Accounts: the Edit button on an account' },
  { key: 'cancelExpenses', label: 'Cancel expenses', hint: 'Expenses: the Void (cancel) button' },
  { key: 'cancelCustomerPayments', label: 'Cancel customer payments', hint: 'Customer page: the Cancel button on a debt payment' },
  { key: 'takeDebtPayments', label: 'Take debt payments', hint: 'Customer page: Pay Debt' },
  { key: 'walletMoney', label: 'Wallet deposit & withdraw', hint: 'Customer page: Add Deposit, Withdraw, Pay debt from wallet' },
  { key: 'customerReturns', label: 'Customer returns', hint: 'Sales invoices: Return items' },
  { key: 'changeOpeningDebt', label: 'Change opening debt', hint: "Customers: change what a customer owed before the system" },
  { key: 'customersSheet', label: 'Customers sheet (Edit / Add Many)', hint: "Customers page: Edit / Add Many in a sheet" },
  { key: 'openingBalances', label: 'Supplier opening balances (add and sheet)', hint: "Purchase Invoices: add what was owed to suppliers before this system" },
  { key: 'vendorBalances', label: 'Vendor Balances', hint: "Purchase Invoices: Vendor Balances (plan which suppliers to pay)" },
  { key: 'transferInvoices', label: 'Move invoices to another customer', hint: 'Customer page: move an invoice put on the wrong customer to the right one' },
  { key: 'createCustomers', label: 'Add new customers', hint: "POS and Customers page: add a new customer" },
  { key: 'paySuppliers', label: 'Pay suppliers', hint: "Purchase Invoices and Vendor Balances: pay a supplier" },
  { key: 'editItemQuantity', label: 'Change item quantity in Inventory', hint: "Inventory → Edit item: change the quantity" },
  { key: 'salaries', label: 'Salaries', hint: "Salaries page: make and pay the salary sheet" },
  { key: 'partners', label: 'Partners / Investors', hint: "Partners / Investors page" },
  { key: 'fixedAssets', label: 'Fixed Assets', hint: "Fixed Assets page and Fixed Asset Wallet" },
  { key: 'zakat', label: 'Zakat Calculator', hint: "Zakat Calculator page" },
  { key: 'editWallet', label: 'Edit customer wallet balance', hint: "Customer page: set the wallet balance by hand" },
  { key: 'deleteStockAdjustments', label: 'Delete stock adjustments', hint: "Stock Adjustment page: delete (undo) an adjustment" },
  { key: 'companyWallet', label: 'Company Wallet (take money from branches)', hint: "Company Wallet page: take money from branches" },
  { key: 'walletTakesReport', label: 'Company Wallet report (money taken & from which account)', hint: "Company Wallet report: what was taken and from which account" },
  { key: 'staffDailyDelete', label: 'Delete invoices & payments in Staff Daily', hint: "Staff Daily report: the Delete button on invoices and payments" },
  { key: 'offsets', label: 'Customer ↔ Supplier (offset balances)', hint: "Customer ↔ Supplier page: settle what a customer who is also a supplier owes against what we owe them" },
  { key: 'cancelVendorPayments', label: 'Cancel supplier payments (Vendor Balances)', hint: "Vendor Balances: cancel a paid sheet (the money goes back to the account)" },
  { key: 'editClosedInvoices', label: 'Edit invoices after Close Day', hint: "Sales invoices: edit an invoice after the day was closed" },
  { key: 'changeLockedInvoices', label: 'Change invoices an admin corrected', hint: 'Sales invoices: edit or cancel an invoice the Super Admin or an admin corrected' },
  { key: 'itemsSoldReport', label: 'Items Sold', hint: 'Items Sold page: what was sold, day by day, week or month' },
  { key: 'refundsReport', label: 'Refunds', hint: 'Refunds page: money given back to customers on returns and cancels' },
  { key: 'merchantVatReport', label: 'Merchant VAT', hint: 'Merchant VAT page: VAT the merchant kept from customer payments' },
  { key: 'editSuppliers', label: 'Edit suppliers (name & phone)', hint: "Suppliers: the Edit button -- name and phone (email, address and notes: admins)" },
  { key: 'itemReport', label: 'Item Report', hint: "Item Report page: one item's in / out, from which supplier, and which customers took it" },
  { key: 'mergeItems', label: 'Merge items / move batches', hint: 'Inventory → View: "Merge into…" (an item entered twice) and "Move" on a batch put on the wrong item' },
  { key: 'customerLoans', label: 'Lend money to customers', hint: 'Customer page: "Give Loan" -- cash out of an account, added to what the customer owes; and cancel a loan' },
  { key: 'manualEntryStock', label: 'Manual Entry: add goods to stock', hint: 'Supplier Invoices → Manual Entry Invoice → "Add to stock": the goods go into Inventory (no need for the Stock page)' },
  { key: 'creditLimits', label: 'Credit limits', hint: 'Customers: the Credit limit window and the Credit limits sheet (many customers at once)' },
  { key: 'editSupplierInvoices', label: 'Edit supplier invoices', hint: 'Supplier Invoices: the Edit button (serial, supplier, costs, discount, selling prices). Not Delete.' },
  { key: 'staffDailyReport', label: 'Staff Daily', hint: "Staff Daily page: each person's sales and money, day by day" },
];

// The permissions as shown in the user form: grouped by part of the shop,
// the page first, then what can be done in it. A key not listed here still
// shows, under "Other", so nothing is ever hidden.
export const PERMISSION_GROUPS = [
  { title: 'Sales', keys: ['pos', 'quotations', 'createItems', 'editInvoices', 'cancelInvoices', 'editClosedInvoices', 'changeLockedInvoices', 'transferInvoices', 'customerReturns'] },
  { title: 'Customers', keys: ['customers', 'createCustomers', 'editCustomers', 'deleteCustomers', 'customersSheet', 'changeOpeningDebt', 'creditLimits', 'takeDebtPayments', 'cancelCustomerPayments', 'walletMoney', 'editWallet', 'customerLoans', 'offsets'] },
  { title: 'Stock & Inventory', keys: ['stock', 'inventory', 'categories', 'editItems', 'deleteItems', 'editItemQuantity', 'mergeItems', 'stockAdjustments', 'deleteStockAdjustments'] },
  { title: 'Suppliers & Purchases', keys: ['suppliers', 'editSuppliers', 'deleteSuppliers', 'supplierInvoices', 'editSupplierInvoices', 'manualEntryStock', 'purchases', 'editPurchases', 'deletePurchases', 'openingBalances', 'vendorBalances', 'paySuppliers', 'cancelVendorPayments'] },
  { title: 'Money', keys: ['accounts', 'editAccounts', 'expenses', 'cancelExpenses', 'salaries', 'companyWallet', 'walletTakesReport'] },
  { title: 'Reports & Owners', keys: ['reports', 'itemReport', 'itemsSoldReport', 'refundsReport', 'merchantVatReport', 'staffDailyReport', 'staffDailyDelete', 'partners', 'fixedAssets', 'zakat'] },
];

// The same permissions in Somali (the user form can show either language).
export const PERMISSION_SO = {
  stock: ['Stock', 'Bogga Stock: alaab cusub iyo qiimahooda (tirada alaabta waxay ka timaadaa Supplier Invoices)'],
  stockAdjustments: ['Stock Adjustment', 'Bogga Stock Adjustment: alaab dhumatay, dhacday (expired), lumay ama la tiriyay'],
  inventory: ['Inventory', 'Bogga Inventory: arag alaabta, qiimahooda iyo tiradooda'],
  categories: ['Qeybaha (Categories)', 'Bogga Categories: kooxaha alaabta'],
  pos: ['Iibiye / POS', 'Bogga Seller / POS: samee invoice-yada iibka'],
  quotations: ['Quotation', 'Bogga Quotation: samee, wax ka beddel oo u beddel invoice'],
  purchases: ['Purchase Invoices', 'Bogga Purchase Invoices: lacagta suppliers-ka lagu leeyahay'],
  accounts: ['Accounts', 'Bogga Accounts: haraaga xisaabaadka iyo statement-yadooda'],
  customers: ['Macaamiisha (Customers)', 'Bogga Customers: macaamiisha, invoice-yadooda iyo deynta'],
  suppliers: ['Suppliers', 'Bogga Suppliers'],
  supplierInvoices: ['Supplier Invoices', 'Bogga Supplier Invoices: warqadaha invoice-ka ee supplier-ka'],
  reports: ['Warbixinada (Reports)', 'Bogga Reports: iibka, P&L, Balance Sheet (warbixinada kale permission u gaar ah ayey leeyihiin hoos)'],
  expenses: ['Kharashaadka (Expenses)', 'Bogga Expenses: qor oo bixi kharashaadka'],
  createItems: ['Alaab cusub ka samee POS', 'POS: badhanka "+ New item" marka alaabtu aysan stock-ga ku jirin'],
  cancelInvoices: ['Cancel garee invoice-yada', 'Invoice-yada iibka: badhanka Cancel'],
  editInvoices: ['Edit garee invoice-yada', 'Invoice-yada iibka: badhanka Edit (ka hor Close Day)'],
  editCustomers: ['Edit garee macaamiisha', 'Customers: badhanka Edit (magac, phone…) iyo wallet auto-pay'],
  deleteCustomers: ['Tirtir macaamiisha', 'Customers: badhanka Delete'],
  editItems: ['Edit garee alaabta', 'Inventory iyo Categories: badhanka Edit (magac, qiime, category…)'],
  deleteItems: ['Tirtir alaabta', 'Inventory iyo Categories: badhanka Delete'],
  deleteSuppliers: ['Tirtir suppliers-ka', 'Suppliers: badhanka Delete'],
  editPurchases: ['Edit garee purchase invoices', 'Purchase Invoices: badhanka Edit, iyo wax ka beddelka lacag lagu bixiyay'],
  deletePurchases: ['Tirtir / void purchase invoices', 'Purchase Invoices: Delete, Void, celi lacag la bixiyay, cancel bulk payment'],
  editAccounts: ['Edit garee xisaabaadka', 'Accounts: badhanka Edit ee xisaab'],
  cancelExpenses: ['Cancel garee kharashaadka', 'Expenses: badhanka Void (cancel)'],
  cancelCustomerPayments: ['Cancel garee lacagaha macaamiisha', 'Bogga macmiilka: badhanka Cancel ee lacag deyn ah'],
  takeDebtPayments: ['Qaado lacagta deynta', 'Bogga macmiilka: Pay Debt'],
  walletMoney: ['Wallet: dhigasho & la bixid', 'Bogga macmiilka: Add Deposit, Withdraw, deyn ka bixi wallet-ka'],
  customerReturns: ['Alaab celin (returns)', 'Invoice-yada iibka: Return items'],
  changeOpeningDebt: ['Beddel deynta hore (opening)', 'Customers: beddel inta macmiilku lahaa ka hor system-ka'],
  customersSheet: ['Sheet-ka macaamiisha (Edit / Add Many)', 'Bogga Customers: Edit / Add Many sheet ahaan'],
  openingBalances: ['Haraaga hore ee suppliers-ka (add iyo sheet)', 'Purchase Invoices: ku dar inta suppliers lagu lahaa ka hor system-ka'],
  vendorBalances: ['Vendor Balances', 'Purchase Invoices: Vendor Balances (qorshee suppliers-ka la bixinayo)'],
  transferInvoices: ['U wareeji invoice macmiil kale', 'Bogga macmiilka: invoice lagu qoray macmiil khaldan u wareeji kan saxda ah'],
  createCustomers: ['Ku dar macaamiil cusub', 'POS iyo bogga Customers: ku dar macmiil cusub'],
  paySuppliers: ['Bixi suppliers-ka', 'Purchase Invoices iyo Vendor Balances: lacag sii supplier'],
  editItemQuantity: ['Beddel tirada alaabta Inventory', 'Inventory → Edit item: beddel tirada'],
  salaries: ['Mushaharka (Salaries)', 'Bogga Salaries: samee oo bixi sheet-ka mushaharka'],
  partners: ['Shuraakada / Maalgashadayaasha', 'Bogga Partners / Investors'],
  fixedAssets: ['Hantida go\'an (Fixed Assets)', 'Bogga Fixed Assets iyo Fixed Asset Wallet'],
  zakat: ['Xisaabiyaha Zakada', 'Bogga Zakat Calculator'],
  editWallet: ['Edit garee haraaga wallet-ka macmiilka', 'Bogga macmiilka: gacanta ku qor haraaga wallet-ka'],
  deleteStockAdjustments: ['Tirtir stock adjustments', 'Bogga Stock Adjustment: tirtir (ka noqo) adjustment'],
  companyWallet: ['Company Wallet (lacag ka qaado laamaha)', 'Bogga Company Wallet: lacag ka qaado laamaha (branches)'],
  walletTakesReport: ['Warbixinta Company Wallet', 'Warbixinta Company Wallet: maxaa la qaatay iyo xisaabtee laga qaatay'],
  staffDailyDelete: ['Tirtir invoice & lacag Staff Daily', 'Warbixinta Staff Daily: badhanka Delete ee invoice-yada iyo lacagaha'],
  offsets: ['Customer ↔ Supplier (isku dhig haraaga)', 'Bogga Customer ↔ Supplier: macmiil supplier-na ah, inta uu na leeyahay ka goo inta aan isaga leenahay'],
  cancelVendorPayments: ['Cancel garee lacagaha suppliers (Vendor Balances)', 'Vendor Balances: cancel sheet la bixiyay (lacagtu xisaabta ayey ku noqonaysaa)'],
  editClosedInvoices: ['Edit garee invoice ka dib Close Day', 'Invoice-yada iibka: edit invoice maalintiisa la xiray'],
  changeLockedInvoices: ['Beddel invoice admin saxay', 'Invoice-yada iibka: edit ama cancel invoice uu saxay Super Admin ama admin'],
  itemsSoldReport: ['Alaabta la iibiyay (Items Sold)', 'Bogga Items Sold: maxaa la iibiyay, maalin, toddobaad ama bil'],
  refundsReport: ['Lacag celinta (Refunds)', 'Bogga Refunds: lacagta macaamiisha loo celiyay returns iyo cancel'],
  merchantVatReport: ['Merchant VAT', 'Bogga Merchant VAT: VAT-ka merchant-ku ka jaray lacagaha macaamiisha'],
  editSuppliers: ['Edit garee suppliers (magac & phone)', 'Suppliers: badhanka Edit -- magac iyo phone (email, address iyo notes: admins)'],
  itemReport: ['Item Report', 'Bogga Item Report: alaab keliya soo gal / ka bax, supplier-kee ka timid, macaamiishee qaateen'],
  mergeItems: ['Isku dar alaab / wareeji batch', 'Inventory → View: "Merge into…" (alaab laba jeer la galiyay) iyo "Move" batch alaab khaldan lagu qoray'],
  customerLoans: ['Lacag amaahi macaamiisha', 'Bogga macmiilka: "Give Loan" -- lacag xisaab ka baxda, ku darsan deynta macmiilka; iyo cancel amaah'],
  manualEntryStock: ['Manual Entry: alaab ku dar stock-ga', 'Supplier Invoices → Manual Entry Invoice → "Add to stock": alaabtu Inventory ayey gashaa'],
  creditLimits: ['Xadka deynta (Credit limits)', 'Customers: daaqadda Credit limit iyo sheet-ka Credit limits (macaamiil badan hal mar)'],
  editSupplierInvoices: ['Edit garee supplier invoices', 'Supplier Invoices: badhanka Edit (serial, supplier, cost, discount, qiimaha iibka). Delete maaha.'],
  staffDailyReport: ['Staff Daily', 'Bogga Staff Daily: qof kasta iibkiisa iyo lacagtiisa, maalin maalin'],
};
export const GROUP_TITLES_SO = {
  Sales: 'Iibka',
  Customers: 'Macaamiisha',
  'Stock & Inventory': 'Stock & Inventory',
  'Suppliers & Purchases': 'Suppliers & Iibsiga',
  Money: 'Lacagta',
  'Reports & Owners': 'Warbixinada & Milkiilayaasha',
  Other: 'Kale',
};

// `modules` (from PERMISSION_MODULES, maybe filtered) split into the groups
// above, empty groups left out.
export function groupPermissions(modules) {
  const byKey = new Map(modules.map((m) => [m.key, m]));
  const listed = new Set(PERMISSION_GROUPS.flatMap((g) => g.keys));
  const groups = PERMISSION_GROUPS.map((g) => ({ title: g.title, modules: g.keys.map((k) => byKey.get(k)).filter(Boolean) }));
  groups.push({ title: 'Other', modules: modules.filter((m) => !listed.has(m.key)) });
  return groups.filter((g) => g.modules.length);
}

export const ROLES =['admin', 'manager', 'cashier', 'custom'];

// What a user may do. The server sends each user's real list: a branch admin
// has everything except what the Super Admin took away; anyone else what an
// admin switched on. The Super Admin always has everything. (The server
// checks all of this too.)
export function hasPermission(user, moduleKey) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return (user.permissions || []).includes(moduleKey);
}

// Abilities a branch admin has only when the Super Admin turns them on (off
// by default).
export const ADMIN_OPT_IN = ['customerLoans', 'mergeItems', 'changeLockedInvoices', 'editClosedInvoices', 'cancelVendorPayments', 'transferInvoices', 'createCustomers', 'paySuppliers', 'editItemQuantity', 'salaries', 'editWallet', 'deleteStockAdjustments', 'companyWallet', 'staffDailyDelete', 'walletTakesReport'];
// Other staff are never given these.
// Admins only: no other staff member can be given these.
const STAFF_NEVER = ['companyWallet', 'walletTakesReport'];
// Only the Super Admin hands these out.
const SUPER_ADMIN_GRANTS = ['companyWallet', 'walletTakesReport'];

// Abilities that only mean something inside another module.
const PART_OF = {
  takeDebtPayments: 'customers',
  walletMoney: 'customers',
  changeOpeningDebt: 'customers',
  editCustomers: 'customers',
  deleteCustomers: 'customers',
  cancelCustomerPayments: 'customers',
  editItems: 'inventory',
  deleteItems: 'inventory',
  deleteSuppliers: 'suppliers',
  editPurchases: 'purchases',
  deletePurchases: 'purchases',
  editAccounts: 'accounts',
  cancelExpenses: 'expenses',
  customersSheet: 'customers',
  createItems: 'pos',
  openingBalances: 'purchases',
  vendorBalances: 'purchases',
  paySuppliers: 'purchases',
  editWallet: 'customers',
  deleteStockAdjustments: 'stockAdjustments',
  editSuppliers: 'suppliers',
  mergeItems: 'inventory',
  customerLoans: 'customers',
  manualEntryStock: 'supplierInvoices',
  creditLimits: 'customers',
  editSupplierInvoices: 'supplierInvoices',
};

// What `user` may hand out to someone else: what they may do themselves,
// leaving out abilities whose module they do not have.
export const canGrant = (user, moduleKey) => !STAFF_NEVER.includes(moduleKey) && (!SUPER_ADMIN_GRANTS.includes(moduleKey) || !!user?.isSuperAdmin) && hasPermission(user, moduleKey) && (!PART_OF[moduleKey] || hasPermission(user, PART_OF[moduleKey]));

// Changing or removing saved records: one permission per area.
export const can = (user, key) => hasPermission(user, key);

// Clear All / Import Excel buttons: the Super Admin only, and only once
// switched on in Settings.
// With branches: only in the branches switched on there.
export const showBulkTools = (user) => {
  if (!user?.isSuperAdmin) return false;
  let branch = '';
  try {
    branch = localStorage.getItem('pos_branch') || '';
  } catch {
    branch = '';
  }
  if (branch) return (user.bulkToolsBranches || []).map(String).includes(String(branch));
  return !!user.showBulkTools;
};

// An invoice the Super Admin edited: only they, or someone given the
// permission, may edit or cancel it again (everyone still sees it).
export function canChangeInvoice(user, sale) {
  if (user?.isSuperAdmin || hasPermission(user, 'changeLockedInvoices')) return true;
  if (sale?.lockedBySuperAdmin) return false;
  // An admin's correction: other admins may change it, staff may not.
  if (sale?.lockedByAdmin) return user?.role === 'admin';
  return true;
}

// Whether the Edit button shows for an invoice. Today's invoices (still to
// be counted by Close Day) need Edit invoices; one from a day already closed
// also needs "Edit invoices after Close Day".
export function canEditInvoice(user, sale) {
  if (!sale || sale.status === 'CANCELLED' || !canChangeInvoice(user, sale) || !hasPermission(user, 'editInvoices')) return false;
  const closed = sale.status === 'CONFIRMED' && !sale.awaitingDayClose;
  return !closed || hasPermission(user, 'editClosedInvoices');
}
