import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Supplier from '../src/models/Supplier.js';
import Branch from '../src/models/Branch.js';
import { clearBranchCache } from '../src/middleware/auth.js';
import { runWithBranch } from '../src/services/branchContext.js';

test('PAY SUPPLIERS -- the Super Admin allows an admin; that admin can allow the staff below', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/pay_suppliers_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-pay-suppliers';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const branch = await Branch.create({ name: 'Main' });
  clearBranchCache();
  const superAdmin = await User.create({ username: 'super', name: 'Super', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin', branch: branch._id });
  const cashier = await User.create({ username: 'cashier', name: 'Cashier', passwordHash: 'unused', role: 'cashier', branch: branch._id, permissions: ['purchases'] });
  const account = await runWithBranch(branch._id, () => Account.create({ name: 'EVC', currentBalanceCents: 100000 }));
  const supplier = await runWithBranch(branch._id, () => Supplier.create({ name: 'ABC' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (who, path, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Branch-Id': String(branch._id), Authorization: `Bearer ${jwt.sign({ sub: String(who._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    // An unpaid invoice can be saved by anyone with Purchase Invoices.
    const invoice = await request(cashier, '/purchases', { supplierId: supplier.id, supplierInvoiceNumber: 'A1', amount: 100, amountPaid: 0 });
    assert.equal(invoice.status, 201, JSON.stringify(invoice));
    const id = invoice.data.id;
    const bulk = { supplierId: supplier.id, purchaseIds: [id], amount: 10, paymentAccountId: account.id };
    const single = { amount: 10, paymentAccountId: account.id };

    // Not allowed: every way of paying is refused, for the admin too.
    for (const who of [admin, cashier]) {
      assert.equal((await request(who, '/purchases/bulk-payments', bulk)).status, 403, 'Pay this supplier');
      assert.equal((await request(who, `/purchases/${id}/payments`, single)).status, 403, 'Add Payment');
      assert.equal((await request(who, '/purchases', { supplierId: supplier.id, supplierInvoiceNumber: 'P', amount: 5, purchaseAccountId: account.id })).status, 403, 'a new invoice paid at once');
    }

    // The admin cannot allow anyone (or themselves) until allowed.
    assert.equal((await request(admin, `/users/${cashier.id}`, { permissions: ['purchases', 'paySuppliers'] }, 'PUT')).status, 403);
    assert.equal((await request(admin, `/users/${admin.id}`, { adminGranted: ['paySuppliers'] }, 'PUT')).status, 403);

    // The Super Admin pays, and allows the admin.
    assert.equal((await request(superAdmin, '/purchases/bulk-payments', bulk)).status, 201);
    assert.equal((await request(superAdmin, `/users/${admin.id}`, { adminGranted: ['paySuppliers'] }, 'PUT')).status, 200);
    assert.equal((await request(admin, '/purchases/bulk-payments', bulk)).status, 201, 'the allowed admin pays');

    // That admin allows the cashier, who can pay but cannot pass it on.
    assert.equal((await request(admin, `/users/${cashier.id}`, { permissions: ['purchases', 'paySuppliers'] }, 'PUT')).status, 200);
    assert.equal((await request(cashier, `/purchases/${id}/payments`, single)).status, 201, 'the allowed cashier pays');
    assert.equal((await request(cashier, `/users/${cashier.id}`, { permissions: ['purchases', 'paySuppliers', 'accounts'] }, 'PUT')).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
