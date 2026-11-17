import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Branch from '../src/models/Branch.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import Expense from '../src/models/Expense.js';
import AuditLog from '../src/models/AuditLog.js';
import InventoryItem from '../src/models/InventoryItem.js';
import { clearBranchCache } from '../src/middleware/auth.js';
import { runWithBranch } from '../src/services/branchContext.js';

// Holes found in the security review, each one closed: the delete permission
// cannot be dodged with ".../VOID" or ".../void/", customer opening balances
// must be real amounts of 0 or more, payments need the Customers permission,
// "$" operators never reach the database, amounts that round to 0.00 are
// refused, and price changes at the till are kept in the audit log.
test('SECURITY FIXES -- permission bypass, opening balances, payments, operators, zero amounts, price audit', { timeout: 120000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/security_fixes_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-security-fixes-secret';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const branch = await Branch.create({ name: 'Main' });
  clearBranchCache();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const user = (fields) => User.create({ passwordHash: 'unused', branch: branch._id, ...fields });
    const admin = await user({ username: 'admin@x.com', name: 'Admin', role: 'admin', adminGranted: ['createCustomers'] });
    const limitedAdmin = await user({ username: 'limited@x.com', name: 'Limited Admin', role: 'admin', adminDenied: ['deleteRecords'] });
    const manager = await user({ username: 'mgr@x.com', name: 'Manager', role: 'manager', permissions: ['expenses', 'customers', 'customerMoney', 'pos'] });
    const cashier = await user({ username: 'cash@x.com', name: 'Cashier', role: 'cashier', permissions: ['pos'] });
    const nobody = await user({ username: 'nobody@x.com', name: 'Nobody', role: 'custom', permissions: [] });
    const account = await runWithBranch(branch._id, () => Account.create({ name: 'Cash', currentBalanceCents: 1_000_000 }));
    const item = await runWithBranch(branch._id, () => InventoryItem.create({ name: 'Panadol', itemCode: 'P-1', quantity: 100, costPriceCents: 500, sellingPriceCents: 1000 }));
    const [A, L, M, C, N] = [admin, limitedAdmin, manager, cashier, nobody].map(as);

    // 1. Voiding needs 'deleteRecords' however the address is written.
    const expense = async () => (await M('/expenses', { category: 'Rent', amount: 5, paymentAccountId: account.id })).data.id;
    for (const [who, call] of [['manager', M], ['admin without deleteRecords', L]]) {
      const id = await expense();
      for (const tail of ['void', 'void/', 'VOID', 'Void/']) {
        const r = await call(`/expenses/${id}/${tail}`, { reason: 'try' });
        assert.equal(r.status, 403, `${who} POST .../${tail}: ${JSON.stringify(r)}`);
      }
      assert.notEqual((await Expense.findById(id)).status, 'VOIDED', `${who}: the expense is untouched`);
    }
    const allowed = await expense();
    assert.equal((await A(`/expenses/${allowed}/void`, { reason: 'mistake' })).status, 200, 'an admin still voids normally');

    // 2. Opening balance on a new customer: 0 or more, a real amount.
    for (const openingBalance of [-1000, 'Infinity', 1e300, 'abc', '-0.5']) {
      const r = await A('/customers', { name: `Bad ${openingBalance}`, openingBalance });
      assert.equal(r.status, 400, `openingBalance ${openingBalance}: ${JSON.stringify(r)}`);
    }
    assert.equal(await Customer.countDocuments({ name: /^Bad / }), 0);
    for (const [openingBalance, cents] of [[undefined, 0], ['', 0], ['0', 0], [12.5, 1250], ['7', 700]]) {
      const r = await A('/customers', { name: `Good ${cents} ${String(openingBalance)}`, ...(openingBalance !== undefined ? { openingBalance } : {}) });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal((await Customer.findById(r.data.id)).balanceCents, cents);
    }
    // Wrong types are read as text, never a server error.
    assert.equal((await A('/customers', { name: 'Typed', phone: 615000111 })).status, 201);
    assert.equal((await A('/customers', { name: { first: 'x' } })).status < 500, true);
    const typed = await Customer.findOne({ name: 'Typed' });
    assert.equal(typed.phone, '615000111');
    assert.equal((await A(`/customers/${typed.id}`, { phone: 615000222 }, 'PUT')).status, 200, 'edit with a number phone');
    assert.equal((await Customer.findById(typed.id)).phone, '615000222');
    // The customers sheet refuses a huge opening balance too.
    assert.equal((await A('/customers/bulk', { rows: [{ name: 'Sheet Huge', openingBalance: 1e300 }] })).status, 400);

    // 3. Payments and their receipts need the Customers permission.
    const customer = await runWithBranch(branch._id, () => Customer.create({ name: 'Faadumo', phone: '1' }));
    const deposit = await M(`/customers/${customer.id}/wallet/deposit`, { amount: 20, paymentAccountId: account.id });
    assert.equal(deposit.status, 201, JSON.stringify(deposit));
    assert.equal((await N('/payments')).status, 403);
    assert.equal((await C('/payments')).status, 403);
    assert.equal((await M('/payments')).status, 200);

    // 3b. Quotations: reading one or converting it needs POS or Quotations.
    const someId = new mongoose.Types.ObjectId().toString();
    assert.equal((await N(`/quotations/${someId}`)).status, 403);
    assert.equal((await N(`/quotations/${someId}/convert`, {})).status, 403);
    assert.equal((await C(`/quotations/${someId}`)).status, 404, 'a cashier with POS passes the gate');

    // 3c. A token whose user id is not a plain id is refused.
    const odd = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me`, { headers: { Authorization: `Bearer ${jwt.sign({ sub: { $ne: null } }, process.env.JWT_SECRET)}` } });
    assert.equal(odd.status, 401);

    // 4. "$" operators never reach the database.
    assert.equal((await A('/payments?customer[$ne]=000000000000000000000000')).status, 400);
    assert.equal((await A('/inventory?category[$exists]=false')).status, 400);
    const injected = await C('/sales', { customerId: { $ne: null }, items: [{ itemId: item.id, quantity: 1 }], paidAmount: 0 });
    assert.equal(injected.status, 400, JSON.stringify(injected));
    assert.equal((await A('/inventory?search=pan')).status, 200, 'ordinary searches still work');
    assert.equal((await C('/chat/messages', { to: String(admin._id), text: 'price is $5, {"$ne": 1}' })).status, 201, '"$" inside text is fine');

    // 5. An amount that rounds to 0.00 is not a payment.
    assert.equal((await M(`/customers/${customer.id}/wallet/deposit`, { amount: 0.004, paymentAccountId: account.id })).status, 400);
    assert.equal((await M(`/customers/${customer.id}/wallet/withdraw`, { amount: 0.001, paymentAccountId: account.id })).status, 400);
    assert.equal((await M(`/customers/${customer.id}/wallet/deposit`, { amount: 0.01, paymentAccountId: account.id })).status, 201);

    // 6. Price changes at the till are kept in the audit log (the sale itself is unchanged).
    const listPrice = await C('/sales', { customerId: customer.id, items: [{ itemId: item.id, quantity: 1, unitPrice: 10 }], paidAmount: 0 });
    assert.equal(listPrice.status, 201, JSON.stringify(listPrice));
    assert.equal(await AuditLog.countDocuments({ action: 'sale.price_override' }), 0, 'list price: nothing to record');
    const cheap = await C('/sales', { customerId: customer.id, items: [{ itemId: item.id, quantity: 50, unitPrice: 0.01 }], discount: 0.1, paidAmount: 0 });
    assert.equal(cheap.status, 201, 'selling below list price still works');
    const log = await AuditLog.findOne({ action: 'sale.price_override', entityId: cheap.data.id });
    assert.ok(log, 'the price change is recorded');
    assert.equal(log.userName, 'Cashier');
    assert.deepEqual(log.details.lines, [{ item: 'Panadol', quantity: 50, listPrice: 10, soldAt: 0.01, lineDiscount: 0 }]);
    assert.equal(log.details.invoiceDiscount, 0.1);
    assert.equal(log.details.total, 0.4);
    const edited = await A(`/sales/${listPrice.data.id}`, { items: [{ itemId: item.id, quantity: 1, unitPrice: 10, discount: 2 }], paidAmount: 0 }, 'PUT');
    assert.equal(edited.status, 200, JSON.stringify(edited));
    const editLog = await AuditLog.findOne({ action: 'sale.price_override', entityId: listPrice.data.id });
    assert.ok(editLog, 'an edited invoice is recorded too');
    assert.equal(editLog.details.lines[0].lineDiscount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    clearBranchCache();
  }
});
