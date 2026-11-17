import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Branch from '../src/models/Branch.js';
import Account from '../src/models/Account.js';
import Partner from '../src/models/Partner.js';
import PartnerCapitalTransaction from '../src/models/PartnerCapitalTransaction.js';
import { clearBranchCache } from '../src/middleware/auth.js';
import { runWithBranch } from '../src/services/branchContext.js';
import { getPartnerCapitalLines } from '../src/services/balanceSheetService.js';

test('PARTNERS -- an opening balance is capital from before the system; no account receives it', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/partner_opening_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-partner-opening';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const branch = await Branch.create({ name: 'Main' });
  clearBranchCache();
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', branch: branch._id, permissions: ['partners'] });
  const evc = await runWithBranch(branch._id, () => Account.create({ name: 'EVC Plus', currentBalanceCents: 0 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Branch-Id': String(branch._id) }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  const equity = async (id) => (await Partner.findById(id)).currentEquityCents;
  const balance = async () => (await Account.findById(evc._id)).currentBalanceCents;
  const openings = (id) => PartnerCapitalTransaction.countDocuments({ partner: id, type: 'OPENING_BALANCE' });
  try {
    const partner = (await api('/partners', { name: 'Abdirahman' })).data;

    // $1,000 opening: equity up, no account touched, one history line.
    const set = await api(`/partners/${partner.id}/opening-balance`, { amount: 1000, note: 'Before the system' }, 'PUT');
    assert.equal(set.status, 200, JSON.stringify(set));
    assert.deepEqual([set.data.openingBalance, set.data.currentEquity, set.data.totalContributed], [1000, 1000, 0]);
    assert.equal(await balance(), 0);
    assert.equal(await openings(partner.id), 1);
    const history = (await api(`/partners/${partner.id}/transactions`)).data;
    assert.deepEqual([history[0].type, history[0].amount, history[0].note], ['OPENING_BALANCE', 1000, 'Before the system']);

    // Changed: the equity moves by the difference; still one line.
    assert.equal((await api(`/partners/${partner.id}/opening-balance`, { amount: 600 }, 'PUT')).status, 200);
    assert.equal(await equity(partner.id), 60000);
    assert.equal(await openings(partner.id), 1);

    // It counts like any capital: a contribution adds, a withdrawal takes off.
    assert.equal((await api(`/partners/${partner.id}/contribute`, { amount: 100, paymentAccountId: evc.id })).status, 201);
    assert.equal(await balance(), 10000);
    assert.equal((await api(`/partners/${partner.id}/withdraw`, { amount: 50, paymentAccountId: evc.id })).status, 200);
    assert.equal(await equity(partner.id), 65000);
    assert.deepEqual(await runWithBranch(branch._id, () => getPartnerCapitalLines()), [{ name: 'Abdirahman', branch: branch._id, capitalCents: 65000 }]);

    // Cannot go so low that the equity would be below zero.
    await Partner.updateOne({ _id: partner.id }, { $inc: { currentEquityCents: -60000 } });
    assert.equal((await api(`/partners/${partner.id}/opening-balance`, { amount: 0 }, 'PUT')).status, 400);
    await Partner.updateOne({ _id: partner.id }, { $inc: { currentEquityCents: 60000 } });

    // 0 removes it.
    assert.equal((await api(`/partners/${partner.id}/opening-balance`, { amount: 0 }, 'PUT')).status, 200);
    assert.equal(await equity(partner.id), 5000);
    assert.equal(await openings(partner.id), 0);

    // Bad amounts and staff are refused.
    for (const amount of [-1, 'abc', '']) assert.equal((await api(`/partners/${partner.id}/opening-balance`, { amount }, 'PUT')).status, 400, String(amount));
    assert.equal((await as(cashier)(`/partners/${partner.id}/opening-balance`, { amount: 10 }, 'PUT')).status, 403);
    assert.equal(await equity(partner.id), 5000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
