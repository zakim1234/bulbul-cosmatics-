import bcrypt from 'bcryptjs';
import { ApiError } from './ApiError.js';

export const MIN_PASSWORD_LENGTH = 8;

// Every new or changed password: a real string of 8 to 200 characters.
export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 200) throw new ApiError(400, 'Password is too long (200 characters max).');
}

// Sets a new password. Sign-ins made before now stop working (requireAuth
// compares the token's time with passwordChangedAt), so whoever knew the old
// password is logged out everywhere.
export async function setPassword(user, password) {
  checkPassword(password);
  user.passwordHash = await bcrypt.hash(password, 10);
  user.passwordChangedAt = new Date();
}
