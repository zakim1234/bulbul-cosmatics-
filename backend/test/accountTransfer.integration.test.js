import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';

test('ACCOUNTS -- transfer: the money of several accounts into one', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/account_transfer_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-account-transfer';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', permissions: ['accounts'] });
  const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 10000 });
  const edahab = await Account.create({ name: 'eDahab', currentBalanceCents: 2500 });
  const salaam = await Account.create({ name: 'Salaam Bank', currentBalanceCents: 0 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (u) => async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  const bal = async (a) => (await Account.findById(a._id)).currentBalanceCents;
  try {
    const sheet0 = (await api('/reports/balance-sheet')).data;
    const items = [{ fromAccountId: evc.id, amount: 100 }, { fromAccountId: edahab.id, amount: 25 }];
    assert.equal((await as(cashier)('/accounts/transfer', { toAccountId: salaam.id, items })).status, 403);
    assert.equal((await api('/accounts/transfer', { toAccountId: salaam.id, items: [{ fromAccountId: evc.id, amount: 101 }] })).status, 400, 'more than it has');
    assert.equal((await api('/accounts/transfer', { toAccountId: evc.id, items: [{ fromAccountId: evc.id, amount: 1 }] })).status, 400, 'not to itself');

    const done = await api('/accounts/transfer', { toAccountId: salaam.id, items, note: 'All in one' });
    assert.equal(done.status, 201, JSON.stringify(done));
    assert.equal(done.data.total, 125);
    assert.deepEqual([await bal(evc), await bal(edahab), await bal(salaam)], [0, 0, 12500]);
    const sheet = (await api('/reports/balance-sheet')).data;
    assert.deepEqual([sheet.assets.cash, sheet.differenceCents], [sheet0.assets.cash, sheet0.differenceCents], 'totals do not change');
    const st = (await api(`/accounts/${salaam.id}/statement`)).data;
    assert.deepEqual(st.rows.map((r) => r.description).sort(), ['Transfer from EVC Plus -- All in one', 'Transfer from eDahab -- All in one']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
