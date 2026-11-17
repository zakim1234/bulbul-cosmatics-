import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Branch from '../src/models/Branch.js';

// A branch admin manages only the staff of their own branch -- never an
// admin, never anyone into an admin -- and the Super Admin decides what each
// branch admin may do.
test('BRANCH ADMIN RIGHTS -- staff only, no admins; the Super Admin limits a branch admin', { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/branch_admin_rights_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-branch-admin-secret';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const hodan = await Branch.create({ name: 'Hodan' });
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cali = await User.create({ username: 'cali', name: 'Cali', passwordHash: 'unused', role: 'admin', branch: hodan._id });
  const omar = await User.create({ username: 'omar', name: 'Omar', passwordHash: 'unused', role: 'admin', branch: hodan._id });
  const cumar = await User.create({ username: 'cumar', name: 'Cumar', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'accounts'], branch: hodan._id });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}`, ...(user.isSuperAdmin ? { 'X-Branch-Id': String(hodan._id) } : {}) },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, ...(await r.json()) };
  };
  const byCali = as(cali);
  const byOwner = as(owner);
  try {
    // Creating: staff yes, an admin no.
    assert.equal((await byCali('/users', { email: 'new.admin@example.com', name: 'New Admin', password: 'pass-12345', role: 'admin' })).status, 403);
    const made = await byCali('/users', { email: 'geedi@example.com', name: 'Geedi', password: 'pass-12345', role: 'cashier', permissions: ['pos'] });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.equal(made.data.branchName, 'Hodan', 'always in their own branch');

    // Never making anyone an admin; never changing another admin.
    assert.equal((await byCali(`/users/${made.data.id}`, { role: 'admin' }, 'PUT')).status, 403);
    assert.equal((await byCali(`/users/${omar.id}`, { password: 'taken-over-1' }, 'PUT')).status, 403);
    assert.equal((await byCali(`/users/${omar.id}`, { name: 'Renamed' }, 'PUT')).status, 403);
    assert.equal((await byCali(`/users/${omar.id}/active`, { active: false }, 'PATCH')).status, 403);
    // Their own name and password: yes. Their own limits: no.
    assert.equal((await byCali(`/users/${cali.id}`, { name: 'Cali Ahmed', role: 'admin' }, 'PUT')).status, 200);
    assert.equal((await byCali(`/users/${cali.id}`, { adminDenied: [] }, 'PUT')).status, 403);
    // The list tells the page who they may manage.
    const list = await byCali('/users');
    assert.deepEqual(list.rights.roles, ['manager', 'cashier', 'custom']);
    const canManage = Object.fromEntries(list.data.map((u) => [u.username, u.canManage]));
    assert.deepEqual([canManage.omar, canManage.cali, canManage.cumar], [false, true, true]);
    // The Super Admin still can do all of it.
    assert.equal((await byOwner(`/users/${made.data.id}`, { role: 'admin' }, 'PUT')).status, 200);

    // The Super Admin takes Accounts and Delete away from Cali.
    const limited = await byOwner(`/users/${cali.id}`, { adminDenied: ['accounts', 'deleteRecords'] }, 'PUT');
    assert.equal(limited.status, 200, JSON.stringify(limited));
    // The old broad "Delete records" is saved as every part of it.
    for (const k of ['accounts', 'deleteCustomers', 'deleteItems', 'deleteSuppliers', 'deletePurchases', 'cancelExpenses', 'cancelCustomerPayments']) assert.ok(limited.data.adminDenied.includes(k), k);
    const me = await byCali('/auth/me');
    assert.ok(!me.data.permissions.includes('accounts') && me.data.permissions.includes('pos'));
    assert.equal((await byCali('/accounts/report')).status, 403, 'no Accounts');
    const del = await byCali(`/customers/${new mongoose.Types.ObjectId()}`, undefined, 'DELETE');
    assert.equal(del.status, 403);
    assert.match(del.message, /Ask the Super Admin/);
    assert.equal((await as(omar)('/accounts/report')).status, 200, 'other admins keep everything');
    // Cali cannot hand out what was taken from them; what staff already have stays.
    assert.equal((await byCali(`/users/${made.data.id}`, { permissions: ['pos', 'accounts'] }, 'PUT')).status, 403, 'admin now: Super Admin only');
    assert.equal((await byCali('/users', { email: 'nuur@example.com', name: 'Nuur', password: 'pass-12345', role: 'cashier', permissions: ['accounts'] })).status, 403);
    assert.equal((await byCali(`/users/${cumar.id}`, { permissions: ['pos', 'accounts', 'customers'] }, 'PUT')).status, 200, 'keeps accounts it had');
    // Given back.
    assert.equal((await byOwner(`/users/${cali.id}`, { adminDenied: [] }, 'PUT')).status, 200);
    assert.equal((await byCali('/accounts/report')).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
