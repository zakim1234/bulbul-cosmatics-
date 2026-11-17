import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';

test('BALANCE SHEET -- "where from?" points at stock received with no purchase invoice', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/bs_gap_stock_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-bs-gap-stock';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    assert.equal((await api('/stock', { rows: [{ name: 'Panadol', quantity: 9, costPrice: 1, sellingPrice: 2 }] })).status, 201);
    const check = (await api('/reports/balance-sheet/check')).data;
    assert.equal(check.gap, 9, 'stock with no purchase invoice: Assets 9.00 higher');
    const f = check.findings.find((x) => x.key === 'stockWithoutPurchase');
    assert.equal(f.matchesGap, true, JSON.stringify(check.findings));
    assert.equal(f.items[0].amount, 9);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
