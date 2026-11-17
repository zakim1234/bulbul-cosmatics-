import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';

test('LIABILITIES -- an expense charged now and paid later; opening debts from the old books', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/liabilities_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-liabilities';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const manager = await User.create({ username: 'mgr', name: 'Mgr', passwordHash: 'unused', role: 'manager', permissions: ['fixedAssets'] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  const sheet = async () => (await api('/reports/balance-sheet')).data;
  const year = new Date().getFullYear();
  const pnl = async () => (await api(`/reports/profit-loss?from=${year}-01-01&to=${year}-12-31`)).data;
  try {
    const bank = await Account.create({ name: 'Bank', openingBalanceCents: 100000, currentBalanceCents: 100000 });
    const cats = (await api('/expenses/categories')).data;
    const category = cats[0].name || cats[0];
    const start = await sheet();

    // Rent $300 charged, not paid: Net Income -300, unpaid expenses 300, no money moves.
    const rent = await api('/liabilities', { name: 'Rent -- November', category, amount: 300 });
    assert.equal(rent.status, 201, JSON.stringify(rent));
    let s = await sheet();
    assert.deepEqual([s.equity.netIncome, s.liabilities.unpaidExpenses, s.differenceCents], [start.equity.netIncome - 300, 300, start.differenceCents], 'still balanced');
    assert.equal((await Account.findById(bank._id)).currentBalanceCents, 100000);
    // In Profit & Loss it shows under its expense category.
    const report = await pnl();
    assert.ok(report.rows.some((r) => r.label === category && r.values.total === 300), JSON.stringify(report.rows.filter((r) => r.label === category)));

    // Pay $100 of it: the bank goes down, so does the debt.
    const pay = await api(`/liabilities/${rent.data.id}/pay`, { amount: 100, paymentAccountId: bank.id });
    assert.equal(pay.status, 201, JSON.stringify(pay));
    assert.deepEqual([pay.data.paid, pay.data.left], [100, 200]);
    assert.equal((await Account.findById(bank._id)).currentBalanceCents, 90000);
    s = await sheet();
    assert.deepEqual([s.liabilities.unpaidExpenses, s.equity.netIncome, s.differenceCents], [200, start.equity.netIncome - 300, start.differenceCents], 'paying does not touch Net Income');
    assert.equal((await api(`/liabilities/${rent.data.id}/pay`, { amount: 201, paymentAccountId: bank.id })).status, 400, 'more than is left');
    assert.equal((await api(`/liabilities/${rent.data.id}`, null, 'DELETE')).status, 400, 'paid in part: undo the payments first');
    assert.equal((await api(`/liabilities/${rent.data.id}`, { name: 'Rent', category, amount: 50 }, 'PUT')).status, 400, 'not below what was paid');

    // Undo the payment: money back, debt back.
    const paymentId = pay.data.payments[0].id;
    assert.equal((await api(`/liabilities/${rent.data.id}/payments/${paymentId}`, null, 'DELETE')).status, 200);
    assert.equal((await Account.findById(bank._id)).currentBalanceCents, 100000);
    assert.equal((await sheet()).liabilities.unpaidExpenses, 300);

    // Opening balance: a debt from the old books -- a liability, not an expense.
    const loan = await api('/liabilities', { name: 'Salaam Bank loan', amount: 5000, opening: true });
    assert.equal(loan.status, 201, JSON.stringify(loan));
    s = await sheet();
    assert.deepEqual([s.liabilities.openingLiabilities, s.equity.netIncome], [5000, start.equity.netIncome - 300]);
    assert.equal(s.liabilities.totalLiabilities, start.liabilities.totalLiabilities + 5300);

    // A valid category is needed for an expense; staff only read.
    assert.equal((await api('/liabilities', { name: 'X', category: 'Nope', amount: 5 })).status, 400);
    assert.equal((await as(manager)('/liabilities')).status, 200);
    assert.equal((await as(manager)('/liabilities', { name: 'X', category, amount: 5 })).status, 403);

    // Deleting an unpaid one takes it out of the expenses again.
    assert.equal((await api(`/liabilities/${rent.data.id}`, null, 'DELETE')).status, 200);
    s = await sheet();
    assert.deepEqual([s.equity.netIncome, s.liabilities.unpaidExpenses], [start.equity.netIncome, 0]);
    const list = (await api('/liabilities')).data;
    assert.deepEqual([list.total, list.left, list.liabilities.length], [5000, 5000, 1]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
