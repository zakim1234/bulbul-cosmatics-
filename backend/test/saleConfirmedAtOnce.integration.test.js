import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';
import DayClose from '../src/models/DayClose.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('SALES -- a POS invoice is final at once (no Pending): customer, account and stock now; Close Day counts it once', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/sale_at_once_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-sale-at-once';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cashier', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'editInvoices'] });
  const evc = await Account.create({ name: 'EVC Plus' });
  const cali = await Customer.create({ name: 'Mashhur Pharma' });
  const item = await InventoryItem.create({ name: 'Takomol', itemCode: 'T-1', quantity: 10, costPriceCents: 200, sellingPriceCents: 410 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (user, path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const gap = (await buildBalanceSheet()).differenceCents;
    // $8.20 invoice, $2 paid now: $6.20 goes straight onto the customer.
    const made = await api(cashier, '/sales', { customerId: cali.id, items: [{ itemId: item.id, quantity: 2 }], paidAmount: 2, paymentAccountId: evc.id });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.deepEqual([made.data.status, made.data.awaitingDayClose], ['CONFIRMED', true], 'not Pending');
    assert.equal((await Customer.findById(cali._id)).balanceCents, 620, 'on the customer now');
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 200, 'in the account now');
    assert.equal((await InventoryItem.findById(item._id)).quantity, 8, 'out of stock now');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'Balance Sheet stays balanced');

    // Same day: the cashier can still edit it (Edit invoices is enough).
    const edited = await api(cashier, `/sales/${made.data.id}`, { items: [{ itemId: item.id, quantity: 3 }], paidAmount: 2, paymentAccountId: evc.id }, 'PUT');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.equal((await Customer.findById(cali._id)).balanceCents, 1030);
    assert.equal((await InventoryItem.findById(item._id)).quantity, 7);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 200);

    // Close Day counts it once and posts nothing twice.
    await closeDay({ user: owner });
    const dc = await DayClose.findOne();
    assert.equal(dc.revenueCents, 1230);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 200, 'not posted twice');
    assert.equal((await Customer.findById(cali._id)).balanceCents, 1030, 'not charged twice');

    // After Close Day: editing needs "Edit invoices after Close Day".
    await openDay({ user: owner });
    const late = await api(cashier, `/sales/${made.data.id}`, { items: [{ itemId: item.id, quantity: 1 }], paidAmount: 2, paymentAccountId: evc.id }, 'PUT');
    assert.equal(late.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
