import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Customer from '../src/models/Customer.js';

test('CUSTOMERS SHEET -- credit limits for many customers in one save (admins only)', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/sheet_limit_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-sheet-limit';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const clerk = await User.create({ username: 'clerk', name: 'Clerk', passwordHash: 'unused', role: 'cashier', permissions: ['customers', 'customersSheet', 'createCustomers'] });
  const a = await Customer.create({ name: 'Qoslaaye Pharma' });
  const b = await Customer.create({ name: 'Mashhur Pharma', creditLimitCents: 5000 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, user = owner) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const sheet = (await api('/customers/sheet')).data;
    assert.deepEqual(sheet.map((r) => [r.name, r.creditLimit]), [['Mashhur Pharma', 50], ['Qoslaaye Pharma', null]]);
    const saved = await api('/customers/bulk', { rows: [
      { id: a.id, name: 'Qoslaaye Pharma', phone: '', openingBalance: 0, creditLimit: 300 },
      { id: b.id, name: 'Mashhur Pharma', phone: '', openingBalance: 0, creditLimit: null },
      { key: 'k1', name: 'Cali Pharmacy', phone: '61', openingBalance: 0, creditLimit: 0 },
    ] });
    assert.equal(saved.status, 201, JSON.stringify(saved));
    assert.equal((await Customer.findById(a._id)).creditLimitCents, 30000, '$300 set');
    assert.equal((await Customer.findById(b._id)).creditLimitCents, null, 'blank = no limit');
    assert.equal((await Customer.findOne({ name: 'Cali Pharmacy' })).creditLimitCents, 0, 'a new one with 0 = nothing on credit');
    // A cashier cannot change limits from the sheet.
    assert.equal((await api('/customers/bulk', { rows: [{ id: a.id, name: 'Qoslaaye Pharma', phone: '', openingBalance: 0, creditLimit: 999 }] }, clerk)).status, 403);
    assert.equal((await api('/customers/bulk', { rows: [{ id: a.id, name: 'Qoslaaye Pharma', phone: '615', openingBalance: 0 }] }, clerk)).status, 201, 'without the limit: fine');
    assert.equal((await Customer.findById(a._id)).creditLimitCents, 30000, 'limit unchanged');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('CREDIT LIMITS SHEET -- name and limit only, many in one save; admins only', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/limits_sheet_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-limits-sheet';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const clerk = await User.create({ username: 'clerk', name: 'Clerk', passwordHash: 'unused', role: 'cashier', permissions: ['customers'] });
  const given = await User.create({ username: 'given', name: 'Given', passwordHash: 'unused', role: 'cashier', permissions: ['customers', 'creditLimits'] });
  const a = await Customer.create({ name: 'Qoslaaye Pharma' });
  const b = await Customer.create({ name: 'Mashhur Pharma', creditLimitCents: 5000 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const post = async (rows, user = owner) => (await fetch(`http://127.0.0.1:${server.address().port}/api/customers/credit-limits`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, body: JSON.stringify({ rows }) })).status;
  try {
    // The sheet opens (its list of customers, limits and debt).
    const list = await (await fetch(`http://127.0.0.1:${server.address().port}/api/customers/credit-limits`, { headers: { Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` } })).json();
    assert.equal(list.success, true, JSON.stringify(list));
    assert.deepEqual(list.data.map((r) => [r.name, r.creditLimit]), [['Mashhur Pharma', 50], ['Qoslaaye Pharma', null]]);
    assert.equal(await post([{ id: a.id, creditLimit: 300 }, { id: b.id, creditLimit: null }]), 201);
    assert.equal((await Customer.findById(a._id)).creditLimitCents, 30000);
    assert.equal((await Customer.findById(b._id)).creditLimitCents, null);
    assert.equal(await post([{ id: a.id, creditLimit: 5 }], clerk), 403, 'not given');
    assert.equal(await post([{ id: a.id, creditLimit: 5 }], given), 201, 'given: anyone can');
    assert.equal(await post([{ id: a.id, creditLimit: -1 }]), 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
