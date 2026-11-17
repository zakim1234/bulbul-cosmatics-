import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';
import InventoryLot from '../src/models/InventoryLot.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('NEGATIVE STOCK -- an item can be sold with none in stock; stock received makes it up first', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/negative_stock_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-negative-stock';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const user = await User.create({ username: 'test', name: 'Tester', passwordHash: 'unused' });
  const customer = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET);
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  const zinc = async () => InventoryItem.findById(zincId);
  const lotsLeft = async () => (await InventoryLot.find({ item: zincId })).reduce((s, l) => s + l.remainingQuantity, 0);
  let zincId;
  try {
    // Zinc with nothing in stock: 10 received and all sold.
    const first = await request('/stock', { rows: [{ name: 'Zinc', quantity: 10, costPrice: 1, sellingPrice: 2 }] });
    zincId = first.data.rows[0].item;
    assert.equal((await request('/sales', { customerId: customer.id, items: [{ itemId: zincId, quantity: 10 }] })).status, 201);
    await closeDay({ user });
    await openDay({ user });
    assert.equal((await zinc()).quantity, 0);

    // 200 sold with none in stock: the sale goes through, stock goes to -200.
    const ahead = await request('/sales', { customerId: customer.id, items: [{ itemId: zincId, quantity: 200 }] });
    assert.equal(ahead.status, 201, JSON.stringify(ahead));
    await closeDay({ user });
    await openDay({ user });
    assert.equal((await zinc()).quantity, -200);
    const search = await request('/inventory/search?q=Zinc', null, 'GET');
    assert.equal(search.data[0].availableQuantity, -200);

    // 300 received: 200 make up what was sold ahead, 100 are left -- and the
    // new batch holds only those 100.
    assert.equal((await request('/stock', { rows: [{ itemId: zincId, name: 'Zinc', quantity: 300, costPrice: 0.5, sellingPrice: 2 }] })).status, 201);
    assert.equal((await zinc()).quantity, 100);
    assert.equal(await lotsLeft(), 100);
    assert.equal((await zinc()).costPriceCents, 50);

    // A return of units that were sold ahead of stock only adds to the item,
    // never to a batch that never held them.
    const back = await request(`/sales/${ahead.data.id}/return`, { items: [{ itemId: zincId, quantity: 20 }], reason: 'test' });
    assert.equal(back.status, 200, JSON.stringify(back));
    assert.equal((await zinc()).quantity, 120);

    // Expired stock on hand is never sold ahead of stock.
    const old = await request('/stock', { rows: [{ name: 'Old Syrup', quantity: 5, costPrice: 1, sellingPrice: 2, expiryDate: '2020-01-01' }] });
    const blocked = await request('/sales', { customerId: customer.id, items: [{ itemId: old.data.rows[0].item, quantity: 1 }] });
    assert.equal(blocked.status, 409);
    assert.match(blocked.message, /expired/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
