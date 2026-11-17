import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';

test('SUPPLIER INVOICES -- "Edit supplier invoices" can be given to anyone; Delete stays with admins', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/edit_si_perm_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-edit-si-perm';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const plain = await User.create({ username: 'plain', name: 'Plain', passwordHash: 'unused', role: 'cashier', permissions: ['supplierInvoices'] });
  const given = await User.create({ username: 'given', name: 'Given', passwordHash: 'unused', role: 'cashier', permissions: ['supplierInvoices', 'editSupplierInvoices'] });
  const sup = await Supplier.create({ name: 'Al Xaramayn Pharmacy HQ' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const call = async (u, method, path, body) => (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) })).json().then((j) => j);
  const status = async (u, method, path, body) => (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) })).status;
  try {
    const made = await call(owner, 'POST', '/supplier-invoice-archives', { serialNumber: '104861', supplierId: sup.id, rows: [{ itemName: 'Suprafen 400mg', quantity: 1, cost: 2.2 }] });
    const body = { serialNumber: '104861', supplierId: sup.id, rows: [{ itemName: 'Suprafen 400mg', quantity: 1, cost: 2 }] };
    assert.equal(await status(plain, 'PUT', `/supplier-invoice-archives/${made.data.id}`, body), 403, 'not given');
    assert.equal(await status(given, 'PUT', `/supplier-invoice-archives/${made.data.id}`, body), 200, 'given: can edit');
    assert.equal(await status(given, 'DELETE', `/supplier-invoice-archives/${made.data.id}`), 403, 'but not delete');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
