import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import User, { effectivePermissions } from '../models/User.js';
import Branch from '../models/Branch.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { assertLoginAllowed, recordLoginFailure, clearLoginFailures } from '../utils/loginGuard.js';
import { checkPassword, setPassword } from '../utils/password.js';
import { isEmail, normalizeEmail } from '../utils/email.js';

// A hash of a random value, same cost as real passwords (10): compared
// against when the email is unknown. It can never match anything typed.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), 10);

function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
}

function sanitize(user) {
  return {
    id: user._id,
    username: user.username,
    email: isEmail(user.username) ? user.username : '',
    name: user.name,
    role: user.role,
    // What this user may really do (a branch admin: everything except what
    // the Super Admin took away), so the frontend shows exactly that.
    permissions: effectivePermissions(user),
    isSuperAdmin: !!user.isSuperAdmin,
    // Super Admin setting: show the Clear All and Import Excel buttons.
    showBulkTools: !!(user.isSuperAdmin && user.showBulkTools),
    bulkToolsBranches: user.isSuperAdmin ? (user.bulkToolsBranches || []).map(String) : [],
    branch: user.branch || null,
  };
}

export const login = asyncHandler(async (req, res) => {
  // People sign in with their email (users without one yet: their old
  // username). Plain text only: an object ({ "$ne": null }) is refused.
  const { password } = req.body;
  const login = req.body.email ?? req.body.username;
  if (typeof login !== 'string' || typeof password !== 'string' || !login.trim() || !password) {
    throw new ApiError(400, 'Please enter your email and password.');
  }
  const name = login.trim().toLowerCase().slice(0, 254);
  assertLoginAllowed(req.ip, name);

  const user = await User.findOne({ username: name });
  // The password is always checked, even for an unknown email, so the answer
  // takes as long either way and does not reveal which emails have accounts.
  const checked = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
  const valid = !!user && user.active && checked;
  if (!valid) {
    recordLoginFailure(req.ip, name);
    throw new ApiError(401, 'Incorrect email or password.');
  }
  clearLoginFailures(req.ip, name);

  const token = signToken(user);
  res.json({ success: true, data: { token, user: sanitize(user) } });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: sanitize(req.user) });
});

export const register = asyncHandler(async (req, res) => {
  // Only for the very first admin account of a new install. After that,
  // users are added on the Users page (in a branch, and in the audit log).
  // Closed unless ALLOW_REGISTER=true: on a new or wiped database whoever
  // reached this first would become the admin. Use `npm run seed:admin`.
  if (process.env.ALLOW_REGISTER !== 'true') {
    throw new ApiError(403, 'Sign-up is closed. Create the first admin on the server with: npm run seed:admin');
  }
  if ((await User.countDocuments()) > 0) {
    throw new ApiError(403, 'Users are added on the Users page by an admin.');
  }
  const { password, name } = req.body;
  if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'Email, password and name are required.');
  const email = normalizeEmail(req.body.email ?? req.body.username);
  checkPassword(password);

  const user = new User({ username: email, name: name.trim(), role: 'admin', passwordHash: 'x' });
  await setPassword(user, password);
  await user.save();

  const token = signToken(user);
  res.status(201).json({ success: true, data: { token, user: sanitize(user) } });
});

// PUT /api/auth/settings { showBulkTools } -- the Super Admin's own settings.
export const updateMySettings = asyncHandler(async (req, res) => {
  if (!req.user.isSuperAdmin) throw new ApiError(403, 'Only the Super Admin has these settings.');
  const user = await User.findById(req.user._id);
  if (req.body.showBulkTools !== undefined) user.showBulkTools = !!req.body.showBulkTools;
  // One branch switched on or off: { branchId, enabled }.
  if (req.body.branchId !== undefined) {
    const id = String(req.body.branchId || '');
    if (!mongoose.isValidObjectId(id) || !(await Branch.exists({ _id: id }))) throw new ApiError(400, 'Branch not found.');
    const list = (user.bulkToolsBranches || []).map(String).filter((b) => b !== id);
    if (req.body.enabled) list.push(id);
    user.bulkToolsBranches = list;
    // With branches the setting is per branch only.
    user.showBulkTools = false;
  }
  await user.save();
  res.json({ success: true, data: sanitize(user) });
});
