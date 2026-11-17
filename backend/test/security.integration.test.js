import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Customer from '../src/models/Customer.js';
import { resetLoginGuard } from '../src/utils/loginGuard.js';

// Login attempt limit, plain-text login fields, register closed after the
// first admin, a password change signing out old logins, search text taken
// literally, and the protection headers.
test('SECURITY -- login limit, register closed, password change logs out, literal search, headers', { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/security_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-security-secret';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  resetLoginGuard();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const call = async (path, { body, token, method } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, headers: r.headers, ...(await r.json()) };
  };
  const login = (username, password) => call('/auth/login', { body: { username, password } });
  try {
    // Sign-up is closed unless the server turns it on (seed:admin is the way).
    delete process.env.ALLOW_REGISTER;
    const closed = await call('/auth/register', { body: { email: 'boss@example.com', name: 'Boss', password: 'first-admin-pass' } });
    assert.equal(closed.status, 403, 'closed by default, even on an empty database');
    assert.equal(await User.countDocuments(), 0);
    process.env.ALLOW_REGISTER = 'true';

    // A new install: the first admin registers; after that register is closed.
    assert.equal((await call('/auth/register', { body: { email: 'boss@example.com', name: 'Boss', password: 'short' } })).status, 400, '8 characters at least');
    const first = await call('/auth/register', { body: { email: 'boss@example.com', name: 'Boss', password: 'first-admin-pass' } });
    assert.equal(first.status, 201);
    assert.equal(first.data.user.role, 'admin');
    assert.equal((await call('/auth/register', { body: { email: 'other@example.com', name: 'Other', password: 'another-pass-1' } })).status, 403);
    assert.equal((await call('/auth/register', { body: { email: 'other@example.com', name: 'Other', password: 'another-pass-1' }, token: first.data.token })).status, 403, 'not even for an admin');

    // Only plain text logs in: an operator object is refused.
    assert.equal((await call('/auth/login', { body: { username: { $ne: null }, password: { $ne: null } } })).status, 400);

    // Five wrong passwords lock the username for a while -- even the right one.
    await User.create({ username: 'cali', name: 'Cali', role: 'cashier', passwordHash: await bcrypt.hash('right-password', 10) });
    for (let i = 0; i < 5; i += 1) assert.equal((await login('cali', `wrong-${i}`)).status, 401);
    const blocked = await login('cali', 'right-password');
    assert.equal(blocked.status, 429, JSON.stringify(blocked));
    assert.match(blocked.message, /Too many wrong passwords/);
    resetLoginGuard();
    // A success clears the count.
    for (let i = 0; i < 4; i += 1) await login('cali', `wrong-${i}`);
    assert.equal((await login('cali', 'right-password')).status, 200);
    assert.equal((await login('cali', 'wrong-again')).status, 401, 'counting starts again');

    // Changing a password signs out logins made before it.
    const old = (await login('cali', 'right-password')).data.token;
    assert.equal((await call('/auth/me', { token: old })).status, 200);
    const cali = await User.findOne({ username: 'cali' });
    const changed = await call(`/users/${cali.id}`, { method: 'PUT', body: { password: 'brand-new-pass' }, token: first.data.token });
    assert.equal(changed.status, 200, JSON.stringify(changed));
    await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole seconds
    const stale = await call('/auth/me', { token: jwt.sign({ sub: cali.id, iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET) });
    assert.equal(stale.status, 401);
    assert.match(stale.message, /password was changed/);
    assert.equal((await call('/auth/me', { token: (await login('cali', 'brand-new-pass')).data.token })).status, 200);
    assert.equal((await call(`/users/${cali.id}`, { method: 'PUT', body: { password: 'short' }, token: first.data.token })).status, 400);

    // Signing in with an email: new users must have one; case does not matter;
    // a changed email replaces the old one; no two users share one.
    const boss = first.data.token;
    assert.equal(first.data.user.email, 'boss@example.com');
    assert.equal((await call('/users', { body: { email: 'not-an-email', name: 'X', password: 'pass-12345', role: 'cashier' }, token: boss })).status, 400);
    assert.equal((await call('/users', { body: { email: 'Nuurto@Example.com', name: 'Nuurto Ali', password: 'pass-12345', role: 'cashier' }, token: boss })).status, 201);
    assert.equal((await call('/users', { body: { email: 'nuurto@example.com', name: 'Again', password: 'pass-12345', role: 'cashier' }, token: boss })).status, 409);
    const nuurto = await call('/auth/login', { body: { email: 'NUURTO@example.com', password: 'pass-12345' } });
    assert.equal(nuurto.status, 200);
    assert.deepEqual([nuurto.data.user.email, nuurto.data.user.name], ['nuurto@example.com', 'Nuurto Ali']);
    // A user from before emails (cali) signs in with the old username until given one.
    assert.equal((await call('/users', { method: 'GET', token: boss })).data.find((u) => u.username === 'cali').email, '');
    assert.equal((await call(`/users/${cali.id}`, { method: 'PUT', body: { email: 'cali@example.com' }, token: boss })).status, 200);
    assert.equal((await call('/auth/login', { body: { email: 'cali@example.com', password: 'brand-new-pass' } })).status, 200);
    assert.equal((await login('cali', 'brand-new-pass')).status, 401, 'the old username is gone');
    assert.equal((await call(`/users/${cali.id}`, { method: 'PUT', body: { email: 'nuurto@example.com' }, token: boss })).status, 409, 'taken');
    resetLoginGuard();

    // Search text is literal: regex characters neither run nor break it.
    await Customer.create({ name: 'Ali (shop)', phone: '61+2' });
    const admin = first.data.token;
    for (const path of ['/customers?search=', '/customers/search?q=', '/inventory?search=', '/inventory/search?q=', '/suppliers?search=', '/categories?search=']) {
      const r = await call(`${path}${encodeURIComponent('(a+)+$')}`, { token: admin });
      assert.equal(r.status, 200, `${path} ${JSON.stringify(r)}`);
    }
    assert.deepEqual((await call(`/customers/search?q=${encodeURIComponent('Ali (shop')}`, { token: admin })).data.map((c) => c.name), ['Ali (shop)']);
    assert.deepEqual((await call(`/customers/search?q=${encodeURIComponent('61+2')}`, { token: admin })).data.map((c) => c.name), ['Ali (shop)']);
    assert.equal((await call(`/customers/search?q=${encodeURIComponent('.*')}`, { token: admin })).data.length, 0, '".*" is not "anything"');

    // Protection headers; the framework is not announced.
    const h = (await call('/health')).headers;
    assert.equal(h.get('x-powered-by'), null);
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('cache-control'), 'no-store');
  } finally {
    delete process.env.ALLOW_REGISTER;
    resetLoginGuard();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
