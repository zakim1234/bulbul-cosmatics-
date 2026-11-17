import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Branch from '../src/models/Branch.js';
import { runWithBranch } from '../src/services/branchContext.js';

test('COMMISSIONS -- the Commission 30% account: money moved in from an account, back, and commission paid from it', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/commission_account_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-commission-account';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const shop = await Branch.create({ name: 'Bakaaro' });
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cali', passwordHash: 'unused', role: 'cashier', branch: shop._id });
  const evc = await runWithBranch(shop._id, () => Account.create({ name: 'EVC Plus', currentBalanceCents: 100000 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body != null ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}`, 'X-Branch-Id': String(shop._id) }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const balance = async (id) => (await Account.findById(id)).currentBalanceCents;
  try {
    assert.equal((await api('/commissions/account')).data.account, null);
    const created = await api('/commissions/account', {});
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal(created.data.name, 'Commission 30%');
    const com = created.data.id;
    assert.equal((await api('/commissions/account', {})).data.id, com, 'only one per branch');

    const ni = async () => (await api('/reports/balance-sheet')).data;
    const before = await ni();

    // $300 in from EVC; more than EVC has is refused.
    assert.equal((await api('/commissions/account/move', { otherAccountId: evc.id, amount: 300, direction: 'IN' })).status, 201);
    assert.deepEqual([await balance(evc._id), await balance(com)], [70000, 30000]);
    assert.equal((await api('/commissions/account/move', { otherAccountId: evc.id, amount: 5000, direction: 'IN' })).status, 400);
    // $50 back.
    assert.equal((await api('/commissions/account/move', { otherAccountId: evc.id, amount: 50, direction: 'OUT' })).status, 201);
    assert.deepEqual([await balance(evc._id), await balance(com)], [75000, 25000]);
    const after = await ni();
    assert.deepEqual([after.equity.netIncome, after.assets.cash, after.differenceCents], [before.equity.netIncome, before.assets.cash, before.differenceCents], 'moving money changes no totals');
    const got = (await api('/commissions/account')).data;
    assert.equal(got.account.balance, 250);
    assert.equal(got.moves.length, 2);

    // Commission paid from it (the profit for the year is the opening 1,000).
    assert.equal((await api('/reports/opening-equity', { openingNetIncome: 1000, openingRetainedEarnings: 0 }, 'PUT')).status, 200);
    const year = String(new Date().getFullYear());
    const paid = await api('/commissions', { type: 'year', key: year, paymentAccountId: com, lines: [{ userId: cashier.id, percent: 10 }] });
    assert.equal(paid.status, 201, JSON.stringify(paid));
    assert.equal(await balance(com), 15000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
