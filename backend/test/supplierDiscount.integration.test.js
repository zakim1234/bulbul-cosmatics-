import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Supplier from '../src/models/Supplier.js';
import Purchase from '../src/models/Purchase.js';

test('SUPPLIERS -- owed 1000, paid 800 with a 200 discount: debt cleared, 800 leaves the account, 200 is Discount Received', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/supplier_discount_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-supplier-discount';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 100000 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    // We owe Hodan Pharma 1000 (opening balance).
    const ob = await api('/purchases/opening-balances/bulk', { rows: [{ supplierName: 'Hodan Pharma', amount: 1000 }] });
    assert.ok(ob.status < 300, JSON.stringify(ob));
    const supplier = await Supplier.findOne({ name: 'Hodan Pharma' });
    const invoice = await Purchase.findOne({ supplier: supplier._id });
    const sheet0 = (await api('/reports/balance-sheet')).data;
    assert.equal(sheet0.liabilities.payable, 1000);

    assert.equal((await api('/purchases/bulk-payments', { supplierId: supplier.id, purchaseIds: [invoice.id], amount: 800, discount: 300, paymentAccountId: evc.id })).status, 400, 'more than owed');
    const paid = await api('/purchases/bulk-payments', { supplierId: supplier.id, purchaseIds: [invoice.id], amount: 800, discount: 200, paymentAccountId: evc.id });
    assert.equal(paid.status, 201, JSON.stringify(paid));
    assert.deepEqual([paid.data.amount, paid.data.discount], [800, 200]);
    assert.equal((await Purchase.findById(invoice._id)).balanceCents, 0, 'nothing owed');
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 20000, 'only 800 left the account');

    const year = new Date().getFullYear();
    const pl = (await api(`/reports/profit-loss?from=${year}-01-01&to=${year}-12-31`)).data;
    assert.equal(pl.rows.find((r) => r.label === 'Discount Received').values.total, 200);
    const sheet = (await api('/reports/balance-sheet')).data;
    assert.equal(sheet.liabilities.payable, 0);
    assert.equal(sheet.differenceCents, sheet0.differenceCents, 'the Balance Sheet stays balanced');

    // Cancelling gives back the 800 only, and the 1000 is owed again.
    const cancelled = await api(`/purchases/bulk-payments/${paid.data.id}/cancel`, { reason: 'test' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
    assert.equal((await Purchase.findById(invoice._id)).balanceCents, 100000);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 100000);
    const pl2 = (await api(`/reports/profit-loss?from=${year}-01-01&to=${year}-12-31`)).data;
    assert.equal(pl2.rows.find((r) => r.label === 'Discount Received').values.total, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
