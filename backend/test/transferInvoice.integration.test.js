import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import CustomerLedger from '../src/models/CustomerLedger.js';
import Payment from '../src/models/Payment.js';
import Sale from '../src/models/Sale.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('MOVE INVOICE -- an invoice on the wrong customer moves to the right one, money and all; only for the Super Admin or an admin allowed', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/transfer_invoice_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-transfer-invoice';
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const superAdmin = await User.create({ username: 'super', name: 'Super', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const admin = await User.create({ username: 'admin', name: 'Admin', passwordHash: 'unused', role: 'admin' });
  const cashier = await User.create({ username: 'cashier', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['pos', 'customers'] });
  const evc = await Account.create({ name: 'EVC', currentBalanceCents: 0 });
  const cali = await Customer.create({ name: 'Cali' });
  const cumar = await Customer.create({ name: 'Cumar' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const tokenOf = (u) => jwt.sign({ sub: String(u._id) }, process.env.JWT_SECRET);
  const request = async (path, body, method = 'POST', who = superAdmin) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOf(who)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    const stock = await request('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 10 }] });
    const item = stock.data.rows[0].item;
    // A 100 sale, 30 paid at the sale, put on Cali by mistake.
    const sale = await request('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 10 }], paidAmount: 30, paymentAccountId: evc.id });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    await closeDay({ user: superAdmin });
    await openDay({ user: superAdmin });
    assert.equal((await Customer.findById(cali.id)).balanceCents, 7000);

    // Who may move it.
    const body = { customerId: cumar.id, reason: 'Put on the wrong customer' };
    assert.equal((await request(`/sales/${sale.data.id}/transfer`, body, 'POST', cashier)).status, 403, 'staff only when ticked');
    assert.equal((await request(`/sales/${sale.data.id}/transfer`, body, 'POST', admin)).status, 403, 'a branch admin only when allowed');
    assert.equal((await request(`/sales/${sale.data.id}/transfer`, { customerId: cumar.id }, 'POST', superAdmin)).status, 400, 'a reason is needed');

    // The Super Admin allows the admin; the admin moves it.
    assert.equal((await request(`/users/${admin.id}`, { adminGranted: ['transferInvoices'] }, 'PUT', superAdmin)).status, 200);
    const moved = await request(`/sales/${sale.data.id}/transfer`, body, 'POST', admin);
    assert.equal(moved.status, 200, JSON.stringify(moved));

    const [a, b] = await Promise.all([Customer.findById(cali.id), Customer.findById(cumar.id)]);
    assert.equal(a.balanceCents, 0, 'the 70 owed came off Cali');
    assert.equal(b.balanceCents, 7000, 'and went onto Cumar');
    assert.equal(b.totalPurchasedCents, 10000);
    assert.equal(b.totalPaidCents, 3000);
    assert.equal(a.totalPurchasedCents, 0);
    assert.equal(String((await Sale.findById(sale.data.id)).customer), cumar.id);
    assert.equal((await Payment.findOne({ relatedSale: sale.data.id })).customer.toString(), cumar.id, 'the payment at the sale moved too');
    assert.match((await CustomerLedger.findOne({ customer: cali.id }).sort({ createdAt: -1 })).description, /moved to Cumar/);
    assert.match((await CustomerLedger.findOne({ customer: cumar.id }).sort({ createdAt: -1 })).description, /moved from Cali/);

    // Cumar pays 20 of it, and it still moves -- the payment goes with it.
    assert.equal((await request(`/customers/${cumar.id}/payments`, { amount: 20, paymentAccountId: evc.id }, 'POST', superAdmin)).status, 201);
    assert.equal((await Customer.findById(cumar.id)).balanceCents, 5000);
    // A cashier the admin ticked for it may move it too.
    await User.updateOne({ _id: cashier._id }, { $set: { permissions: ['pos', 'customers', 'transferInvoices'] } });
    const back = await request(`/sales/${sale.data.id}/transfer`, { customerId: cali.id, reason: 'back again' }, 'POST', cashier);
    assert.equal(back.status, 200, JSON.stringify(back));
    const [c1, c2] = await Promise.all([Customer.findById(cali.id), Customer.findById(cumar.id)]);
    assert.equal(c1.balanceCents, 5000, 'Cali owes the 50 still unpaid');
    assert.equal(c1.totalPaidCents, 5000, '30 at the sale + 20 later');
    assert.equal(c2.balanceCents, 0);
    assert.equal(c2.totalPaidCents, 0);
    assert.equal((await Payment.findOne({ type: 'debt_payment', 'allocations.sale': sale.data.id })).customer.toString(), cali.id);

    // A payment that paid two invoices is split: only this invoice's part moves.
    const second = await request('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 5 }], paidAmount: 0 });
    await closeDay({ user: superAdmin });
    await openDay({ user: superAdmin });
    assert.equal((await Customer.findById(cali.id)).balanceCents, 10000);
    assert.equal((await request(`/customers/${cali.id}/payments`, { amount: 80, paymentAccountId: evc.id }, 'POST', superAdmin)).status, 201); // 50 on the first, 30 on the second
    const split = await request(`/sales/${second.data.id}/transfer`, { customerId: cumar.id, reason: 'his' }, 'POST', superAdmin);
    assert.equal(split.status, 200, JSON.stringify(split));
    const [d1, d2] = await Promise.all([Customer.findById(cali.id), Customer.findById(cumar.id)]);
    assert.equal(d1.balanceCents, 0);
    assert.equal(d2.balanceCents, 2000, 'second invoice: 50 less the 30 paid on it');
    const parts = await Payment.find({ type: 'debt_payment', 'allocations.sale': second.data.id });
    assert.equal(parts.length, 1);
    assert.equal(parts[0].customer.toString(), cumar.id);
    assert.equal(parts[0].amountCents, 3000);
    assert.match(parts[0].receiptNumber, /-M$/);

    // Wallet money used on an invoice goes back to the first customer's wallet.
    await Customer.updateOne({ _id: cali.id }, { $set: { walletBalanceCents: 1000 } });
    const walletSale = await request('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 2 }], paidAmount: 0, walletAmount: 10 });
    assert.equal(walletSale.status, 201, JSON.stringify(walletSale));
    await closeDay({ user: superAdmin });
    await openDay({ user: superAdmin });
    const w = await request(`/sales/${walletSale.data.id}/transfer`, { customerId: cumar.id, reason: 'his too' }, 'POST', superAdmin);
    assert.equal(w.status, 200, JSON.stringify(w));
    assert.equal((await Customer.findById(cali.id)).walletBalanceCents, 1000, 'the 10 from the wallet came back');
    assert.equal((await Customer.findById(cumar.id)).balanceCents, 4000, '20 + the 20 invoice he now owes in full');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
