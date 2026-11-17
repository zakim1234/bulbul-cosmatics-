import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';

test('SUPPLIERS -- "Edit suppliers" lets someone edit a supplier, not delete one', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/edit_suppliers_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-edit-suppliers';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const plain = await User.create({ username: 'plain', name: 'Plain', passwordHash: 'unused', role: 'cashier', permissions: ['suppliers'] });
  const given = await User.create({ username: 'given', name: 'Given', passwordHash: 'unused', role: 'cashier', permissions: ['suppliers', 'editSuppliers'] });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const aaran = await Supplier.create({ name: 'Aaran Agritrade' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const call = async (u, method, body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/suppliers/${aaran.id}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) })).status;
  try {
    assert.equal(await call(plain, 'PUT', { name: 'Aaran X' }), 403, 'not given');
    assert.equal(await call(given, 'PUT', { name: 'Aaran Agritrade Ltd', phone: '615' }), 200, 'given: can edit');
    assert.equal(await call(given, 'PUT', { email: 'x@y.so', address: 'Bakaaro', notes: 'n' }), 200);
    const s = await Supplier.findById(aaran._id);
    assert.deepEqual([s.name, s.phone, s.email || '', s.address || '', s.notes || ''], ['Aaran Agritrade Ltd', '615', '', '', ''], 'name and phone only');
    assert.equal(await call(given, 'DELETE'), 403, 'but not delete');
    assert.equal(await call(admin, 'PUT', { name: 'Aaran Agritrade' }), 200, 'an admin still can');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
