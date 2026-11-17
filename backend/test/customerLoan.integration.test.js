import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('CUSTOMER LOAN -- $100 cash lent: out of the account, onto the debt, paid back like any debt; cancel puts it back', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/customer_loan_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-customer-loan';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 50000 });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, user = owner) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const gap = (await buildBalanceSheet()).differenceCents;
    assert.equal((await api(`/customers/${cali.id}/loans`, { amount: 100, accountId: evc.id }, admin)).status, 403, 'off until given, admins too');
    const loan = await api(`/customers/${cali.id}/loans`, { amount: 100, accountId: evc.id, note: 'family need' });
    assert.equal(loan.status, 201, JSON.stringify(loan));
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 40000, '$100 left EVC');
    assert.equal((await Customer.findById(cali._id)).balanceCents, 10000, 'Cali owes $100');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'the Balance Sheet does not move');
    const st = (await api(`/customers/${cali.id}/statement`)).data;
    const line = st.ledger.find((l) => l.type === 'LOAN');
    assert.deepEqual([line.reference, line.debit], [loan.data.number, 100]);
    assert.equal((await api(`/customers/${cali.id}/loans`, { amount: 1000, accountId: evc.id })).status, 400, 'not more than the account has');

    // Cancel it (given by mistake): money back, debt off.
    const cancelled = await api(`/customers/${cali.id}/loans/${loan.data.id}/cancel`, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 50000);
    assert.equal((await Customer.findById(cali._id)).balanceCents, 0);
    assert.equal((await api(`/customers/${cali.id}/loans/${loan.data.id}/cancel`, {})).status, 409, 'only once');

    // A loan paid back with a normal debt payment.
    const loan2 = await api(`/customers/${cali.id}/loans`, { amount: 100, accountId: evc.id });
    assert.equal(loan2.status, 201);
    const paid = await api(`/customers/${cali.id}/payments`, { amount: 60, paymentAccountId: evc.id });
    assert.equal(paid.status, 201, JSON.stringify(paid));
    assert.equal((await Customer.findById(cali._id)).balanceCents, 4000, '$40 still owed');
    assert.equal((await api(`/customers/${cali.id}/loans/${loan2.data.id}/cancel`, {})).status, 409, 'part paid back: cannot cancel');
    assert.equal((await buildBalanceSheet()).differenceCents, gap);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
