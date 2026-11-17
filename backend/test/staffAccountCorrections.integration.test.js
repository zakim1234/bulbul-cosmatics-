import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('ACCOUNTS -- staff see the admin cancelling their receipts, and their account is right', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/staff_account_fix_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-staff-account-fix';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cali Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'customers', 'customerMoney', 'accounts'] });
  const edahab = await Account.create({ name: 'eDahab' });
  const cumar = await Customer.create({ name: 'Cumar' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (u) => async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const admin = as(owner);
  const cash = as(cashier);
  const mine = async () => (await cash('/accounts')).data.accounts.find((a) => a.id === edahab.id).currentBalance;
  try {
    const stock = await admin('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 9 }] });
    const item = stock.data.rows[0].item;
    await admin('/sales', { customerId: cumar.id, items: [{ itemId: item, quantity: 4 }], paidAmount: 0 });
    await admin('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 4 }], paidAmount: 0 });
    await closeDay({ user: owner });
    await openDay({ user: owner });

    // The cashier takes an $18 debt payment into eDahab.
    const paid = await cash(`/customers/${cumar.id}/payments`, { amount: 18, paymentAccountId: edahab.id });
    assert.equal(paid.status, 201, JSON.stringify(paid));
    assert.equal(await mine(), 18);

    // The admin cancels it, money given back from eDahab.
    const paymentId = paid.data.paymentId || paid.data.payment?.id;
    const cancelled = await admin(`/customers/${cumar.id}/payments/${paymentId}/cancel`, { refundTo: 'ACCOUNT', reason: 'wrong' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
    assert.equal(await mine(), 0, "the cashier's eDahab is right again");
    const list = (await cash(`/accounts/${edahab.id}/transactions`)).data.transactions;
    const refund = list.find((t) => t.direction === 'OUT');
    assert.ok(refund, 'the cashier sees the cancellation');
    assert.equal(refund.byName, 'Owner');

    // A pending sale of theirs cancelled by the admin: listed, not counted.
    const sale = await cash('/sales', { customerId: cumar.id, items: [{ itemId: item, quantity: 2 }], paidAmount: 18, paymentAccountId: edahab.id });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    assert.equal(await mine(), 18);
    assert.equal((await admin(`/sales/${sale.data.id}/reverse`, { reason: 'mistake', refundTo: 'ACCOUNT' })).status, 200);
    assert.equal(await mine(), 0);
    const st = (await cash(`/accounts/${edahab.id}/statement`)).data;
    assert.ok(st.rows.some((r) => r.type === 'REFUND' && /cancelled invoice/.test(r.description)), 'the cancelled one is shown');
    assert.ok(st.rows.every((r) => !/Draft|pending Close Day/.test(r.description)), 'a sale is final at once, not Draft');
    assert.equal(st.closing, 0);

    // A payment put on the wrong customer (Cali, not Cumar), put right by the
    // admin: the cashier sees it was corrected, and by whom.
    const wrong = await cash(`/customers/${cali.id}/payments`, { amount: 9, paymentAccountId: edahab.id });
    assert.equal(wrong.status, 201, JSON.stringify(wrong));
    const wrongId = wrong.data.paymentId || wrong.data.payment?.id;
    assert.equal((await admin(`/customers/${cali.id}/payments/${wrongId}/move`, { toCustomerId: cumar.id })).status, 200);
    const fixed = (await cash(`/accounts/${edahab.id}/transactions`)).data.transactions.find((t) => t.amount === 9 && t.direction === 'IN');
    assert.deepEqual([fixed.correctionNote, fixed.correctedByName], ['Wrong customer corrected: Cali → Cumar', 'Super Admin Owner']);
    assert.equal(await mine(), 9, 'the money is still theirs, in eDahab');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
