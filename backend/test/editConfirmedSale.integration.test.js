import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import Sale from '../src/models/Sale.js';
import InventoryItem from '../src/models/InventoryItem.js';
import Payment from '../src/models/Payment.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('SALES -- an invoice is edited after Close Day: items, money and account; stock, customer and accounts follow', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/edit_confirmed_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-edit-confirmed';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const evc = await Account.create({ name: 'EVC Plus' });
  const edahab = await Account.create({ name: 'eDahab' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const bal = async (a) => (await Account.findById(a._id)).currentBalanceCents;
  try {
    const stock = await api('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 10 }] });
    const item = stock.data.rows[0].item;
    const sheet0 = (await api('/reports/balance-sheet')).data;

    // 5 x $10 = $50, $20 paid with EVC.
    const sale = await api('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 5 }], paidAmount: 20, paymentAccountId: evc.id });
    await closeDay({ user: owner });
    await openDay({ user: owner });
    assert.deepEqual([await bal(evc), (await Customer.findById(cali.id)).balanceCents, (await InventoryItem.findById(item)).quantity], [2000, 3000, 45]);

    // Only with the 'Edit invoices after Close Day' permission.
    const branchAdmin = await User.create({ username: 'badmin', name: 'Branch Admin', passwordHash: 'unused', role: 'admin' });
    const tryEdit = async (u) => (await fetch(`http://127.0.0.1:${server.address().port}/api/sales/${sale.data.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify({ items: [{ itemId: item, quantity: 1 }], paidAmount: 0 }) })).status;
    assert.equal(await tryEdit(branchAdmin), 403, 'not given');

    // Edited: 3 x $10 = $30, all $30 paid with eDahab.
    const edited = await api(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 3 }], paidAmount: 30, paymentAccountId: edahab.id }, 'PUT');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    const s = await Sale.findById(sale.data.id);
    assert.deepEqual([s.status, s.totalCents, s.receiptNumber], ['CONFIRMED', 3000, sale.data.receiptNumber], 'same invoice, final again');
    assert.equal((await InventoryItem.findById(item)).quantity, 47, '2 back in stock');
    assert.deepEqual([await bal(evc), await bal(edahab)], [0, 3000], 'EVC gave back its 20, eDahab got 30');
    const c = await Customer.findById(cali.id);
    assert.deepEqual([c.balanceCents, c.totalPurchasedCents, c.totalPaidCents], [0, 3000, 3000]);
    assert.equal(await Payment.countDocuments({ relatedSale: s._id, type: 'sale', status: { $ne: 'CANCELLED' } }), 1, 'one live payment');
    const sheet = (await api('/reports/balance-sheet')).data;
    assert.equal(sheet.differenceCents, sheet0.differenceCents, 'the Balance Sheet stays balanced');

    // Edited again to a credit sale: money back out of eDahab, debt on Cali.
    assert.equal((await api(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 4 }], paidAmount: 0 }, 'PUT')).status, 200);
    assert.deepEqual([await bal(edahab), (await Customer.findById(cali.id)).balanceCents, (await InventoryItem.findById(item)).quantity], [0, 4000, 46]);

    // Paid later as debt: undo that payment first.
    assert.equal((await api(`/customers/${cali.id}/payments`, { amount: 10, paymentAccountId: evc.id })).status, 201);
    assert.equal((await api(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 1 }], paidAmount: 0 }, 'PUT')).status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
