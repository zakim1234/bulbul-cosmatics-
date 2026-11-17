import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';

test('ITEM REPORT -- 100 Zinc in from the supplier, who took how many, and each day in / out', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/item_report_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-item-report';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos'] });
  const aaran = await Supplier.create({ name: 'Aaran Agritrade' });
  const cali = await Customer.create({ name: 'Cali' });
  const cumar = await Customer.create({ name: 'Cumar' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, user = owner) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    assert.equal((await api('/supplier-invoice-archives', { serialNumber: '112233', supplierId: aaran.id, addToStock: true, rows: [{ itemName: 'Zinc', quantity: 100, cost: 1, sellingPrice: 2 }] })).status, 201);
    const zinc = await InventoryItem.findOne({ name: 'Zinc' });
    const s1 = await api('/sales', { customerId: cali.id, items: [{ itemId: zinc.id, quantity: 30 }] });
    assert.equal(s1.status, 201, JSON.stringify(s1));
    assert.equal((await api('/sales', { customerId: cumar.id, items: [{ itemId: zinc.id, quantity: 20 }] })).status, 201);
    const ret = await api(`/sales/${s1.data.id}/return`, { items: [{ itemId: zinc.id, quantity: 5 }], refundTo: 'WALLET' });
    assert.equal(ret.status, 200, JSON.stringify(ret));

    const r = await api(`/inventory/${zinc.id}/report`);
    assert.equal(r.status, 200, JSON.stringify(r));
    const { summary, receipts, customers, days } = r.data;
    assert.deepEqual([receipts.length, receipts[0].quantity, receipts[0].supplier, receipts[0].supplierInvoice], [1, 100, 'Aaran Agritrade', '112233']);
    assert.deepEqual(customers.map((c) => [c.name, c.quantity]), [['Cali', 25], ['Cumar', 20]], 'Cali took 30 and returned 5');
    assert.deepEqual([summary.opening, summary.totalIn, summary.totalOut, summary.closing], [0, 105, 50, 55]);
    assert.equal((await InventoryItem.findById(zinc._id)).quantity, 55, 'matches the stock');
    assert.deepEqual([days.length, days[0].in, days[0].out, days[0].closing], [1, 105, 50, 55]);
    // Every 'Received' line names the supplier too.
    const recv = r.data.movements.find((m) => m.kind === 'Received');
    assert.deepEqual([recv.supplier, recv.supplierInvoice], ['Aaran Agritrade', '112233']);
    // Stock page receipt with a supplier chosen: listed with that supplier.
    assert.equal((await api('/stock', { supplierId: aaran.id, externalSerialNumber: 'P-77', rows: [{ itemId: zinc.id, name: 'Zinc', quantity: 10, costPrice: 1, sellingPrice: 2 }] })).status, 201);
    const r2 = (await api(`/inventory/${zinc.id}/report`)).data;
    assert.deepEqual(r2.receipts.map((x) => [x.quantity, x.supplier]), [[10, 'Aaran Agritrade'], [100, 'Aaran Agritrade']], JSON.stringify(r2.receipts));
    // Its own permission.
    assert.equal((await api(`/inventory/${zinc.id}/report`, null, cashier)).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
