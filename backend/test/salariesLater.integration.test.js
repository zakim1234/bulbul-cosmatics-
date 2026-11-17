import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Expense from '../src/models/Expense.js';
import Liability from '../src/models/Liability.js';

test('SALARIES -- pay later: an expense now and one line each on Liabilities, no account moves', { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/salaries_later_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-salaries-later';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cashier', name: 'Cashier Ali', passwordHash: 'unused', role: 'cashier' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const token = jwt.sign({ sub: String(admin._id) }, process.env.JWT_SECRET);
  const request = async (path, body, method = body != null ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 100000 });
    const ni = async () => (await request('/reports/balance-sheet')).data.equity.netIncome;
    const before = await ni();
    assert.equal((await request('/salaries/sheet', { period: '2026-11', rows: [{ userId: admin.id, amount: 500 }, { userId: cashier.id, amount: 300 }] }, 'PUT')).status, 200);

    // Pay later on the 30th: no account, two liabilities, Net Income -800.
    const charged = await request('/salaries/sheet/pay', { toLiabilities: true });
    assert.equal(charged.status, 200, JSON.stringify(charged));
    assert.deepEqual([charged.data.status, charged.data.toLiabilities], ['PAID', true]);
    assert.ok(charged.data.rows.every((r) => r.liability && /^EXP-/.test(r.expenseNumber)));
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 100000);
    // Each is a Salaries expense (EXP number, on the Expenses page) with no account.
    const exps = await Expense.find({ status: 'POSTED' });
    assert.deepEqual(exps.map((e) => [e.category, e.amountCents, e.paymentAccount]).sort(), [['Salaries', 30000, null], ['Salaries', 50000, null]]);
    const lines = (await request('/liabilities')).data;
    assert.deepEqual(lines.liabilities.map((l) => [l.name, l.category, l.amount]).sort(), [['Salary 2026-11 -- Admin', 'Salaries', 500], ['Salary 2026-11 -- Cashier Ali', 'Salaries', 300]]);
    assert.equal(await ni(), before - 800);

    // Pay Cali's line when the money comes: the account goes down then.
    const ali = lines.liabilities.find((l) => /Cashier Ali/.test(l.name));
    assert.equal((await request(`/liabilities/${ali.id}/pay`, { amount: 300, paymentAccountId: evc.id })).status, 201);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 70000);
    assert.equal(await ni(), before - 800, 'paying is not a second expense');

    // The sheet cannot be cancelled while a line is paid; once undone, it can.
    assert.equal((await request(`/salaries/sheets/${charged.data.id}/cancel`, { reason: 'test' })).status, 400);
    const paidLine = (await request('/liabilities')).data.liabilities.find((l) => l.id === ali.id);
    assert.equal((await request(`/liabilities/${ali.id}/payments/${paidLine.payments[0].id}`, null, 'DELETE')).status, 200);
    const cancelled = await request(`/salaries/sheets/${charged.data.id}/cancel`, { reason: 'test' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
    assert.equal(await Liability.countDocuments(), 0);
    assert.equal(await Expense.countDocuments({ status: 'POSTED' }), 0, 'their expenses are voided');
    assert.equal(await ni(), before);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 100000);

    // Paying now still needs an account.
    assert.equal((await request('/salaries/sheet', { period: '2026-12', rows: [{ userId: cashier.id, amount: 100 }] }, 'PUT')).status, 200);
    assert.equal((await request('/salaries/sheet/pay', {})).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
