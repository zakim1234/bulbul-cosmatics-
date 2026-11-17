import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';
import InventoryLot from '../src/models/InventoryLot.js';
import StockEntry from '../src/models/StockEntry.js';

test('STOCK NAMES ONLY -- a list of names just adds the items; nothing typed is required but the name', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/stock_names_only_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-stock-names-only';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const user = await User.create({ username: 'super', name: 'Super', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const customer = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  const item = (name) => InventoryItem.findOne({ name });
  try {
    // Names only, quantity blank or 0: items are added, with no batch.
    const names = await request('/stock', { rows: [
      { key: 'a', name: 'VOLTAMED 25MG', quantity: '0', costPrice: '', sellingPrice: '', expiryDate: '' },
      { key: 'b', name: 'VOLTANOL GEL', quantity: '', costPrice: '', sellingPrice: '', expiryDate: '' },
      { key: 'c', name: 'XTRA CAP' },
    ] });
    assert.equal(names.status, 201, JSON.stringify(names));
    assert.equal(await InventoryItem.countDocuments(), 3);
    assert.equal(await InventoryLot.countDocuments(), 0);
    const added = await item('VOLTAMED 25MG');
    assert.equal(added.quantity, 0);
    assert.equal(added.sellingPriceCents, 0);
    assert.equal(added.stockEvents.length, 0);

    // Sent again: still three items.
    assert.equal((await request('/stock', { rows: [{ key: 'a', name: 'VOLTAMED 25MG', quantity: '0' }] })).status, 201);
    assert.equal(await InventoryItem.countDocuments(), 3);
    assert.equal(await StockEntry.countDocuments(), 1);

    // Later stock on it works as usual.
    assert.equal((await request('/stock', { rows: [{ itemId: added.id, name: 'VOLTAMED 25MG', quantity: 10, costPrice: 2, sellingPrice: 5 }] })).status, 201);
    let v = await item('VOLTAMED 25MG');
    assert.equal(v.quantity, 10);
    assert.equal(v.costPriceCents, 200);
    assert.equal(v.sellingPriceCents, 500);

    // A name-only row on an item with stock changes nothing.
    assert.equal((await request('/stock', { rows: [{ itemId: added.id, name: 'VOLTAMED 25MG', quantity: '', costPrice: '', sellingPrice: '' }] })).status, 201);
    v = await item('VOLTAMED 25MG');
    assert.deepEqual([v.quantity, v.costPriceCents, v.sellingPriceCents], [10, 200, 500]);

    // A quantity with a blank cost and price keeps the item's own, not 0.
    assert.equal((await request('/stock', { rows: [{ itemId: added.id, name: 'VOLTAMED 25MG', quantity: 10, costPrice: '', sellingPrice: '' }] })).status, 201);
    v = await item('VOLTAMED 25MG');
    assert.deepEqual([v.quantity, v.costPriceCents, v.sellingPriceCents], [20, 200, 500]);

    // A saved list still opens, and its item can be sold.
    const history = await request('/stock', null, 'GET');
    assert.equal(history.status, 200);
    assert.equal((await request(`/stock/${names.data._id}`, null, 'GET')).status, 200);
    const nameOnly = await item('XTRA CAP');
    assert.equal((await request('/sales', { customerId: customer.id, items: [{ itemId: nameOnly.id, quantity: 1 }] })).status, 201);

    // A minus quantity is saved (e.g. -27): the item is short by that many,
    // with no batch, and the next stock received makes the units up.
    const minus = await request('/stock', { rows: [{ name: 'Minus Item', quantity: -27, costPrice: 1, sellingPrice: 2 }] });
    assert.equal(minus.status, 201, JSON.stringify(minus));
    const short = await item('Minus Item');
    assert.equal(short.quantity, -27);
    assert.equal(await InventoryLot.countDocuments({ item: short._id }), 0);
    assert.equal((await request('/stock', { rows: [{ itemId: short.id, name: 'Minus Item', quantity: 30, costPrice: 1, sellingPrice: 2 }] })).status, 201);
    assert.equal((await item('Minus Item')).quantity, 3);
    assert.equal((await InventoryLot.find({ item: short._id })).reduce((s, l) => s + l.remainingQuantity, 0), 3);

    // What is typed must still be valid, and a name is still needed.
    assert.equal((await request('/stock', { rows: [{ name: 'Bad', quantity: 1.5 }] })).status, 400);
    assert.equal((await request('/stock', { rows: [{ name: 'Bad', quantity: 1, costPrice: 'abc' }] })).status, 400);
    assert.equal((await request('/stock', { rows: [{ quantity: 1 }] })).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
