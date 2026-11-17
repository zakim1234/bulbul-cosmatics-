import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';

test('STATEMENT -- an invoice edited several times is counted once; the statement ends at what the customer owes', { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/stmt_edited_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-stmt-edited';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const evc = await Account.create({ name: 'EVC Plus', currentBalanceCents: 100000 });
  const item = await InventoryItem.create({ name: 'Panadol', itemCode: 'P-1', quantity: 500, costPriceCents: 100, sellingPriceCents: 1390 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const made = await api('/customers', { name: 'Cali Yaale Polyclinic', openingBalance: 2120.35 });
    assert.equal(made.status, 201, JSON.stringify(made));
    const id = made.data.id;
    // INV: $139 on credit, edited twice on credit, then edited to paid at sale.
    const sale = await api('/sales', { customerId: id, items: [{ itemId: item.id, quantity: 10 }], paidAmount: 0 });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    assert.equal((await api(`/sales/${sale.data.id}`, { items: [{ itemId: item.id, quantity: 10 }], paidAmount: 0 }, 'PUT')).status, 200);
    assert.equal((await api(`/sales/${sale.data.id}`, { items: [{ itemId: item.id, quantity: 10 }], paidAmount: 139, paymentAccountId: evc.id }, 'PUT')).status, 200);
    // A debt payment cancelled, then $70 paid.
    const p1 = await api(`/customers/${id}/payments`, { amount: 139, paymentAccountId: evc.id });
    assert.equal(p1.status, 201, JSON.stringify(p1));
    assert.equal((await api(`/customers/${id}/payments/${p1.data.paymentId || p1.data.payment?.id}/cancel`, { refundTo: 'ACCOUNT', reason: 'wrong' })).status, 200);
    assert.equal((await api(`/customers/${id}/payments`, { amount: 70, paymentAccountId: evc.id })).status, 201);

    const owed = (await Customer.findById(id)).balanceCents / 100;
    assert.equal(owed, 2050.35);
    const st = (await api(`/customers/${id}/statement`)).data;
    const last = st.ledger[st.ledger.length - 1];
    assert.equal(last.runningBalance, 2050.35, JSON.stringify(st.ledger.map((l) => [l.reference, l.type, l.debit, l.credit, l.runningBalance])));
    assert.equal(st.ledger.filter((l) => l.type === 'OPENING').length, 1, 'only the real opening balance');
    assert.equal(st.summary?.openingBalance ?? st.openingBalance, 2120.35);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
