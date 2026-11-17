import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';

test('BALANCE SHEET -- "where from?" points at the records behind a gap, with links', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/bs_check_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-bs-check';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    let check = (await api('/reports/balance-sheet/check')).data;
    assert.deepEqual([check.gap, check.findings.length], [0, 0]);

    // An account changed outside its history, and a customer who overpaid.
    const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 22 });
    const cali = await Customer.create({ name: 'Cali', balanceCents: -500 });
    check = (await api('/reports/balance-sheet/check')).data;
    const account = check.findings.find((f) => f.key === 'accountMismatch');
    assert.equal(account.amount, 0.22);
    assert.equal(account.matchesGap, true, 'the account alone is the 0.22');
    assert.deepEqual(account.items[0], { label: 'EVC Plus', amount: 0.22, link: '/accounts', isTheGap: true });
    const credit = check.findings.find((f) => f.key === 'customerCredit');
    assert.deepEqual([credit.amount, credit.items[0].link], [5, `/customers/${cali.id}`]);

    // Only the account left: it is exactly the difference.
    await Customer.updateOne({ _id: cali._id }, { $set: { balanceCents: 0 } });
    check = (await api('/reports/balance-sheet/check')).data;
    assert.equal(check.gap, 0.22);
    assert.equal(check.findings.find((f) => f.key === 'accountMismatch').matchesGap, true);
    assert.equal(String(evc._id).length > 0, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
