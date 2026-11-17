import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';
import Purchase from '../src/models/Purchase.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('SUPPLIER INVOICE -- cost corrected after it went into stock: owed, stock and profit follow; Balance Sheet stays balanced', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/si_cost_edit_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-si-cost-edit';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const aaran = await Supplier.create({ name: 'Aaran Agritrade' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const gap = (await buildBalanceSheet()).differenceCents;
    const inv = await api('/supplier-invoice-archives', { serialNumber: 'Z-1', supplierId: aaran.id, addToStock: true, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1, sellingPrice: 2 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv));
    const zinc = await InventoryItem.findOne({ name: 'Zinc' });
    assert.equal((await api('/sales', { customerId: cali.id, items: [{ itemId: zinc.id, quantity: 40 }] })).status, 201);

    // The paper said $1.20, not $1: corrected after 40 were sold.
    const edited = await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'Z-1', supplierId: aaran.id, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1.2 }] }, 'PUT');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.equal((await Purchase.findById(inv.data.purchase)).totalCostCents, 12000, 'now $120 owed');
    const after = await InventoryItem.findById(zinc._id);
    assert.equal(after.quantity, 60);
    assert.ok(Math.abs(after.costPriceCents - 120) < 1e-6, `the 60 left now cost $1.20, got ${after.costPriceCents}`);
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'still balanced (the 40 sold: $8 more cost in P&L)');

    // A discount added later works the same way.
    const disc = await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'Z-1', supplierId: aaran.id, discount: 20, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1.2 }] }, 'PUT');
    assert.equal(disc.status, 200, JSON.stringify(disc));
    assert.equal((await Purchase.findById(inv.data.purchase)).totalCostCents, 10000, '$120 less $20');
    assert.ok(Math.abs((await InventoryItem.findById(zinc._id)).costPriceCents - 100) < 1e-6, 'each now really cost $1.00');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'still balanced');

    // The selling price can be corrected too: the item sells at it from now on.
    assert.equal((await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'Z-1', supplierId: aaran.id, discount: 20, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1.2, sellingPrice: 2.5 }] }, 'PUT')).status, 200);
    assert.equal((await InventoryItem.findById(zinc._id)).sellingPriceCents, 250);
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'a selling price does not touch the Balance Sheet');

    // Quantities stay locked once received.
    assert.equal((await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'Z-1', supplierId: aaran.id, rows: [{ itemName: 'Zinc', quantity: 90, cost: 1.2 }] }, 'PUT')).status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('SUPPLIER INVOICE -- cost lowered after selling: 100 at $1.50, 40 sold, supplier settles at $1', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/si_cost_down_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-si-cost-down';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const aaran = await Supplier.create({ name: 'Aaran Agritrade' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const gap = (await buildBalanceSheet()).differenceCents;
    const inv = await api('/supplier-invoice-archives', { serialNumber: 'Z-2', supplierId: aaran.id, addToStock: true, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1.5, sellingPrice: 2 }] });
    const zinc = await InventoryItem.findOne({ name: 'Zinc' });
    await api('/sales', { customerId: cali.id, items: [{ itemId: zinc.id, quantity: 40 }] });
    const profitBefore = (await buildBalanceSheet()).equity.netIncome;
    const edited = await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'Z-2', supplierId: aaran.id, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1 }] }, 'PUT');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.equal((await Purchase.findById(inv.data.purchase)).totalCostCents, 10000, '$150 -> $100 owed');
    assert.ok(Math.abs((await InventoryItem.findById(zinc._id)).costPriceCents - 100) < 1e-6, 'the 60 left cost $1');
    const sheet = await buildBalanceSheet();
    assert.ok(Math.abs(sheet.equity.netIncome - profitBefore - 20) < 0.001, 'the 40 sold: $20 less cost, $20 more profit');
    assert.equal(sheet.differenceCents, gap, 'still balanced');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
