import { ApiError } from './ApiError.js';

// People sign in with their email. It is stored, lowercase, in the user's
// `username` field (unique), so nothing else in the data had to change.
// Users created before this keep signing in with their old username until an
// admin gives them an email on the Users page.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isEmail = (value) => typeof value === 'string' && value.length <= 254 && EMAIL.test(value);

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address, like name@example.com.');
  return email;
}
