import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Customer from '../src/models/Customer.js';

// Only the admin edits or deletes saved records; anyone else needs the admin
// to switch on 'editRecords' / 'deleteRecords' for them.
test('EDIT / DELETE PERMISSION -- a cashier cannot edit or delete until the admin allows it', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/edit_delete_perm_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-edit-delete-secret';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused' });
  const cashier = await User.create({ username: 'cumar', name: 'Cumar', passwordHash: 'unused', role: 'cashier', permissions: ['customers', 'pos', 'createCustomers'] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (path, body, method, as) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(as._id) }, process.env.JWT_SECRET)}` },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const c = await Customer.create({ name: 'Cali', phone: '111' });

    // Adding is fine; changing or removing is not.
    assert.equal((await request('/customers', { name: 'New one', phone: '222' }, 'POST', cashier)).status, 201);
    const edit = await request(`/customers/${c.id}`, { name: 'Cali X', phone: '111' }, 'PUT', cashier);
    assert.equal(edit.status, 403);
    assert.match(edit.message, /permission to edit/);
    const openingBalanceDenied = await request(`/customers/${c.id}/opening-balance`, { openingBalance: 10 }, 'PUT', cashier);
    assert.equal(openingBalanceDenied.status, 403, 'changing the opening balance still needs customerMoney');
    const del = await request(`/customers/${c.id}`, null, 'DELETE', cashier);
    assert.equal(del.status, 403);
    assert.match(del.message, /permission to delete/);
    assert.ok(await Customer.findById(c.id), 'still there');

    // Money on the customer page (withdraw, deposit, pay debt) needs its own switch.
    const evc = await (await import('../src/models/Account.js')).default.create({ name: 'EVC' });
    await Customer.updateOne({ _id: c._id }, { walletBalanceCents: 5000 });
    const wd = await request(`/customers/${c.id}/wallet/withdraw`, { amount: 10, paymentAccountId: evc.id }, 'POST', cashier);
    assert.equal(wd.status, 403);
    assert.equal((await request(`/customers/${c.id}/wallet/deposit`, { amount: 10, paymentAccountId: evc.id }, 'POST', cashier)).status, 403);
    assert.equal((await Customer.findById(c.id)).walletBalanceCents, 5000, 'wallet untouched');
    cashier.permissions.push('customerMoney');
    await cashier.save();
    const openingBalance = await request(`/customers/${c.id}/opening-balance`, { openingBalance: 10 }, 'PUT', cashier);
    assert.equal(openingBalance.status, 200, 'customerMoney allows changing the opening balance without editRecords');
    assert.equal(openingBalance.data.balance, 10);
    assert.equal((await request(`/customers/${c.id}/wallet/withdraw`, { amount: 10, paymentAccountId: evc.id }, 'POST', cashier)).status, 201);

    // The admin switches editing and deletion on. Delete removes the customer
    // from active lists while retaining its financial and sales history.
    cashier.permissions.push('editRecords');
    await cashier.save();
    assert.equal((await request(`/customers/${c.id}`, { name: 'Cali X', phone: '111' }, 'PUT', cashier)).status, 200);
    assert.equal((await request(`/customers/${c.id}`, null, 'DELETE', cashier)).status, 403, 'edit does not allow delete');
    cashier.permissions.push('deleteRecords');
    await cashier.save();
    const withMoney = await request(`/customers/${c.id}`, null, 'DELETE', cashier);
    assert.equal(withMoney.status, 200, JSON.stringify(withMoney));
    const archived = await Customer.findById(c.id);
    assert.ok(archived.archivedAt);
    assert.equal(archived.balanceCents, 1000, 'debt is preserved');
    assert.equal(archived.walletBalanceCents, 4000, 'wallet is preserved');
    const visibleCustomers = await request('/customers', null, 'GET', cashier);
    assert.equal(visibleCustomers.data.some((row) => String(row.id) === c.id), false, 'archived customer is removed from the active list');
    const searchResults = await request('/customers/search?q=Cali', null, 'GET', cashier);
    assert.equal(searchResults.data.some((row) => String(row.id) === c.id), false, 'archived customer is not offered for new sales');

    // Archiving a customer with a pending invoice leaves Close Day's reference intact.
    const InventoryItem = (await import('../src/models/InventoryItem.js')).default;
    const item = await InventoryItem.create({ name: 'Zinc', itemCode: 'ZN-1', quantity: 10, costPriceCents: 100, sellingPriceCents: 400 });
    const c3 = await Customer.create({ name: 'Cumar', phone: '444' });
    assert.equal((await request('/sales', { customerId: c3.id, items: [{ itemId: item.id, quantity: 1 }], paidAmount: 0 }, 'POST', admin)).status, 201);
    const pendingDel = await request(`/customers/${c3.id}`, null, 'DELETE', admin);
    assert.equal(pendingDel.status, 200);
    assert.ok((await Customer.findById(c3.id)).archivedAt);
    const archivedSale = await request('/sales', { customerId: c3.id, items: [{ itemId: item.id, quantity: 1 }], paidAmount: 0 }, 'POST', admin);
    assert.equal(archivedSale.status, 404, 'archived customers cannot be used for new sales');

    // Customers without sales history are also removed from active lists.
    const c2 = await Customer.create({ name: 'Faadumo', phone: '333' });
    assert.equal((await request(`/customers/${c2.id}`, null, 'DELETE', admin)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
