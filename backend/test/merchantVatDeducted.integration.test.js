import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import { closeDay, openDay } from '../src/services/dayCloseService.js';

test('MERCHANT VAT -- the customer pays $100, the merchant keeps 3%: the account gets $97 and $3 is a Merchant VAT expense', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/merchant_vat_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-merchant-vat';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const merchant = await Account.create({ name: 'Merchant', type: 'MERCHANT', vatPercent: 3 });
  const cali = await Customer.create({ name: 'Cali' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body != null ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const stock = await api('/stock', { rows: [{ name: 'Panadol', quantity: 50, costPrice: 1, sellingPrice: 10 }] });
    const item = stock.data.rows[0].item;
    const sheetBefore = (await api('/reports/balance-sheet')).data;

    const sale = await api('/sales', { customerId: cali.id, items: [{ itemId: item, quantity: 10 }], paidAmount: 100, paymentAccountId: merchant.id });
    assert.equal(sale.status, 201, JSON.stringify(sale));
    assert.deepEqual([sale.data.vatPercent, sale.data.vat], [3, 3]);
    await closeDay({ user: owner });
    await openDay({ user: owner });

    assert.equal((await Account.findById(merchant._id)).currentBalanceCents, 9700, 'the account gets 97');
    assert.equal((await Customer.findById(cali.id)).balanceCents, 0, 'the customer paid in full');

    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const pl = (await api(`/reports/profit-loss?from=${day}&to=${day}`)).data;
    const row = (label) => pl.rows.find((r) => r.label === label)?.values.total;
    assert.deepEqual([row('Sales Income'), row('Merchant VAT'), row('Net Income')], [100, 3, 100 - 10 - 3]);
    const cash = (await api(`/reports/profit-loss?from=${day}&to=${day}&basis=cash`)).data;
    assert.equal(cash.rows.find((r) => r.label === 'Sales Income').values.total, 100);

    const sheet = (await api('/reports/balance-sheet')).data;
    assert.equal(sheet.differenceCents, sheetBefore.differenceCents, 'the Balance Sheet stays balanced');

    const report = (await api('/reports/merchant-vat')).data;
    assert.deepEqual([report.rows[0].customerSent, report.rows[0].vat, report.rows[0].accountGot], [100, 3, 97]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
