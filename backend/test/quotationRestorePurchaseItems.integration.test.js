import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import Supplier from '../src/models/Supplier.js';
import Quotation from '../src/models/Quotation.js';

test('QUOTATION restore after Rejected -> accept -> invoice; PURCHASE page lists the items bought', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/q_restore_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-q-restore';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const evc = await Account.create({ name: 'EVC Plus' });
  const cali = await Customer.create({ name: 'Cali' });
  const tabaarak = await Supplier.create({ name: 'Tabaarak Pharmacy' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    // The purchase invoice made from a supplier invoice shows its items.
    const inv = await api('/supplier-invoice-archives', { serialNumber: '1886', supplierId: tabaarak.id, addToStock: true, discount: 0.25, rows: [{ itemName: 'Takomol', quantity: 2, cost: 2.5, sellingPrice: 4 }, { itemName: 'Panadol', quantity: 4, cost: 1, sellingPrice: 2 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv));
    const p = (await api(`/purchases/${inv.data.purchase}`)).data;
    assert.deepEqual(p.items.map((i) => [i.name, i.quantity, i.unitCost, i.subtotal]), [['Takomol', 2, 2.5, 5], ['Panadol', 4, 1, 4]]);
    assert.deepEqual([p.goodsDiscount, p.totalAmount, p.archiveNumber], [0.25, 8.75, inv.data.archiveNumber]);

    // A quotation rejected, then restored, accepted and converted.
    const takomol = (await api('/inventory/search?q=Takomol')).data[0];
    const q = await api('/quotations', { customerId: cali.id, date: new Date().toISOString().slice(0, 10), expiryDate: '2034-12-31', items: [{ itemId: takomol.id, quantity: 1, unitPrice: 4 }], discount: 0, grandTotal: 0 });
    assert.equal(q.status, 201, JSON.stringify(q));
    assert.equal((await api(`/quotations/${q.data.id}`)).data.items[0].costPrice, 2.43, 'the line carries what the item costs (after the invoice discount)');
    assert.equal((await api(`/quotations/${q.data.id}/status`, { status: 'Rejected' }, 'PATCH')).status, 200);
    // Its date had passed: restoring gives it its days again.
    await Quotation.updateOne({ _id: q.data.id }, { $set: { expiryDate: new Date(Date.now() - 86400000) } });
    const restored = await api(`/quotations/${q.data.id}/status`, { status: 'Pending' }, 'PATCH');
    assert.equal(restored.status, 200, JSON.stringify(restored));
    assert.equal(restored.data.status, 'Pending');
    assert.ok(new Date(restored.data.expiryDate) > new Date(), 'not expired straight away');
    assert.equal((await api(`/quotations/${q.data.id}/status`, { status: 'Accepted' }, 'PATCH')).status, 200);
    // The discount is given on the invoice when converting: $4 less $1.
    const conv = await api(`/quotations/${q.data.id}/convert`, { paidAmount: 0, discount: 1 });
    assert.equal(conv.status, 201, JSON.stringify(conv));
    assert.equal(conv.data.status, 'CONFIRMED');
    assert.equal(conv.data.total, 3, 'discount given on the invoice');
    // A converted one cannot be restored.
    assert.equal((await api(`/quotations/${q.data.id}/status`, { status: 'Pending' }, 'PATCH')).status, 409);

    // An expired one (its date passed) is restored too: Pending again, its days renewed.
    const q2 = await api('/quotations', { customerId: cali.id, date: new Date().toISOString().slice(0, 10), expiryDate: '2034-12-31', items: [{ itemId: takomol.id, quantity: 1, unitPrice: 4 }], discount: 0, grandTotal: 0 });
    await Quotation.updateOne({ _id: q2.data.id }, { $set: { expiryDate: new Date(Date.now() - 86400000) } });
    assert.equal((await api(`/quotations/${q2.data.id}`)).data.status, 'Expired');
    const back = await api(`/quotations/${q2.data.id}/status`, { status: 'Pending' }, 'PATCH');
    assert.equal(back.status, 200, JSON.stringify(back));
    assert.equal(back.data.status, 'Pending');
    assert.ok(new Date(back.data.expiryDate) > new Date(), 'not expired again straight away');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
