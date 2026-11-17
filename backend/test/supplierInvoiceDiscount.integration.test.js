import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';
import InventoryItem from '../src/models/InventoryItem.js';
import Purchase from '../src/models/Purchase.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('SUPPLIER INVOICES -- a discount on the invoice: $100 less $10 is $90 owed, and the stock is worth $90', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/archive_discount_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-archive-discount';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const aaran = await Supplier.create({ name: 'Aaran Agritrade' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const gap = (await buildBalanceSheet()).differenceCents;
    const made = await api('/supplier-invoice-archives', { serialNumber: '112233', supplierId: aaran.id, addToStock: true, discount: 10, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1, sellingPrice: 2 }] });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.deepEqual([made.data.subtotal, made.data.discount, made.data.grandTotal], [100, 10, 90]);
    assert.equal(made.data.rows[0].cost, 1, 'the paper cost stays on the invoice');
    const purchase = await Purchase.findById(made.data.purchase);
    assert.equal(purchase.totalCostCents, 9000, '$90 owed to the supplier');
    const zinc = await InventoryItem.findOne({ name: 'Zinc' });
    assert.equal(zinc.costPriceCents, 90, 'each one cost $0.90 after the discount');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'the Balance Sheet stays balanced');
    // Too big a discount is refused.
    assert.equal((await api('/supplier-invoice-archives', { serialNumber: '9', supplierId: aaran.id, discount: 5, rows: [{ itemName: 'X', quantity: 1, cost: 1 }] })).status, 400);
    // Received into stock: the discount can be corrected; owed and stock follow, still balanced.
    assert.equal((await api(`/supplier-invoice-archives/${made.data.id}`, { serialNumber: '112233', supplierId: aaran.id, discount: 20, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1 }] }, 'PUT')).status, 200);
    assert.equal((await InventoryItem.findOne({ name: 'Zinc' })).costPriceCents, 80);
    assert.equal((await buildBalanceSheet()).differenceCents, gap);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
