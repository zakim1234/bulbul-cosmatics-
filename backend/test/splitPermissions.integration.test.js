import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User, { effectivePermissions } from '../src/models/User.js';
import Customer from '../src/models/Customer.js';
import Account from '../src/models/Account.js';
import InventoryItem from '../src/models/InventoryItem.js';
import { migratePermissions } from '../src/utils/migratePermissions.js';

test('PERMISSIONS -- the broad ones are split one area each; whoever had one keeps every part of it', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/split_perms_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-split-perms';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  // Saved the old way (straight into the collection, as on the server).
  const { insertedId: oldId } = await User.collection.insertOne({ username: 'old', name: 'Old', passwordHash: 'x', role: 'cashier', permissions: ['customers', 'inventory', 'editRecords', 'customerMoney'], adminDenied: [], adminGranted: [], active: true });
  const { insertedId: adminId } = await User.collection.insertOne({ username: 'adm', name: 'Adm', passwordHash: 'x', role: 'admin', permissions: [], adminDenied: ['deleteRecords'], adminGranted: [], active: true });
  const narrow = await User.create({ username: 'narrow', name: 'Narrow', passwordHash: 'x', role: 'cashier', permissions: ['customers', 'inventory', 'editCustomers', 'walletMoney'] });
  const cali = await Customer.create({ name: 'Cali' });
  const item = await InventoryItem.create({ name: 'Panadol', itemCode: 'P-1', quantity: 0, costPriceCents: 100, sellingPriceCents: 200 });
  const evc = await Account.create({ name: 'EVC Plus' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const call = async (id, method, path, body) => (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) })).status;
  try {
    // Moved over on start-up: nothing lost, nothing gained.
    assert.equal(await migratePermissions(), 2);
    const old = await User.findById(oldId);
    for (const k of ['editCustomers', 'editItems', 'editSuppliers', 'editPurchases', 'editAccounts', 'takeDebtPayments', 'walletMoney', 'customerReturns', 'changeOpeningDebt']) assert.ok(old.permissions.includes(k), k);
    assert.ok(!old.permissions.includes('editRecords') && !old.permissions.includes('deleteCustomers'));
    const adm = await User.findById(adminId);
    const admHas = effectivePermissions(adm);
    assert.ok(!admHas.includes('deleteCustomers') && !admHas.includes('deletePurchases'), 'what was taken from the admin stays taken');
    assert.ok(admHas.includes('editCustomers'), 'the rest the admin keeps');
    assert.equal(await migratePermissions(), 0, 'once only');

    // One area each: editing a customer, not an item.
    assert.equal(await call(narrow._id, 'PUT', `/customers/${cali.id}`, { name: 'Cali Xasan' }), 200);
    assert.equal(await call(narrow._id, 'PUT', `/inventory/${item.id}`, { sellingPrice: 3 }), 403);
    assert.equal(await call(old._id, 'PUT', `/inventory/${item.id}`, { sellingPrice: 3 }), 200, 'the moved-over user still can');
    // Customer money split: the wallet, not debt payments.
    assert.equal(await call(narrow._id, 'POST', `/customers/${cali.id}/wallet/deposit`, { amount: 5, paymentAccountId: evc.id }), 201);
    assert.equal(await call(narrow._id, 'POST', `/customers/${cali.id}/payments`, { amount: 1, paymentAccountId: evc.id }), 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
