import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Branch from '../src/models/Branch.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import InventoryItem from '../src/models/InventoryItem.js';
import Sale from '../src/models/Sale.js';
import Payment from '../src/models/Payment.js';
import Expense from '../src/models/Expense.js';
import StockAdjustment from '../src/models/StockAdjustment.js';
import CustomerLedger from '../src/models/CustomerLedger.js';
import { clearBranchCache } from '../src/middleware/auth.js';
import { runWithBranch } from '../src/services/branchContext.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('REPORTS CLEAR ALL -- sales, payments, expenses and adjustments go; accounts and customers keep the rest', { timeout: 90000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/reports_clear_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-reports-clear';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const main = await Branch.create({ name: 'Main' });
  const other = await Branch.create({ name: 'Other' });
  clearBranchCache();
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true, bulkToolsBranches: [main._id] });
  const admin = await User.create({ username: 'adm', name: 'Adm', passwordHash: 'unused', role: 'admin', branch: main._id });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user, branch = main._id) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Branch-Id': String(branch) }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  const inMain = (fn) => runWithBranch(main._id, fn);
  try {
    const evc = await inMain(() => Account.create({ name: 'EVC Plus', openingBalanceCents: 10000, currentBalanceCents: 10000 }));
    const otherAccount = await runWithBranch(other._id, () => Account.create({ name: 'EVC Plus', currentBalanceCents: 7000 }));
    const item = await inMain(() => InventoryItem.create({ name: 'Widget', itemCode: 'W-1', quantity: 100, costPriceCents: 100, sellingPriceCents: 1000 }));
    const customer = (await api('/customers', { name: 'Cali', phone: '1', openingBalance: 50 })).data;

    // A credit sale ($100), a paid sale ($30), a debt payment ($20), a wallet
    // deposit ($15), an expense ($10) and a stock adjustment.
    assert.equal((await api('/sales', { customerId: customer.id, items: [{ itemId: item.id, quantity: 10 }] })).status, 201);
    assert.equal((await api('/sales', { customerId: customer.id, items: [{ itemId: item.id, quantity: 3 }], paidAmount: 30, paymentAccountId: evc.id })).status, 201);
    await inMain(() => closeDay({ user: owner }));
    await inMain(() => openDay({ user: owner }));
    assert.equal((await api(`/customers/${customer.id}/payments`, { amount: 20, paymentAccountId: evc.id })).status, 201);
    assert.equal((await api(`/customers/${customer.id}/wallet/deposit`, { amount: 15, paymentAccountId: evc.id })).status, 201);
    const category = (await api('/expenses/categories')).data[0];
    const exp = await api('/expenses', { category: category.name || category, amount: 10, paymentAccountId: evc.id });
    assert.equal(exp.status, 201, JSON.stringify(exp));
    assert.equal((await api('/stock-adjustments', { itemId: item.id, direction: 'DECREASE', quantity: 1, reason: 'EXPIRED' })).status, 201);
    await inMain(() => closeDay({ user: owner }));
    await inMain(() => openDay({ user: owner }));

    const before = (await api('/reports/balance-sheet')).data.equity.netIncome;
    assert.notEqual(before, 0);
    const itemQty = (await InventoryItem.findById(item.id)).quantity;

    // Refused: not switched on for that branch, a branch admin, no DELETE, the all-branches view.
    assert.equal((await as(owner, other._id)('/reports/clear', { confirm: 'DELETE' })).status, 403);
    assert.equal((await as(admin)('/reports/clear', { confirm: 'DELETE' })).status, 403);
    assert.equal((await api('/reports/clear', { confirm: 'no' })).status, 400);
    assert.equal((await as(owner, 'all')('/reports/clear', { confirm: 'DELETE' })).status, 400);
    assert.equal(await inMain(() => Sale.countDocuments()), 2);

    const cleared = await api('/reports/clear', { confirm: 'DELETE' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    assert.deepEqual([cleared.data.sales, cleared.data.expenses, cleared.data.stockAdjustments], [2, 1, 1]);

    // Net Income is 0; nothing those records made is left behind.
    assert.equal((await api('/reports/balance-sheet')).data.equity.netIncome, 0);
    assert.equal(await inMain(() => Sale.countDocuments()), 0);
    assert.equal(await inMain(() => Payment.countDocuments()), 0);
    assert.equal(await inMain(() => Expense.countDocuments()), 0);
    assert.equal(await inMain(() => StockAdjustment.countDocuments()), 0);

    // The account keeps its opening and the wallet deposit only: 100 + 15.
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 11500);
    // The customer keeps the opening debt and the wallet deposit.
    const c = await Customer.findById(customer.id);
    assert.deepEqual([c.balanceCents, c.walletBalanceCents, c.totalPurchasedCents], [5000, 1500, 0]);
    assert.deepEqual((await CustomerLedger.find({ customer: c._id })).map((l) => l.type), ['ADJUSTMENT']);
    // Stock and the other branch are not touched.
    assert.equal((await InventoryItem.findById(item.id)).quantity, itemQty);
    assert.equal((await Account.findById(otherAccount._id)).currentBalanceCents, 7000);

    // Selling again works and counts from 0.
    assert.equal((await api('/sales', { customerId: customer.id, items: [{ itemId: item.id, quantity: 1 }], paidAmount: 10, paymentAccountId: evc.id })).status, 201);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
