import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import AccountTransaction from '../src/models/AccountTransaction.js';

test("ACCOUNTS -- a cashier's own sale corrected by the Super Admin: their account is put right and they see who did it", { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/staff_sale_fix_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-staff-sale-fix';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cali Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'customers', 'accounts', 'editInvoices'] });
  const other = await User.create({ username: 'other', name: 'Other Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'customers', 'accounts'] });
  const edahab = await Account.create({ name: 'eDahab' });
  const evc = await Account.create({ name: 'EVC Plus' });
  const cumar = await Customer.create({ name: 'Cumar' });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (u) => async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const admin = as(owner);
  const cash = as(cashier);
  const seen = async (u, acc) => (await as(u)('/accounts')).data.accounts.find((a) => a.id === acc.id).currentBalance;
  try {
    const stock = await admin('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 10 }] });
    const item = stock.data.rows[0].item;

    // 1. The cashier sells $30, $30 paid into eDahab -- it is in their account at once.
    const sale = await cash('/sales', { customerId: cumar.id, items: [{ itemId: item, quantity: 3 }], paidAmount: 30, paymentAccountId: edahab.id });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    assert.equal(await seen(cashier, edahab), 30);
    assert.equal(await seen(other, edahab), 0, "another cashier does not see it as theirs");

    // 2. The Super Admin edits it: only $20 was paid, into EVC, not eDahab.
    const edited = await admin(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 3 }], paidAmount: 20, paymentAccountId: evc.id }, 'PUT');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.deepEqual([await seen(cashier, edahab), await seen(cashier, evc)], [0, 20], "the cashier's accounts are right again");
    assert.equal((await Customer.findById(cumar._id)).balanceCents, 1000, 'the customer owes the $10 not paid');
    // They see the Super Admin changed it, and it is locked for them.
    const mineNow = (await cash(`/sales/${sale.data.id}`)).data;
    assert.deepEqual([mineNow.editedByName, mineNow.lockedBySuperAdmin], ['Super Admin Owner', true]);
    assert.equal((await cash(`/sales/${sale.data.id}`, { items: [{ itemId: item, quantity: 1 }], paidAmount: 0 }, 'PUT')).status, 403, 'locked for the cashier');
    // The eDahab statement shows the money that left it, still listed as theirs.
    const edahabRows = (await cash(`/accounts/${edahab.id}/transactions`)).data.transactions;
    assert.ok(edahabRows.some((t) => t.direction === 'OUT' && t.amount === 30), JSON.stringify(edahabRows));
    const evcRows = (await cash(`/accounts/${evc.id}/transactions`)).data.transactions;
    assert.ok(evcRows.some((t) => t.amount === 20 && /edited/.test(t.correctionNote || '') && t.correctedByName === 'Super Admin Owner'), 'the cashier sees the Super Admin edited it');

    // 3. Another of their sales paid into the wrong account, moved by the Super Admin.
    const sale2 = await cash('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 1 }], paidAmount: 10, paymentAccountId: edahab.id });
    assert.equal(sale2.status, 201, JSON.stringify(sale2));
    const txn = await AccountTransaction.findOne({ referenceId: sale2.data.id, type: 'SALE_PAYMENT' });
    assert.equal((await admin(`/accounts/transactions/${txn.id}/move`, { toAccountId: evc.id })).status, 200);
    assert.deepEqual([await seen(cashier, edahab), await seen(cashier, evc)], [0, 30], 'moved in their accounts too');
    const moved = (await cash(`/accounts/${edahab.id}/transactions`)).data.transactions.find((t) => t.id === txn.id);
    assert.ok(moved?.movedToName === 'EVC Plus', JSON.stringify(moved));

    // 4. Put on the wrong customer: moved to the right one by the Super Admin.
    const moveInv = await admin(`/sales/${sale2.data.id}/transfer`, { customerId: cumar.id, reason: 'wrong customer' });
    assert.equal(moveInv.status, 200, JSON.stringify(moveInv));
    const fixedRows = (await cash(`/accounts/${evc.id}/transactions`)).data.transactions;
    assert.ok(fixedRows.some((t) => /Cali → Cumar/.test(t.correctionNote || '') && t.correctedByName === 'Super Admin Owner'), JSON.stringify(fixedRows.map((t) => [t.description, t.correctionNote, t.correctedByName])));
    assert.deepEqual([await seen(cashier, edahab), await seen(cashier, evc)], [0, 30], 'the money stays theirs');
    // The earlier wrong-account note is kept on the original line.
    const original = (await cash(`/accounts/${edahab.id}/transactions`)).data.transactions.find((t) => t.id === txn.id);
    assert.ok(/Wrong account corrected: eDahab → EVC Plus/.test(original.correctionNote) && /Cali → Cumar/.test(original.correctionNote), original.correctionNote);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
