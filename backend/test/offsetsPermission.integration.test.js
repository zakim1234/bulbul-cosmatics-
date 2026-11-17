import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';

test('CUSTOMER <-> SUPPLIER -- open to whoever has the permission', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/offsets_permission_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-offsets-permission';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const manager = await User.create({ username: 'mgr', name: 'Mgr', passwordHash: 'unused', role: 'manager', permissions: ['customers'] });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'offsets'] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const get = async (user, path) => (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: { Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` } })).status;
  try {
    assert.equal(await get(admin, '/offsets'), 200, 'an admin has it');
    assert.equal(await get(manager, '/offsets'), 403, 'not ticked');
    assert.equal(await get(cashier, '/offsets'), 200, 'ticked');
    assert.equal(await get(cashier, '/offsets/parties'), 200);
    await User.updateOne({ _id: admin._id }, { $set: { adminDenied: ['offsets'] } });
    assert.equal(await get(admin, '/offsets'), 403, 'taken away by the Super Admin');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
