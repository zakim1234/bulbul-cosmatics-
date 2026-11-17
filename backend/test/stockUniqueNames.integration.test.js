import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import InventoryItem from '../src/models/InventoryItem.js';
import StockEntry from '../src/models/StockEntry.js';

test('STOCK NAMES -- a name is saved once; picking the item still receives more of it', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/stock_unique_names_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-stock-unique-names';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const user = await User.create({ username: 'super', name: 'Super', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const stock = async (rows) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stock`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify({ rows }) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    const first = await stock([{ name: 'Zinc', quantity: 10, costPrice: 1, sellingPrice: 2 }]);
    assert.equal(first.status, 201, JSON.stringify(first));
    const zinc = await InventoryItem.findOne({ name: 'Zinc' });

    // Any case or spacing, with or without a quantity: refused, nothing changes.
    for (const name of ['Zinc', 'ZINC', '  zinc  ']) {
      assert.equal((await stock([{ name, quantity: 5, costPrice: 1, sellingPrice: 2 }])).status, 409, name);
      assert.equal((await stock([{ name }])).status, 409, name);
    }
    assert.equal((await stock([{ name: 'Multi  Word' }])).status, 201);
    assert.equal((await stock([{ name: 'multi word' }])).status, 409, 'spaces inside the name');

    // One bad row refuses the whole list, and a repeat on one list is refused.
    assert.equal((await stock([{ name: 'New One' }, { name: 'zinc' }])).status, 409);
    assert.equal((await stock([{ name: 'Twice', quantity: 1 }, { name: 'twice', quantity: 1, expiryDate: '2035-01-01' }])).status, 409);
    assert.equal(await InventoryItem.countDocuments({ name: { $in: ['New One', 'Twice', 'twice'] } }), 0);
    assert.equal((await InventoryItem.findById(zinc.id)).quantity, 10);
    assert.equal(await InventoryItem.countDocuments({ name: /^zinc$/i }), 1);

    // Picking the item is not a new name: stock still comes in, in two batches too.
    const more = await stock([{ itemId: zinc.id, name: 'Zinc', quantity: 5, costPrice: 1, sellingPrice: 2, expiryDate: '2035-01-01' }, { itemId: zinc.id, name: 'Zinc', quantity: 5, costPrice: 1, sellingPrice: 2, expiryDate: '2036-01-01' }]);
    assert.equal(more.status, 201, JSON.stringify(more));
    assert.equal((await InventoryItem.findById(zinc.id)).quantity, 20);

    // The same row sent again (the answer was lost) is still not an error.
    const keyed = await stock([{ key: 'k1', name: 'Keyed', quantity: 1 }]);
    assert.equal(keyed.status, 201);
    const entries = await StockEntry.countDocuments();
    assert.equal((await stock([{ key: 'k1', name: 'Keyed', quantity: 1 }])).status, 201);
    assert.equal(await StockEntry.countDocuments(), entries);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
