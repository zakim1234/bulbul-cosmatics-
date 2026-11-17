import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';

test('PROFIT SHARING -- the net income shared is the Balance Sheet one, with the opening net income', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/profit_sharing_opening_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-profit-sharing-opening';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const token = jwt.sign({ sub: String(admin._id) }, process.env.JWT_SECRET);
  const request = async (path, body, method = body != null ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const year = new Date().getFullYear();
  try {
    const bank = await Account.create({ name: 'Bank' });
    const ids = [];
    for (const [name, amount] of [['cali', 600], ['cumar', 400]]) {
      const p = await request('/partners', { name });
      await request(`/partners/${p.data.id}/contribute`, { amount, paymentAccountId: bank.id });
      ids.push(p.data.id);
    }

    // No sales in the system, only this year's profit from before it.
    assert.equal((await request('/reports/opening-equity', { openingNetIncome: 2500, openingRetainedEarnings: 0 }, 'PUT')).status, 200);
    const sheet = await request('/reports/balance-sheet');
    assert.equal(sheet.status, 200, JSON.stringify(sheet));
    const preview = await request(`/partners/profit-sharing/preview?year=${year}`);
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.data.netProfit, 2500, 'the opening net income is shared');
    assert.equal(preview.data.netProfit, sheet.data.equity.netIncome, 'the same figure as the Balance Sheet');
    assert.deepEqual(preview.data.partners.map((p) => p.amount), [1500, 1000]);

    // The Profit & Loss shows it under Net Income and adds it.
    const pl = (await request(`/reports/profit-loss?from=${year}-01-01&to=${year}-12-31`)).data;
    const row = (label) => pl.rows.find((r) => r.label === label)?.values.total;
    assert.deepEqual([row('Net Income'), row(`Opening Net Income ${year} (old system)`), row('Net Income incl. opening')], [0, 2500, 2500]);
    const lastYear = (await request(`/reports/profit-loss?from=${year - 1}-01-01&to=${year - 1}-12-31`)).data;
    assert.equal(lastYear.rows.some((r) => /Opening Net Income/.test(r.label)), false);

    // Commissions: the year's profit has it; a month does not (no paying on it
    // twice) but shows the year so far.
    const cy = (await request(`/commissions/preview?type=year&key=${year}`)).data;
    assert.equal(cy.baseProfit, 2500, JSON.stringify(cy));
    const month = `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const cm = (await request(`/commissions/preview?type=month&key=${month}`)).data;
    assert.deepEqual([cm.baseProfit, cm.yearProfit], [0, 2500]);
    assert.equal((await request(`/commissions/preview?type=year&key=${year - 1}`)).data.baseProfit, 0);

    // Another year does not get it.
    assert.equal((await request(`/partners/profit-sharing/preview?year=${year - 1}`)).data.netProfit, 0);

    // It can be shared.
    const shared = await request('/partners/profit-sharing', { year, mode: 'CAPITAL', shares: preview.data.partners.map((p) => ({ partnerId: p.id, percent: p.percent })) });
    assert.ok(shared.status < 300, JSON.stringify(shared));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
