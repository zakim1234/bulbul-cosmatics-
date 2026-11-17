import { ApiError } from './ApiError.js';

// Slows down password guessing. After 5 wrong passwords for one username
// from one address, that pair is locked for 15 minutes; after 20 wrong
// passwords from one address (any usernames), the address is locked. A
// successful login clears its username's count. Kept in memory: a restart
// clears it, which is fine for a single server.
const WINDOW_MS = 15 * 60 * 1000;
const PER_USER = 5;
const PER_ADDRESS = 20;

const failures = new Map(); // key -> { count, first, lockedUntil }

function entry(key, now) {
  const e = failures.get(key);
  if (!e || (now - e.first > WINDOW_MS && !(e.lockedUntil > now))) return { count: 0, first: now, lockedUntil: 0 };
  return e;
}

function locked(key, now) {
  const e = failures.get(key);
  return e && e.lockedUntil > now ? e.lockedUntil : 0;
}

export function assertLoginAllowed(ip, username) {
  const now = Date.now();
  const until = Math.max(locked(`u:${ip}|${username}`, now), locked(`a:${ip}`, now));
  if (until) {
    const minutes = Math.ceil((until - now) / 60000);
    throw new ApiError(429, `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

// Without the visitor's real address (nginx not passing X-Forwarded-For),
// every login looks like it comes from the server itself: then only the
// per-username limit applies, so one person cannot lock everybody out.
const unknownAddress = (ip) => !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export function recordLoginFailure(ip, username) {
  const now = Date.now();
  const keys = [[`u:${ip}|${username}`, PER_USER]];
  if (!unknownAddress(ip)) keys.push([`a:${ip}`, PER_ADDRESS]);
  for (const [key, limit] of keys) {
    const e = entry(key, now);
    e.count += 1;
    if (e.count >= limit) e.lockedUntil = now + WINDOW_MS;
    failures.set(key, e);
  }
  // Keep the map small: drop entries that have expired.
  if (failures.size > 5000) {
    for (const [key, e] of failures) if (now - e.first > WINDOW_MS && !(e.lockedUntil > now)) failures.delete(key);
  }
}

export function clearLoginFailures(ip, username) {
  failures.delete(`u:${ip}|${username}`);
}

// For tests.
export function resetLoginGuard() {
  failures.clear();
}
