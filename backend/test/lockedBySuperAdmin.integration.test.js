import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';

test('SALES -- an invoice the Super Admin edited: the cashier sees it but cannot change it until allowed', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/locked_by_super_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-locked-by-super';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'editInvoices', 'cancelInvoices'] });
  await Account.create({ name: 'EVC Plus' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (u) => async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const admin = as(owner);
  const cash = as(cashier);
  try {
    const stock = await admin('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 10 }] });
    const item = stock.data.rows[0].item;
    const sale = await cash('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 5 }], paidAmount: 0 });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    // The cashier edits their own pending invoice: fine, not locked.
    const own = await cash(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 4 }], paidAmount: 0 }, 'PUT');
    assert.equal(own.status, 200, JSON.stringify(own));
    assert.deepEqual([own.data.editedByName, own.data.lockedBySuperAdmin], ['Cash', false]);

    // The Super Admin edits it: now locked for the cashier.
    const byOwner = await admin(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 2 }], paidAmount: 0 }, 'PUT');
    assert.deepEqual([byOwner.status, byOwner.data.editedByName, byOwner.data.lockedBySuperAdmin], [200, 'Super Admin Owner', true]);
    const seen = await cash(`/sales/${sale.data.id}`);
    assert.deepEqual([seen.status, seen.data.editedByName, seen.data.items[0].quantity], [200, 'Super Admin Owner', 2], 'the cashier sees the change');
    assert.equal((await cash(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 9 }], paidAmount: 0 }, 'PUT')).status, 403);
    assert.equal((await cash(`/sales/${sale.data.id}/cancel`, { reason: 'x' })).status, 403);

    // Once given the permission, the cashier may change it.
    await User.updateOne({ _id: cashier._id }, { $addToSet: { permissions: 'changeLockedInvoices' } });
    assert.equal((await cash(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 3 }], paidAmount: 0 }, 'PUT')).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
