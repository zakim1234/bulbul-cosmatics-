import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';

test('SALARIES -- the Super Admin, an admin they allow, and staff that admin passes it to', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/salaries_permission_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-salaries-permission';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const superAdmin = await User.create({ username: 'super', name: 'Super', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const manager = await User.create({ username: 'mgr', name: 'Manager', passwordHash: 'unused', role: 'manager', permissions: [] });
  const cashier = await User.create({ username: 'cash', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: [] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (who, path, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(who._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    for (const path of ['/salaries/sheet', '/salaries/workers', '/salaries/sheets', '/salaries/statement']) {
      assert.equal((await request(manager, path)).status, 403, `manager ${path}, not given`);
      assert.equal((await request(cashier, path)).status, 403, `cashier ${path}, not given`);
      assert.equal((await request(admin, path)).status, 403, `admin ${path}, until allowed`);
    }
    assert.equal((await request(superAdmin, '/salaries/sheet')).status, 200);

    // An admin cannot allow themselves; the Super Admin can allow them.
    assert.equal((await request(admin, `/users/${admin.id}`, { adminGranted: ['salaries'] }, 'PUT')).status, 403);
    assert.equal((await request(superAdmin, `/users/${admin.id}`, { adminGranted: ['salaries'] }, 'PUT')).status, 200);
    assert.equal((await request(admin, '/salaries/sheet')).status, 200, 'the allowed admin');
    const me = await request(admin, '/auth/me');
    assert.ok((me.data.user || me.data).permissions.includes('salaries'), 'the menu is told');
    // The allowed admin passes it on to their cashier.
    assert.equal((await request(admin, `/users/${cashier.id}`, { permissions: ['salaries'] }, 'PUT')).status, 200);
    assert.equal((await request(cashier, '/salaries/sheet')).status, 200, 'the cashier given it');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
