import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';

test('SALES -- an admin corrects a cashier\'s invoice: "Edited by Admin Cabdi", locked for the cashier, not for admins', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/locked_by_admin_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-locked-by-admin';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const cabdi = await User.create({ username: 'cabdi', name: 'Cabdi', passwordHash: 'unused', role: 'admin' });
  const other = await User.create({ username: 'other', name: 'Other', passwordHash: 'unused', role: 'admin' });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'editInvoices', 'accounts'] });
  const evc = await Account.create({ name: 'EVC Plus' });
  const cali = await Customer.create({ name: 'Cali' });
  const item = await InventoryItem.create({ name: 'Panadol', itemCode: 'P-1', quantity: 50, costPriceCents: 100, sellingPriceCents: 300 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (u) => async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const sale = await as(cashier)('/sales', { customerId: cali.id, items: [{ itemId: item.id, quantity: 3 }], paidAmount: 9, paymentAccountId: evc.id });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    const fixed = await as(cabdi)(`/sales/${sale.data.id}`, { items: [{ itemId: item.id, quantity: 2 }], paidAmount: 6, paymentAccountId: evc.id }, 'PUT');
    assert.equal(fixed.status, 200, JSON.stringify(fixed));
    assert.deepEqual([fixed.data.editedByName, fixed.data.lockedByAdmin], ['Admin Cabdi', true]);
    assert.equal((await as(cashier)(`/sales/${sale.data.id}`, { items: [{ itemId: item.id, quantity: 1 }], paidAmount: 0 }, 'PUT')).status, 403, 'locked for the cashier');
    const rows = (await as(cashier)(`/accounts/${evc.id}/transactions`)).data?.transactions || [];
    assert.ok(rows.some((t) => t.correctedByName === 'Admin Cabdi'), 'the cashier sees who corrected it');
    assert.equal((await as(other)(`/sales/${sale.data.id}`, { items: [{ itemId: item.id, quantity: 2 }], paidAmount: 6, paymentAccountId: evc.id }, 'PUT')).status, 200, 'another admin can still change it');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
