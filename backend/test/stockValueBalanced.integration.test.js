import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import Supplier from '../src/models/Supplier.js';
import InventoryItem from '../src/models/InventoryItem.js';
import StockRevaluation from '../src/models/StockRevaluation.js';
import { createSaleDraft } from '../src/services/saleService.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';
import { runInTransaction } from '../src/utils/transaction.js';

test('STOCK -- cost edits, deleted supplier invoices, voided purchases and stock sold ahead keep the Balance Sheet balanced', { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/stock_value_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-stock-value';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 100000 });
  const cali = await Customer.create({ name: 'Cali' });
  const vita = await Supplier.create({ name: 'Vita Pharma' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  let serial = 0;
  const buy = async (itemName, quantity, cost) => {
    const r = await api('/supplier-invoice-archives', { serialNumber: `S-${++serial}`, supplierId: vita.id, addToStock: true, rows: [{ itemName, quantity, cost, sellingPrice: 9 }] });
    assert.equal(r.status, 201, JSON.stringify(r));
    return r.data;
  };
  const sell = async (name, quantity) => {
    const item = await InventoryItem.findOne({ name });
    await runInTransaction((session) => createSaleDraft({ customerId: cali.id, items: [{ itemId: item.id, quantity }], paidAmount: 9 * quantity, paymentAccountId: evc.id }, owner, session));
    await closeDay({ user: owner });
    await openDay({ user: owner });
  };
  const gap = async () => (await buildBalanceSheet()).differenceCents;
  try {
    const start = await gap();

    // 10 at $1 and 10 at $2 (average $1.50), 5 sold.
    await buy('Panadol', 10, 1);
    const second = await buy('Panadol', 10, 2);
    await sell('Panadol', 5);
    assert.equal(await gap(), start, 'buying and selling');

    // The cost price changed by hand: 15 x ($1.73 - $1.50) = $3.45 gain.
    const panadol = await InventoryItem.findOne({ name: 'Panadol' });
    const edited = await api(`/inventory/${panadol.id}`, { costPrice: 1.73 }, 'PUT');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    const reval = await StockRevaluation.findOne({ item: panadol._id });
    assert.ok(Math.abs(reval.changeCents - 345) < 1e-6, String(reval.changeCents));
    assert.equal(await gap(), start, 'cost price edited');

    // The $2 invoice deleted after some were sold: what is on the shelf
    // leaves at $2 each, the average of the rest is worked back.
    const del = await api(`/supplier-invoice-archives/${second.id}`, null, 'DELETE');
    assert.equal(del.status, 200, JSON.stringify(del));
    assert.equal(await gap(), start, 'supplier invoice deleted');

    // Sold ahead of stock: 1 at $1, 3 sold (-2), then 5 come in at $2.
    await buy('Amoxil', 1, 1);
    await sell('Amoxil', 3);
    assert.equal((await InventoryItem.findOne({ name: 'Amoxil' })).quantity, -2);
    await buy('Amoxil', 5, 2);
    assert.equal(await gap(), start, 'stock received after selling ahead');

    // A purchase voided: 2 at $1, then 4 at $3, the $3 one voided.
    await buy('Vitamin C', 2, 1);
    const toVoid = await buy('Vitamin C', 4, 3);
    const v = await api(`/purchases/${toVoid.purchase?.id || toVoid.purchase}/void`, { reason: 'test' });
    assert.equal(v.status, 200, JSON.stringify(v));
    const vit = await InventoryItem.findOne({ name: 'Vitamin C' });
    assert.equal(vit.quantity, 2, 'the voided units left stock');
    assert.ok(Math.abs(vit.costPriceCents - 100) < 1e-6, `average back to $1, got ${vit.costPriceCents}`);
    assert.equal(await gap(), start, 'purchase voided');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('STOCK -- editing an item (name only) keeps its exact average cost', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/stock_value_edit_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-stock-value-edit';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const item = await InventoryItem.create({ name: 'Panadol', itemCode: 'ITM-000001', quantity: 3, costPriceCents: 302 / 3, sellingPriceCents: 500 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    // The form sends back what it shows: $1.01.
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/inventory/${item.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify({ name: 'Panadol 500', costPrice: 1.01, sellingPrice: 5 }) });
    assert.equal(r.status, 200);
    const after = await InventoryItem.findById(item._id);
    assert.equal(after.costPriceCents, 302 / 3, 'exact average kept');
    assert.equal(await StockRevaluation.countDocuments(), 0, 'nothing booked');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
