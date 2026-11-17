import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';

test('SUPPLIER INVOICES -- one folder per supplier, opened to its own invoices', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/archive_folders_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-archive-folders';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cali = await Supplier.create({ name: 'Cali' });
  const vita = await Supplier.create({ name: 'Vita Pharma' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    for (const [serialNumber, supplierId, cost] of [['66778', cali.id, 100], ['77788', cali.id, 20], ['V-1', vita.id, 5], ['N-1', null, 3]]) {
      assert.equal((await api('/supplier-invoice-archives', { serialNumber, supplierId, rows: [{ itemName: 'Panadol', quantity: 1, cost }] })).status, 201);
    }
    const folders = (await api('/supplier-invoice-archives/by-supplier')).data;
    const byName = Object.fromEntries(folders.map((f) => [f.name, f]));
    assert.deepEqual([byName.Cali.count, byName.Cali.total], [2, 120]);
    assert.deepEqual([byName['Vita Pharma'].count, byName['(no supplier)'].count], [1, 1]);
    // Opening a folder: just that supplier's invoices.
    const caliInvoices = (await api(`/supplier-invoice-archives?supplier=${cali.id}`)).data;
    assert.deepEqual(caliInvoices.map((a) => a.serialNumber).sort(), ['66778', '77788']);
    assert.deepEqual((await api('/supplier-invoice-archives?supplier=none')).data.map((a) => a.serialNumber), ['N-1']);
    assert.equal((await api('/supplier-invoice-archives?supplier=junk')).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
