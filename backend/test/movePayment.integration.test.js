import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import Payment from '../src/models/Payment.js';
import Sale from '../src/models/Sale.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('CUSTOMERS -- a debt payment entered on the wrong customer moves to the right one', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/move_payment_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-move-payment';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', permissions: ['customers', 'customerMoney'] });
  const evc = await Account.create({ name: 'EVC Plus' });
  const cali = await Customer.create({ name: 'Cali' });
  const cumar = await Customer.create({ name: 'Cumar' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (u) => async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  try {
    const stock = await api('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 10 }] });
    const item = stock.data.rows[0].item;
    // Both owe on credit: Cali 50, Cumar 30.
    const s1 = await api('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 5 }], paidAmount: 0 });
    const s2 = await api('/sales', { customerId: cumar.id, items: [{ itemId: item, quantity: 3 }], paidAmount: 0 });
    await closeDay({ user: owner });
    await openDay({ user: owner });

    // Cumar paid 20, but it was entered on Cali.
    const paid = await api(`/customers/${cali.id}/payments`, { amount: 20, paymentAccountId: evc.id });
    assert.equal(paid.status, 201, JSON.stringify(paid));
    const paymentId = paid.data.payment?.id || paid.data.id || (await Payment.findOne({ customer: cali._id, type: 'debt_payment' }))._id;
    assert.deepEqual([(await Customer.findById(cali.id)).balanceCents, (await Customer.findById(cumar.id)).balanceCents], [3000, 3000]);

    assert.equal((await as(cashier)(`/customers/${cali.id}/payments/${paymentId}/move`, { toCustomerId: cumar.id })).status, 403, 'admins and managers only');
    const moved = await api(`/customers/${cali.id}/payments/${paymentId}/move`, { toCustomerId: cumar.id, reason: 'Wrong name' });
    assert.equal(moved.status, 200, JSON.stringify(moved));
    assert.deepEqual([(await Customer.findById(cali.id)).balanceCents, (await Customer.findById(cumar.id)).balanceCents], [5000, 1000], 'Cali owes 50 again, Cumar 10');
    assert.deepEqual([(await Sale.findById(s1.data.id)).outstandingCents, (await Sale.findById(s2.data.id)).outstandingCents], [5000, 1000]);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 2000, 'the money stays in EVC');
    const p = await Payment.findById(paymentId);
    assert.equal(String(p.customer), cumar.id);
    assert.match(p.notes, /Moved from Cali/);

    // Not more than the right customer owes; not twice from the wrong one.
    assert.equal((await api(`/customers/${cali.id}/payments/${paymentId}/move`, { toCustomerId: cumar.id })).status, 404);
    const big = await api(`/customers/${cali.id}/payments`, { amount: 40, paymentAccountId: evc.id });
    const bigId = (await Payment.findOne({ customer: cali._id, amountCents: 4000 }))._id;
    assert.equal(big.status, 201);
    assert.equal((await api(`/customers/${cali.id}/payments/${bigId}/move`, { toCustomerId: cumar.id })).status, 400, 'Cumar owes only 10');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
