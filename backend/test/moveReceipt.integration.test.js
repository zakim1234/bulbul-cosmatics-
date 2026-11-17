import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import AccountTransaction from '../src/models/AccountTransaction.js';
import Customer from '../src/models/Customer.js';
import Sale from '../src/models/Sale.js';
import Payment from '../src/models/Payment.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('ACCOUNTS -- a customer payment put on the wrong account is moved to the right one', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/move_receipt_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-move-receipt';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'accounts'] });
  const evc = await Account.create({ name: 'EVC Plus' });
  const edahab = await Account.create({ name: 'eDahab' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (u) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  const bal = async (a) => (await Account.findById(a._id)).currentBalanceCents;
  try {
    const stock = await api('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 10 }] });
    const item = stock.data.rows[0].item;
    const sheet0 = (await api('/reports/balance-sheet')).data;

    // Paid $40 with EVC, but eDahab was chosen.
    const sale = await api('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 5 }], paidAmount: 40, paymentAccountId: edahab.id });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    await closeDay({ user: owner });
    await openDay({ user: owner });
    assert.deepEqual([await bal(edahab), await bal(evc)], [4000, 0]);

    const txn = await AccountTransaction.findOne({ account: edahab._id, type: 'SALE_PAYMENT', status: 'POSTED' });
    assert.equal((await as(cashier)(`/accounts/transactions/${txn.id}/move`, { toAccountId: evc.id })).status, 403, 'admins and managers only');
    const moved = await api(`/accounts/transactions/${txn.id}/move`, { toAccountId: evc.id });
    assert.equal(moved.status, 200, JSON.stringify(moved));
    assert.deepEqual([await bal(edahab), await bal(evc)], [0, 4000]);
    assert.equal(String((await Sale.findById(sale.data.id)).paymentAccount), evc.id, 'the invoice names EVC');
    assert.equal((await Payment.findOne({ relatedSale: sale.data.id })).paymentAccountName, 'EVC Plus');
    assert.equal((await Customer.findById(cali.id)).balanceCents, 1000, 'the customer still owes 10');
    assert.equal((await api(`/accounts/transactions/${txn.id}/move`, { toAccountId: edahab.id })).status, 409, 'only once');

    const statement = (await api(`/accounts/${edahab.id}/statement`)).data;
    assert.equal(statement.rows.find((r) => r.id === txn.id).movedToName, 'EVC Plus');
    const sheet = (await api('/reports/balance-sheet')).data;
    assert.equal(sheet.differenceCents, sheet0.differenceCents, 'the Balance Sheet does not move');

    // A sale paid today (final at once): its payment is moved the same way.
    const sale2 = await api('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 2 }], paidAmount: 20, paymentAccountId: edahab.id });
    const pending = await AccountTransaction.findOne({ referenceId: sale2.data.id, type: 'SALE_PAYMENT' });
    assert.equal((await api(`/accounts/transactions/${pending.id}/move`, { toAccountId: evc.id })).status, 200);
    await closeDay({ user: owner });
    assert.deepEqual([await bal(edahab), await bal(evc)], [0, 6000]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
