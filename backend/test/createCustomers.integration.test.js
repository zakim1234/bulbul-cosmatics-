import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Customer from '../src/models/Customer.js';

test('ADD CUSTOMER -- the Super Admin, the admins they allow, and the staff those admins pass it to', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/create_customers_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-create-customers';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const superAdmin = await User.create({ username: 'super', name: 'Super', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const cashier = await User.create({ username: 'cashier', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'customers', 'customersSheet'] });
  const other = await User.create({ username: 'other', name: 'Other', passwordHash: 'unused', role: 'cashier', permissions: ['pos'] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (who, path, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(who._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    // Not allowed: refused from every door.
    assert.equal((await request(admin, '/customers', { name: 'A' })).status, 403, 'a branch admin, by default');
    assert.equal((await request(cashier, '/customers', { name: 'B' })).status, 403, 'staff, by default');
    assert.equal((await request(cashier, '/customers/bulk', { rows: [{ key: 'k1', name: 'C' }] })).status, 403, 'the sheet too');

    // The Super Admin can, and the sheet still edits saved customers without it.
    const made = await request(superAdmin, '/customers', { name: 'Cali' });
    assert.equal(made.status, 201, JSON.stringify(made));
    await User.updateOne({ _id: cashier._id }, { $addToSet: { permissions: 'editRecords' } });
    const edited = await request(cashier, '/customers/bulk', { rows: [{ id: made.data.id, name: 'Cali Xasan', phone: '', openingBalance: 0 }] });
    assert.equal(edited.status, 201, JSON.stringify(edited));
    assert.equal(await Customer.countDocuments(), 1);
    const duplicate = await Customer.create({ name: 'Cali Xasan' });
    const phoneEdit = await request(cashier, '/customers/bulk', { rows: [{ id: made.data.id, name: 'Cali Xasan', phone: '123', openingBalance: 0 }] });
    assert.equal(phoneEdit.status, 201, JSON.stringify(phoneEdit), 'editing contact details should not fail because saved names already duplicate');
    assert.equal((await Customer.findById(made.data.id)).phone, '123');
    assert.ok(await Customer.findById(duplicate.id));

    // An admin may pass it on to their staff too (it is not a company-wide power).
    assert.equal((await request(admin, `/users/${other.id}`, { permissions: ['pos', 'createCustomers'] }, 'PUT')).status, 200);
    assert.equal((await request(superAdmin, `/users/${other.id}`, { permissions: ['pos', 'createCustomers'] }, 'PUT')).status, 200);
    assert.equal((await request(other, '/customers', { name: 'Cumar' })).status, 201, 'allowed staff can');
    assert.equal((await request(superAdmin, `/users/${admin.id}`, { adminGranted: ['createCustomers'] }, 'PUT')).status, 200);
    assert.equal((await request(admin, '/customers', { name: 'Xasan' })).status, 201, 'an allowed admin can');
    // An allowed admin passes it on to their staff.
    assert.equal((await request(admin, `/users/${cashier.id}`, { permissions: ['pos', 'customers', 'customersSheet', 'createCustomers'] }, 'PUT')).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
