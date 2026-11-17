import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';
import InventoryLot from '../src/models/InventoryLot.js';
import StockAdjustment from '../src/models/StockAdjustment.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('INVENTORY EDIT -- only the Super Admin, or an admin they allow, changes the quantity; it is a stock adjustment', { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/inventory_edit_qty_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-inventory-edit-qty';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const admin = await User.create({ username: 'super', name: 'Super', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const branchAdmin = await User.create({ username: 'adm', name: 'Branch Admin', passwordHash: 'unused', role: 'admin' });
  const manager = await User.create({ username: 'mgr', name: 'Manager', passwordHash: 'unused', role: 'manager', permissions: ['inventory', 'editRecords', 'stockAdjustments'] });
  const cashier = await User.create({ username: 'cash', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['inventory', 'editRecords', 'stockAdjustments'] });
  const customer = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (path, body, method = 'POST', who = admin) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(who._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  const put = (id, body, who) => request(`/inventory/${id}`, body, 'PUT', who);
  const lotsOf = async (id) => (await InventoryLot.find({ item: id })).reduce((s, l) => s + l.remainingQuantity, 0);
  try {
    const stock = await request('/stock', { rows: [{ name: 'Panadol', quantity: 1 }] });
    const id = stock.data.rows[0].item;

    // Staff only when given it; an admin only once allowed. Nothing saved.
    assert.equal((await put(id, { quantity: 0, unit: 'box' }, manager)).status, 403);
    assert.equal((await put(id, { quantity: 0, unit: 'box' }, cashier)).status, 403);
    assert.equal((await put(id, { quantity: 0, unit: 'box' }, branchAdmin)).status, 403);
    assert.equal((await request(`/users/${branchAdmin.id}`, { adminGranted: ['editItemQuantity'] }, 'PUT', branchAdmin)).status, 403, 'an admin cannot allow themselves');
    assert.equal((await InventoryItem.findById(id)).unit, 'pcs');
    // Sending the same quantity is not a change: they can still edit the rest.
    assert.equal((await put(id, { quantity: 1, unit: 'box' }, manager)).status, 200);

    // 1 to 0: item and batch both go to 0, and the other edits are saved.
    assert.equal((await request(`/users/${branchAdmin.id}`, { adminGranted: ['editItemQuantity'] }, 'PUT')).status, 200);
    const zero = await put(id, { quantity: 0, unit: 'strip' }, branchAdmin);
    assert.equal(zero.status, 200, JSON.stringify(zero));
    assert.equal(zero.data.quantity, 0);
    const item = await InventoryItem.findById(id);
    assert.deepEqual([item.quantity, item.unit], [0, 'strip']);
    assert.equal(await lotsOf(id), 0);
    const adjustment = await StockAdjustment.findOne({ item: id });
    assert.deepEqual([adjustment.direction, adjustment.quantity, adjustment.quantityBefore, adjustment.quantityAfter], ['DECREASE', 1, 1, 0]);

    // Up again, and the save can be undone.
    assert.equal((await put(id, { quantity: 7 })).status, 200);
    assert.equal(await lotsOf(id), 7);
    const up = await StockAdjustment.findOne({ item: id, direction: 'INCREASE' });
    assert.equal((await request(`/stock-adjustments/${up.adjustmentNumber}/reverse`, { reason: 'test' })).status, 200);
    assert.equal((await InventoryItem.findById(id)).quantity, 0);
    assert.equal((await put(id, { quantity: 7 })).status, 200);

    // Bad values are refused.
    for (const quantity of [-1, 1.5, 'abc']) assert.equal((await put(id, { quantity })).status, 400, String(quantity));

    // A sale takes its units at once (no Pending): 7 - 5 = 2 left.
    const sold = await request('/sales', { customerId: customer.id, items: [{ itemId: id, quantity: 5 }] });
    assert.equal(sold.status, 201, JSON.stringify(sold));
    assert.equal((await InventoryItem.findById(id)).quantity, 2);
    assert.equal((await put(id, { quantity: 0 })).status, 200);
    await closeDay({ user: admin });
    await openDay({ user: admin });
    assert.equal((await InventoryItem.findById(id)).quantity, 0);

    // An item sold below zero: still editable, and raising it fills no batch.
    const short = await request('/sales', { customerId: customer.id, items: [{ itemId: id, quantity: 2 }] });
    assert.equal(short.status, 201, JSON.stringify(short));
    await closeDay({ user: admin });
    await openDay({ user: admin });
    assert.equal((await InventoryItem.findById(id)).quantity, -2);
    assert.equal((await put(id, { quantity: -2, unit: 'pack' }, manager)).status, 200, 'the unchanged minus quantity is no obstacle');
    assert.equal((await put(id, { quantity: 0 })).status, 200);
    assert.equal((await InventoryItem.findById(id)).quantity, 0);
    assert.equal(await lotsOf(id), 0, 'no batch holds stock that does not exist');
    assert.equal((await put(id, { quantity: 3 })).status, 200);
    assert.equal(await lotsOf(id), 3);
    // Given to a cashier (by an admin or the Super Admin): they can too.
    await User.updateOne({ _id: cashier._id }, { $set: { permissions: ['inventory', 'editRecords', 'stockAdjustments', 'editItemQuantity'] } });
    assert.equal((await put(id, { quantity: 4 }, cashier)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
