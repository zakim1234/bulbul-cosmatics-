import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';
import InventoryItem from '../src/models/InventoryItem.js';

test('MANUAL ENTRY -- "add goods to stock" can be given to anyone, without the Stock page', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/manual_entry_stock_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-manual-entry-stock';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const clerk = await User.create({ username: 'clerk', name: 'Clerk', passwordHash: 'unused', role: 'cashier', permissions: ['supplierInvoices'] });
  const aaran = await Supplier.create({ name: 'Aaran Agritrade' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const post = async (body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/supplier-invoice-archives`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(clerk._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify(body) })).status;
  const inv = (serialNumber) => ({ serialNumber, supplierId: aaran.id, addToStock: true, rows: [{ itemName: 'Ferro Appetite Syrup', quantity: 10, cost: 0.6, sellingPrice: 1 }] });
  try {
    assert.equal(await post(inv('A-1')), 403, 'not given: cannot add to stock');
    await User.updateOne({ _id: clerk._id }, { $set: { permissions: ['supplierInvoices', 'manualEntryStock'] } });
    assert.equal(await post(inv('A-2')), 201, 'given: the goods go into stock');
    assert.equal((await InventoryItem.findOne({ name: 'Ferro Appetite Syrup' })).quantity, 10);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
