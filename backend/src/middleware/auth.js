import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User, { userHas } from '../models/User.js';
import Branch from '../models/Branch.js';
import { runWithBranch } from '../services/branchContext.js';
import { ApiError } from '../utils/ApiError.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new ApiError(401, 'You are not logged in. Please log in again.');

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }

    // A token names its user by a plain id, nothing else.
    if (typeof payload?.sub !== 'string' || !mongoose.isValidObjectId(payload.sub)) {
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }
    const user = await User.findById(payload.sub).select('-passwordHash');
    if (!user || !user.active) {
      throw new ApiError(401, 'Your account is no longer active. Please contact an administrator.');
    }
    // Signed in before the password was last changed: sign in again.
    // (iat is in whole seconds, so allow the second it was changed in.)
    if (user.passwordChangedAt && (payload.iat || 0) * 1000 < user.passwordChangedAt.getTime() - 1000) {
      throw new ApiError(401, 'Your password was changed. Please log in again.');
    }

    req.user = user;
    const denied = changeNotAllowed(req, user);
    if (denied) throw new ApiError(403, denied);
    // Every request runs in one branch: the user's own, or for the Super
    // Admin the branch they switched to (X-Branch-Id), else the first one.
    // With no branches at all, nothing is filtered (single-shop mode).
    const branches = await activeBranchIds();
    let branch = null;
    if (branches.length) {
      if (user.isSuperAdmin) {
        const wanted = String(req.headers['x-branch-id'] || '');
        if (wanted === 'all' && (isAllBranchesRead(req) || isCompanyWideWrite(req))) {
          // Reports for the whole company: nothing filtered, read-only.
          req.branchId = 'all';
          return runWithBranch(null, () => next());
        }
        if (wanted === 'all' && isOverviewOnlyWrite(req)) {
          throw new ApiError(400, 'You are viewing all branches. Open a branch first to make changes.');
        }
        branch = branches.includes(wanted) ? wanted : branches[0];
      } else {
        if (!user.branch || !branches.includes(String(user.branch))) {
          throw new ApiError(403, 'Your user is not assigned to an open branch. Please contact the Super Admin.');
        }
        branch = String(user.branch);
      }
    }
    req.branchId = branch;
    runWithBranch(branch, () => next());
  } catch (err) {
    next(err);
  }
}

// Changing or removing what is already saved needs the permission for that
// area -- one each (customers, items, suppliers, purchases, accounts,
// expenses, payments...), so nothing overlaps. A branch admin has them unless
// the Super Admin took one away; anyone else when given. Areas with their own
// page permission and role checks (salaries, partners, fixed assets...) need
// nothing more here; a path not listed is for admins only. Invoices keep
// their own switches ('editInvoices', 'cancelInvoices'). Returns the refusal
// message, or null.
const EDIT_AREAS = [
  [/^\/api\/customers\//, 'editCustomers'],
  [/^\/api\/(inventory|categories)\//, 'editItems'],
  [/^\/api\/suppliers\//, 'editSuppliers'],
  [/^\/api\/purchases\//, 'editPurchases'],
  [/^\/api\/accounts\//, 'editAccounts'],
];
const DELETE_AREAS = [
  [/^\/api\/customers\/[^/]+\/payments\/[^/]+\/cancel$/, 'cancelCustomerPayments'],
  [/^\/api\/customers\//, 'deleteCustomers'],
  [/^\/api\/(inventory|categories)\//, 'deleteItems'],
  [/^\/api\/suppliers\//, 'deleteSuppliers'],
  [/^\/api\/purchases\//, 'deletePurchases'],
  [/^\/api\/expenses\//, 'cancelExpenses'],
];
// Areas whose routes already check their own page permission and role.
const OWN_CHECKS = /^\/api\/(sales|quotations|supplier-invoice-archives|stock-adjustments|salaries|partners|fixed-assets|liabilities|zakat|commissions|offsets|company-wallets|users|branches|chat)\//;

export function changeNotAllowed(req, user) {
  if (user.isSuperAdmin) return null;
  // Express matches routes ignoring case and a trailing slash, so the checks
  // below must too: ".../VOID" or ".../void/" is still a void.
  const path = String(req.originalUrl || '').split('?')[0].toLowerCase().replace(/\/+$/, '');
  const method = req.method;
  const ask = user.role === 'admin' ? 'Ask the Super Admin' : 'Ask an admin';
  const needs = (areas, verb) => {
    if (OWN_CHECKS.test(path)) return null;
    const hit = areas.find(([re]) => re.test(path));
    if (!hit) return user.role === 'admin' ? null : `Only an admin can ${verb} this.`;
    return userHas(user, hit[1]) ? null : `You are not allowed to ${verb} this. ${ask} to give you permission to ${verb} it.`;
  };
  if (method === 'PUT' || method === 'PATCH') {
    // A working sheet saved as a draft, not an edit of a saved record.
    if (path === '/api/purchases/payment-plan') return null;
    // Routes with their own permission check.
    if (/^\/api\/customers\/[^/]+\/(opening-balance|wallet\/balance|credit-limit)$/.test(path)) return null;
    return needs(EDIT_AREAS, 'edit');
  }
  if (method === 'DELETE') return needs(DELETE_AREAS, 'delete');
  if (method === 'POST' && /\/(cancel|reverse|void|remove)$/.test(path)) {
    // Routes with their own permission check.
    if (/^\/api\/customers\/[^/]+\/loans\/[^/]+\/cancel$/.test(path)) return null;
    if (/^\/api\/purchases\/payment-plans\/[^/]+\/cancel$/.test(path)) return null;
    return needs(DELETE_AREAS, 'cancel or remove');
  }
  return null;
}

// The Super Admin's "all branches" view covers reading reports only (and the
// lookups report screens use); anything else always runs in one branch, so
// nothing can ever be written without a branch.
const ALL_BRANCHES_READS = ['/api/reports', '/api/quotations', '/api/sales', '/api/customers/search', '/api/partners', '/api/commissions', '/api/zakat', '/api/chat', '/api/inventory/alerts/popup'];
function isAllBranchesRead(req) {
  return req.method === 'GET' && ALL_BRANCHES_READS.some((p) => req.originalUrl.startsWith(p));
}
// Year-end profit sharing is company-wide: from the overview it shares every
// branch's combined profit between all partners.
// The Super Admin's chat from the overview reaches every branch.
const COMPANY_WIDE_WRITES = ['/api/partners/profit-sharing', '/api/chat', '/api/zakat/all-branches', '/api/commissions/all-branches'];
function isCompanyWideWrite(req) {
  return req.method !== 'GET' && COMPANY_WIDE_WRITES.some((p) => req.originalUrl.startsWith(p));
}
// Pages the overview shows read-only: a change there must name a branch,
// never silently land in the first one.
const OVERVIEW_ONLY = ['/api/partners', '/api/commissions', '/api/zakat'];
function isOverviewOnlyWrite(req) {
  return req.method !== 'GET' && OVERVIEW_ONLY.some((p) => req.originalUrl.startsWith(p));
}

// Open branch ids, oldest first; cached briefly (branches rarely change).
let branchCache = { at: 0, ids: [] };
export async function activeBranchIds({ fresh = false } = {}) {
  if (!fresh && Date.now() - branchCache.at < 5000) return branchCache.ids;
  const ids = (await Branch.find({ active: true }).sort({ createdAt: 1 }).select('_id')).map((b) => String(b._id));
  branchCache = { at: Date.now(), ids };
  return ids;
}
export function clearBranchCache() {
  branchCache = { at: 0, ids: [] };
}

// Only the Super Admin (all branches).
export function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) return next(new ApiError(403, 'Only the Super Admin can do this.'));
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action.'));
    }
    next();
  };
}

// Backend enforcement of per-user module permissions -- the actual security
// boundary. Frontend nav/route hiding is only a UX convenience; a request
// that reaches the server is always re-checked here against the live user
// record requireAuth just fetched, so a revoked permission takes effect on
// this user's very next request, no re-login required.
// Several modules mean any one of them is enough.
export function requirePermission(...moduleKeys) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'You are not logged in. Please log in again.'));
    if (moduleKeys.some((key) => userHas(req.user, key))) return next();
    return next(new ApiError(403, 'You do not have permission to access this module.'));
  };
}
