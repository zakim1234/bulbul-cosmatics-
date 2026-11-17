import bcrypt from 'bcryptjs';
import User, { PERMISSION_MODULES, effectivePermissions, userHas, SUPER_ADMIN_GRANTS, expandLegacy } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logAudit } from '../services/auditService.js';
import { checkPassword, setPassword } from '../utils/password.js';
import { isEmail, normalizeEmail } from '../utils/email.js';
import Branch from '../models/Branch.js';

function toDTO(u) {
  return {
    id: u._id,
    username: u.username,
    // Signs in with this (users from before emails: empty until given one).
    email: isEmail(u.username) ? u.username : '',
    name: u.name,
    phone: u.phone || '',
    role: u.role,
    permissions: effectivePermissions(u),
    // Branch admins: the modules the Super Admin took away.
    adminDenied: u.role === 'admin' && !u.isSuperAdmin ? u.adminDenied || [] : [],
    adminGranted: u.role === 'admin' && !u.isSuperAdmin ? u.adminGranted || [] : [],
    active: u.active,
    branch: u.branch?._id || u.branch || null,
    branchName: u.branch?.name || '',
    isSuperAdmin: !!u.isSuperAdmin,
    createdAt: u.createdAt,
  };
}

// With branches, a branch admin only sees and manages their own branch's
// users; the Super Admin manages everyone. Without branches: everyone.
function userScope(req) {
  if (!req.branchId || req.user.isSuperAdmin) return {};
  return { branch: req.user.branch, isSuperAdmin: { $ne: true } };
}

// A branch admin (branches in use, not the Super Admin) manages only the
// staff of their own branch: they never create an admin, never make anyone
// an admin, and never change another admin -- only the Super Admin does.
// They may still change their own name and password.
const STAFF_ROLES = ['manager', 'cashier', 'custom'];
const isBranchAdmin = (req) => !!req.branchId && !req.user.isSuperAdmin;

function assertMayGiveRole(req, role) {
  if (isBranchAdmin(req) && !STAFF_ROLES.includes(role)) {
    throw new ApiError(403, 'Only the Super Admin can make someone an admin.');
  }
}

function assertMayManage(req, target) {
  if (isBranchAdmin(req) && target.role === 'admin' && !target._id.equals(req.user._id)) {
    throw new ApiError(403, 'Only the Super Admin can change an admin.');
  }
}

// Abilities that only mean something inside another module.
const PART_OF = { takeDebtPayments: 'customers', walletMoney: 'customers', changeOpeningDebt: 'customers', editCustomers: 'customers', deleteCustomers: 'customers', cancelCustomerPayments: 'customers', editItems: 'inventory', deleteItems: 'inventory', deleteSuppliers: 'suppliers', editPurchases: 'purchases', deletePurchases: 'purchases', editAccounts: 'accounts', cancelExpenses: 'expenses', customersSheet: 'customers', createItems: 'pos', openingBalances: 'purchases', vendorBalances: 'purchases', paySuppliers: 'purchases', editWallet: 'customers', deleteStockAdjustments: 'stockAdjustments' };

// A branch admin can only hand out what they may do themselves, and not an
// ability whose module they do not have (modules a staff member already has
// stay as they are).
function assertMayGrant(req, wanted, current = []) {
  if (!wanted) return;
  // Only the Super Admin hands these out.
  const superOnly = req.user.isSuperAdmin ? [] : wanted.filter((p) => SUPER_ADMIN_GRANTS.includes(p) && !current.includes(p));
  if (superOnly.length) throw new ApiError(403, `Only the Super Admin can give: ${superOnly.join(', ')}.`);
  if (!isBranchAdmin(req)) return;
  const mayGive = (p) => userHas(req.user, p) && (!PART_OF[p] || userHas(req.user, PART_OF[p]));
  const missing = wanted.filter((p) => !current.includes(p) && !mayGive(p));
  if (missing.length) throw new ApiError(403, `You cannot give what you are not allowed yourself: ${missing.join(', ')}.`);
}

async function resolveUserBranch(req, requested) {
  if (!req.branchId) return null; // no branches
  if (!req.user.isSuperAdmin) return req.user.branch;
  const id = requested || req.branchId;
  const branch = await Branch.findById(id);
  if (!branch) throw new ApiError(400, 'Choose a valid branch for this user.');
  return branch._id;
}

function validatePermissions(permissions) {
  if (permissions === undefined) return undefined;
  if (!Array.isArray(permissions)) throw new ApiError(400, 'Permissions must be a list.');
  // An old broad name (from a page not yet reloaded) means all of its parts.
  permissions = expandLegacy(permissions);
  for (const p of permissions) {
    if (!PERMISSION_MODULES.includes(p)) throw new ApiError(400, `"${p}" is not a valid permission module.`);
  }
  return [...new Set(permissions)];
}

export const listUsers = asyncHandler(async (req, res) => {
  const users = await User.find(userScope(req)).populate('branch', 'name').sort({ createdAt: -1 });
  const branchAdmin = isBranchAdmin(req);
  res.json({
    success: true,
    // What I may do here: a branch admin manages staff only (and themselves).
    rights: { canCreateAdmins: !branchAdmin, roles: branchAdmin ? STAFF_ROLES : ['admin', ...STAFF_ROLES] },
    data: users.map((u) => ({ ...toDTO(u), canManage: !(branchAdmin && u.role === 'admin' && !u._id.equals(req.user._id)) })),
  });
});

export const createUser = asyncHandler(async (req, res) => {
  const { password, name, role = 'cashier', permissions } = req.body;
  if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'Full name is required.');
  // Everyone signs in with their email.
  const email = normalizeEmail(req.body.email ?? req.body.username);
  checkPassword(password);
  if (!['admin', 'manager', 'cashier', 'custom'].includes(role)) throw new ApiError(400, 'Invalid role.');
  assertMayGiveRole(req, role);

  const existing = await User.findOne({ username: email });
  if (existing) throw new ApiError(409, 'That email is already used by another user.');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    username: email,
    passwordHash,
    name: name.trim(),
    phone: String(req.body.phone || '').trim().slice(0, 30),
    role,
    permissions: (() => {
      const wanted = validatePermissions(permissions) || [];
      assertMayGrant(req, wanted);
      return wanted;
    })(),
    branch: await resolveUserBranch(req, req.body.branchId),
    // A new branch admin: what the Super Admin does not let them do.
    adminDenied: role === 'admin' && req.user.isSuperAdmin ? validatePermissions(req.body.adminDenied) || [] : [],
    adminGranted: role === 'admin' && req.user.isSuperAdmin ? validatePermissions(req.body.adminGranted) || [] : [],
  });
  await user.populate('branch', 'name');

  await logAudit({ user: req.user, action: 'user.create', entityType: 'User', entityId: user._id, details: { username: user.username, role: user.role } });

  res.status(201).json({ success: true, data: toDTO(user) });
});

export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, ...userScope(req) });
  if (!user) throw new ApiError(404, 'User not found.');
  assertMayManage(req, user);

  const { name, role, permissions, password } = req.body;
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'Full name cannot be empty.');
    user.name = name.trim();
  }
  if (req.body.phone !== undefined) user.phone = String(req.body.phone || '').trim().slice(0, 30);
  if (role !== undefined) {
    if (!['admin', 'manager', 'cashier', 'custom'].includes(role)) throw new ApiError(400, 'Invalid role.');
    if (user._id.equals(req.user._id) && role !== 'admin' && user.role === 'admin') {
      throw new ApiError(400, 'You cannot remove your own admin role.');
    }
    if (role !== user.role) assertMayGiveRole(req, role);
    user.role = role;
  }
  const validated = validatePermissions(permissions);
  assertMayGrant(req, validated, user.permissions || []);
  if (validated !== undefined) user.permissions = validated;
  // A new email (also how a user from before emails gets one).
  if (req.body.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    if (email !== user.username) {
      if (await User.exists({ username: email, _id: { $ne: user._id } })) throw new ApiError(409, 'That email is already used by another user.');
      user.username = email;
    }
  }
  if (password !== undefined) await setPassword(user, password);
  // What a branch admin may do: only the Super Admin decides.
  if (req.body.adminDenied !== undefined) {
    if (!req.user.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin decides what a branch admin may do.');
    if (user.role !== 'admin' || user.isSuperAdmin) throw new ApiError(400, 'Only a branch admin has these settings.');
    user.adminDenied = validatePermissions(req.body.adminDenied);
  }
  if (req.body.adminGranted !== undefined) {
    if (!req.user.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin decides what a branch admin may do.');
    if (user.role !== 'admin' || user.isSuperAdmin) throw new ApiError(400, 'Only a branch admin has these settings.');
    user.adminGranted = validatePermissions(req.body.adminGranted);
  }

  if (req.body.branchId !== undefined && req.user.isSuperAdmin && !user.isSuperAdmin) user.branch = await resolveUserBranch(req, req.body.branchId);
  await user.save();
  await user.populate('branch', 'name');

  await logAudit({ user: req.user, action: 'user.update', entityType: 'User', entityId: user._id, details: { role: user.role, ...(req.body.adminDenied !== undefined ? { adminDenied: user.adminDenied } : {}), ...(req.body.adminGranted !== undefined ? { adminGranted: user.adminGranted } : {}) } });

  res.json({ success: true, data: toDTO(user) });
});

// PATCH /api/users/:id/active -- activate/deactivate. requireAuth re-fetches
// the user fresh on every request, so a deactivated user loses access on
// their very next request (no lingering session/JWT window), while every
// historical sale/action they created stays exactly as it is.
// DELETE /api/users/:id -- removes a user for good. Never yourself, never the
// Super Admin. What they did (sales, payments ...) keeps their name.
export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, ...userScope(req) });
  if (!user) throw new ApiError(404, 'User not found.');
  if (user._id.equals(req.user._id)) throw new ApiError(400, 'You cannot delete your own account.');
  if (user.isSuperAdmin) throw new ApiError(400, 'The Super Admin cannot be deleted.');
  assertMayManage(req, user);
  await User.deleteOne({ _id: user._id });
  await logAudit({ user: req.user, action: 'user.delete', entityType: 'User', entityId: user._id, details: { name: user.name, username: user.username, role: user.role } });
  res.json({ success: true, data: { id: user._id } });
});

export const setUserActive = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, ...userScope(req) });
  if (!user) throw new ApiError(404, 'User not found.');
  if (user._id.equals(req.user._id)) throw new ApiError(400, 'You cannot deactivate your own account.');
  assertMayManage(req, user);

  user.active = !!req.body.active;
  await user.save();

  await logAudit({ user: req.user, action: user.active ? 'user.activate' : 'user.deactivate', entityType: 'User', entityId: user._id, details: {} });

  res.json({ success: true, data: toDTO(user) });
});

export const listPermissionModules = asyncHandler(async (req, res) => {
  res.json({ success: true, data: PERMISSION_MODULES });
});
