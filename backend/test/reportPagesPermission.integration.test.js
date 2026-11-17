import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';

test('REPORTS -- Items Sold, Refunds, Merchant VAT and Staff Daily can each be opened for one person', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/report_pages_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-report-pages';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const plain = await User.create({ username: 'cashier', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos'] });
  const given = await User.create({ username: 'given', name: 'Given', passwordHash: 'unused', role: 'cashier', permissions: ['itemsSoldReport', 'refundsReport', 'merchantVatReport', 'staffDailyReport'] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const get = async (user, path) => (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: { Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` } })).status;
  const pages = ['/reports/items-sold/periods?type=day', '/sales/refunds', '/reports/merchant-vat', '/reports/staff-daily?month=2026-11', '/reports/users'];
  try {
    for (const p of pages) {
      assert.equal(await get(owner, p), 200, `super admin ${p}`);
      assert.equal(await get(admin, p), 200, `admin keeps ${p}`);
      assert.equal(await get(plain, p), 403, `not given ${p}`);
      assert.equal(await get(given, p), 200, `given ${p}`);
    }
    // Only those pages: the rest of Reports stays the admin's.
    assert.equal(await get(given, '/reports/sales'), 403);
    assert.equal(await get(given, '/reports/balance-sheet'), 403);
    // An admin the Super Admin took Staff Daily away from cannot open it.
    await User.updateOne({ _id: admin._id }, { $set: { adminDenied: ['staffDailyReport'] } });
    assert.equal(await get(admin, '/reports/staff-daily?month=2026-11'), 403);
    assert.equal(await get(admin, '/reports/merchant-vat'), 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
