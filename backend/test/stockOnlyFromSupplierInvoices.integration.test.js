import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import InventoryItem from '../src/models/InventoryItem.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('STOCK -- comes in only on a Supplier Invoice: the Stock page and POS "+ New item" add items, not stock', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/stock_only_si_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-stock-only-si';
  const saved = process.env.ALLOW_STOCK_PAGE_QUANTITIES;
  delete process.env.ALLOW_STOCK_PAGE_QUANTITIES; // as on the real server
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const gap = (await buildBalanceSheet()).differenceCents;
    const refused = await api('/stock', { rows: [{ name: 'Suprafen 400mg', quantity: 9, costPrice: 1, sellingPrice: 2 }] });
    assert.equal(refused.status, 400, 'no stock from the Stock page, even for the Super Admin');
    assert.match(refused.message, /Supplier Invoices/);
    assert.equal((await api('/stock', { rows: [{ name: 'Suprafen 400mg', costPrice: 1, sellingPrice: 2 }] })).status, 201, 'the item and its prices: fine');
    assert.equal((await InventoryItem.findOne({ name: 'Suprafen 400mg' })).quantity, 0);
    assert.equal((await api('/quick-items', { name: 'Gauze', sellingPrice: 1, initialQuantity: 5, cost: 0.5 })).data.quantity, 0, 'POS new item: no stock');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'nothing put the Balance Sheet out');

    // Opening stock from "Import Excel file" (Super Admin): the quantities go
    // in, and their value is Opening stock in equity -- still balanced.
    const imported = await api('/stock', { opening: true, rows: [{ name: 'Panadol Extra', quantity: 100, costPrice: 0.5, sellingPrice: 1 }, { name: 'Zinc Syrup', quantity: 10, costPrice: 2, sellingPrice: 3 }] });
    assert.equal(imported.status, 201, JSON.stringify(imported));
    assert.equal((await InventoryItem.findOne({ name: 'Panadol Extra' })).quantity, 100);
    const sheet = await buildBalanceSheet();
    assert.equal(sheet.equity.openingStock, 70, '100 x $0.50 + 10 x $2');
    assert.equal(sheet.differenceCents, gap, 'opening stock does not put the Balance Sheet out');
    // Not for anyone but the Super Admin.
    const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
    const asAdmin = await fetch(`http://127.0.0.1:${server.address().port}/api/stock`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(admin._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify({ opening: true, rows: [{ name: 'X', quantity: 1, costPrice: 1, sellingPrice: 1 }] }) });
    assert.equal(asAdmin.status, 403);
  } finally {
    if (saved !== undefined) process.env.ALLOW_STOCK_PAGE_QUANTITIES = saved;
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
