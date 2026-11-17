import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Liability from '../src/models/Liability.js';

test('BALANCE SHEET -- "where from?" uses the same date as the sheet, and points at records dated after today', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/bs_future_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-bs-future';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const get = async (path) => (await (await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: { Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` } })).json()).data;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);
    // A rent bill typed with tomorrow's date: owed now, an expense only tomorrow.
    await Liability.create({ name: 'Rent', category: 'Rent', amountCents: 763, date: tomorrow });
    const today = await get('/reports/balance-sheet/check');
    assert.equal(today.gap, -7.63, 'today: owed, not yet an expense');
    const f = today.findings.find((x) => x.key === 'futureDated');
    assert.equal(f.matchesGap, true, JSON.stringify(today.findings));
    // Asked for tomorrow (as the sheet on screen may be): the same day as the sheet.
    const asSheet = await get(`/reports/balance-sheet?date=${ymd(tomorrow)}`);
    const check = await get(`/reports/balance-sheet/check?date=${ymd(tomorrow)}`);
    assert.equal(check.gap, asSheet.difference, 'the panel and the sheet agree');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
