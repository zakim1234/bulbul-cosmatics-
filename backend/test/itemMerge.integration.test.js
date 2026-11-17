import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';
import InventoryLot from '../src/models/InventoryLot.js';
import Sale from '../src/models/Sale.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('INVENTORY MERGE -- "RAT" made by mistake merged into "RAT KILL (BOX)" at -2: 38 left, worth the same, history moved', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/item_merge_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-item-merge';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'inventory'] });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const saba = await Supplier.create({ name: 'Saba Pharma' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, user = owner) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    // RAT KILL (BOX): 1 at $1.80, 3 sold -> -2.
    assert.equal((await api('/stock', { rows: [{ name: 'RAT KILL (BOX)', quantity: 1, costPrice: 1.8, sellingPrice: 0 }] })).status, 201);
    const ratKill = await InventoryItem.findOne({ name: 'RAT KILL (BOX)' });
    assert.equal((await api('/sales', { customerId: cali.id, items: [{ itemId: ratKill.id, quantity: 3, unitPrice: 2 }] })).status, 201);
    // "RAT" made by mistake: 41 at $1.88 from Saba, 1 sold.
    assert.equal((await api('/supplier-invoice-archives', { serialNumber: 'S-1', supplierId: saba.id, addToStock: true, rows: [{ itemName: 'RAT', quantity: 41, cost: 1.88, sellingPrice: 2 }] })).status, 201);
    const rat = await InventoryItem.findOne({ name: 'RAT' });
    const soldRat = await api('/sales', { customerId: cali.id, items: [{ itemId: rat.id, quantity: 1 }] });
    assert.equal(soldRat.status, 201);
    const gap = (await buildBalanceSheet()).differenceCents;

    // Off for everyone until given -- an admin too.
    assert.equal((await api(`/inventory/${rat.id}/merge`, { intoId: ratKill.id }, cashier)).status, 403, 'not for a cashier');
    assert.equal((await api(`/inventory/${rat.id}/merge`, { intoId: ratKill.id }, admin)).status, 403, 'not for an admin either');
    // Given to the cashier: now they can.
    await User.updateOne({ _id: cashier._id }, { $set: { permissions: ['pos', 'inventory', 'mergeItems'] } });
    const merged = await api(`/inventory/${rat.id}/merge`, { intoId: ratKill.id }, cashier);
    assert.equal(merged.status, 200, JSON.stringify(merged));

    const after = await InventoryItem.findById(ratKill._id);
    assert.equal(after.quantity, 38, '40 + (-2)');
    assert.ok(Math.abs(after.quantity * after.costPriceCents - (40 * 188 - 2 * 180)) < 1e-6, 'worth exactly the same: $71.60');
    assert.equal(after.sellingPriceCents, 200, 'its 0 price takes RAT\'s $2');
    assert.equal(await InventoryItem.countDocuments({ name: 'RAT' }), 0, 'RAT is gone');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'the Balance Sheet does not move');
    const lots = await InventoryLot.find({ item: ratKill._id });
    assert.equal(lots.reduce((s, l) => s + l.remainingQuantity, 0), 38, 'the batches match the quantity');
    const sale = await Sale.findById(soldRat.data.id);
    assert.deepEqual([String(sale.items[0].item), sale.items[0].itemName], [String(ratKill._id), 'RAT KILL (BOX)'], 'old invoices name the merged item');
    // The item report now has both: Saba's 41 in, and Cali's 3 + 1 out.
    const report = (await api(`/inventory/${ratKill.id}/report`)).data;
    assert.ok(report.receipts.some((r) => r.supplier === 'Saba Pharma' && r.quantity === 41));
    assert.equal(report.customers.find((c) => c.name === 'Cali').quantity, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
