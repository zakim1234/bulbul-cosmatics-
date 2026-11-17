import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Partner from '../src/models/Partner.js';

test('FIXED ASSET WALLET -- profit set aside for the equipment, owed to the owners, then paid out to them', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/fixed_asset_wallet_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-fixed-asset-wallet';
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
  const year = new Date().getFullYear();
  const sheet = async () => (await api('/reports/balance-sheet')).data;
  const fund = async () => (await api('/fixed-assets/fund')).data;
  try {
    const bank = await Account.create({ name: 'Bank', openingBalanceCents: 100000, currentBalanceCents: 100000 });
    const partner = (await api('/partners', { name: 'Cali' })).data;
    // $1,000 of this year's profit (entered as the opening net income).
    assert.equal((await api('/reports/opening-equity', { openingNetIncome: 1000, openingRetainedEarnings: 0 }, 'PUT')).status, 200);
    assert.equal((await fund()).years[0].available, 1000);
    let gap = (await sheet()).differenceCents;

    // $1,000 of computers bought with money that is not the company's: the
    // asset and the same debt, so the sheet's balance does not move.
    const computers = (await api('/fixed-assets', { owedTo: 'Cali', name: 'Computers', value: 1000 })).data;
    let s = await sheet();
    assert.deepEqual([s.assets.fixedAssets, s.liabilities.fixedAssetDebt, s.differenceCents], [1000, 1000, gap]);

    // Opening balance: $500 of the company's own old equipment -- in Fixed
    // Assets only -- not a debt, not added to equity (the old books' capital
    // already holds it), and nobody is owed for it.
    const old = await api('/fixed-assets', { opening: true, name: 'Old shelves', value: 500 });
    assert.equal(old.status, 201, JSON.stringify(old));
    assert.deepEqual([old.data.opening, old.data.owedTo], [true, '']);
    s = await sheet();
    assert.deepEqual([s.assets.fixedAssets, s.liabilities.fixedAssetDebt, s.equity.openingFixedAssets, s.differenceCents], [1500, 1000, undefined, gap + 50000]);
    gap += 50000;
    const list = (await api('/fixed-assets')).data;
    assert.deepEqual([list.total, list.owedTotal, list.openingTotal], [1500, 1000, 500]);
    assert.deepEqual((await fund()).creditors.map((c) => c.name), ['Cali']);

    // Set aside $400: Net Income 600, reserve 400; the debt is still 1000.
    const set = await api('/fixed-assets/fund/set-aside', { year, amount: 400, note: 'Shelves' });
    assert.equal(set.status, 201, JSON.stringify(set));
    s = await sheet();
    assert.deepEqual([s.equity.netIncome, s.equity.fixedAssetReserve, s.liabilities.fixedAssetDebt, s.differenceCents], [600, 400, 1000, gap], 'still balanced');
    assert.equal((await Account.findById(bank._id)).currentBalanceCents, 100000);
    assert.equal((await api(`/partners/profit-sharing/preview?year=${year}`)).data.netProfit, 600, 'not shared twice');
    assert.equal((await fund()).years[0].available, 600);
    assert.equal((await api('/fixed-assets/fund/set-aside', { year, amount: 700 })).status, 400, 'more than is left');

    // Pay $150 to the partner from the bank.
    const pay = await api('/fixed-assets/fund/payout', { amount: 150, partnerId: partner.id, paymentAccountId: bank.id });
    assert.equal(pay.status, 201, JSON.stringify(pay));
    assert.equal((await Account.findById(bank._id)).currentBalanceCents, 85000);
    assert.equal((await Partner.findById(partner.id)).totalProfitCents, 15000);
    let f = await fund();
    assert.deepEqual([f.balance, f.setAside, f.paidOut], [250, 400, 150]);
    // Who is owed what: bought from Cali 1000, paid back 150, 850 left.
    assert.deepEqual(f.creditors, [{ name: 'Cali', bought: 1000, paid: 150, left: 850 }]);
    assert.equal(f.entries.find((e) => e.type === 'PAYOUT').person, 'Cali');
    s = await sheet();
    assert.deepEqual([s.liabilities.fixedAssetDebt, s.equity.fixedAssetReserve, s.differenceCents], [850, 400, gap], 'the debt went down; still balanced');
    assert.equal((await api('/fixed-assets/fund/payout', { amount: 251, person: 'Someone', paymentAccountId: bank.id })).status, 400, 'more than the wallet');
    // Never more than the debt left: computers worth 200, 150 paid -> 50.
    assert.equal((await api(`/fixed-assets/${computers.id}`, { name: 'Computers', value: 200 }, 'PUT')).status, 200);
    const overDebt = await api('/fixed-assets/fund/payout', { amount: 100, person: '  cali ', paymentAccountId: bank.id });
    assert.match((await api('/fixed-assets/fund/payout', { amount: 1, person: 'Stranger', paymentAccountId: bank.id })).message, /Nothing is owed to Stranger/);
    assert.equal(overDebt.status, 400);
    assert.match(overDebt.message, /50\.00/);
    assert.equal((await api(`/fixed-assets/${computers.id}`, { name: 'Computers', value: 1000 }, 'PUT')).status, 200);
    assert.equal((await api('/fixed-assets/fund/payout', { amount: 10, paymentAccountId: bank.id })).status, 400, 'nobody named');

    // Only the admin moves profit.
    assert.equal((await as(manager)('/fixed-assets/fund/set-aside', { year, amount: 1 })).status, 403);
    assert.equal((await as(manager)('/fixed-assets/fund')).status, 200);

    // Undo: the set-aside cannot go while part of it is paid out.
    const setId = f.entries.find((e) => e.type === 'SET_ASIDE').id;
    assert.equal((await api(`/fixed-assets/fund/${setId}`, null, 'DELETE')).status, 400);
    assert.equal((await api(`/fixed-assets/fund/${pay.data.id}`, null, 'DELETE')).status, 200);
    assert.equal((await Account.findById(bank._id)).currentBalanceCents, 100000);
    assert.equal((await Partner.findById(partner.id)).totalProfitCents, 0);
    assert.equal((await api(`/fixed-assets/fund/${setId}`, null, 'DELETE')).status, 200);
    s = await sheet();
    assert.deepEqual([s.equity.netIncome, s.equity.fixedAssetReserve, s.liabilities.fixedAssetDebt, s.differenceCents], [1000, 0, 1000, gap]);

    // A year already shared with the partners cannot be set aside from.
    await api(`/partners/${partner.id}/contribute`, { amount: 100, paymentAccountId: bank.id });
    const preview = (await api(`/partners/profit-sharing/preview?year=${year}`)).data;
    assert.ok((await api('/partners/profit-sharing', { year, mode: 'CAPITAL', shares: preview.partners.map((p) => ({ partnerId: p.id, percent: p.percent })) })).status < 300);
    assert.equal((await api('/fixed-assets/fund/set-aside', { year, amount: 10 })).status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
