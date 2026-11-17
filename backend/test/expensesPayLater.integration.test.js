import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Liability from '../src/models/Liability.js';

test('EXPENSES -- pay later: on the Expenses page (EXP number, this month) and on Liabilities; payments show there', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/expenses_pay_later_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-expenses-pay-later';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true, showBulkTools: true });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', permissions: ['expenses'] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  const ni = async () => (await api('/reports/balance-sheet')).data.equity.netIncome;
  try {
    const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 50000 });
    const start = await ni();

    // Electric $80, pay later: an expense this month, no account moves.
    const e = await api('/expenses', { category: 'Electric', amount: 80, note: 'Korontada November', payLater: true });
    assert.equal(e.status, 201, JSON.stringify(e));
    assert.match(e.data.expenseNumber, /^EXP-/);
    assert.equal(e.data.payLater, true);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 50000);
    assert.equal(await ni(), start - 80, 'counted once');
    let list = (await api('/expenses?range=month')).data;
    assert.equal(list.summary.totalThisMonth, 80);
    assert.deepEqual([list.expenses[0].liability.left, list.expenses[0].liability.payments], [80, []]);
    const line = await Liability.findOne({ expense: e.data.id });
    assert.equal(line.name, 'Korontada November');

    // Staff cannot charge to Liabilities; paying now still needs an account.
    assert.equal((await as(cashier)('/expenses', { category: 'Electric', amount: 5, payLater: true })).status, 403);
    assert.equal((await api('/expenses', { category: 'Electric', amount: 5 })).status, 400);

    // Pay $50 from EVC on the Liabilities page: the payment shows on the expense.
    assert.equal((await api(`/liabilities/${line.id}/pay`, { amount: 50, paymentAccountId: evc.id })).status, 201);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 45000);
    assert.equal(await ni(), start - 80, 'paying is not a second expense');
    list = (await api('/expenses?range=month')).data;
    assert.equal(list.expenses[0].liability.left, 30);
    assert.deepEqual(list.expenses[0].liability.payments.map((p) => [p.amount, p.accountName]), [[50, 'EVC Plus']]);

    // Voiding it is refused while part is paid.
    assert.equal((await api(`/expenses/${e.data.id}/void`, { reason: 'x' })).status, 409);

    // Reports Clear All takes it, its line, and gives the $50 back.
    const cleared = await api('/reports/clear', { confirm: 'DELETE' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    assert.equal(await Liability.countDocuments(), 0);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 50000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
