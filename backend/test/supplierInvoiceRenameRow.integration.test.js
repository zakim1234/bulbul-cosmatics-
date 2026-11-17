import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';
import InventoryItem from '../src/models/InventoryItem.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('SUPPLIER INVOICE -- a row received under the wrong name is corrected: its units go to the right item', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/si_rename_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-si-rename';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const sup = await Supplier.create({ name: 'Xaaji Gate' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(owner._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    await api('/supplier-invoice-archives', { serialNumber: 'A-0', supplierId: sup.id, addToStock: true, rows: [{ itemName: 'Albendazole 150mg Tab Xoolo (Box)', quantity: 5, cost: 1.2, sellingPrice: 1.5 }] });
    // Received: Tylovit right, but the second row under the wrong name.
    const inv = await api('/supplier-invoice-archives', { serialNumber: 'A-1', supplierId: sup.id, addToStock: true, rows: [{ itemName: 'Tylovit 20% 100ml Inj', quantity: 60, cost: 0.6, sellingPrice: 1.2 }, { itemName: 'Albendazol Wrong', quantity: 20, cost: 1.2, sellingPrice: 1.2 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv));
    const gap = (await buildBalanceSheet()).differenceCents;
    const rows = (name) => [{ itemName: 'Tylovit 20% 100ml Inj', quantity: 60, cost: 0.6 }, { itemName: name, quantity: 20, cost: 1.2 }];

    // Corrected to the item that exists: its 20 units go there.
    const fixed = await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'A-1', supplierId: sup.id, rows: rows('Albendazole 150mg Tab Xoolo (Box)') }, 'PUT');
    assert.equal(fixed.status, 200, JSON.stringify(fixed));
    assert.equal((await InventoryItem.findOne({ name: 'Albendazole 150mg Tab Xoolo (Box)' })).quantity, 25, '5 + 20');
    assert.equal((await InventoryItem.findOne({ name: 'Albendazol Wrong' })).quantity, 0, 'the wrong one is empty');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'the Balance Sheet does not move');

    // Corrected to a name not in stock yet: the item is made, the units go there.
    const renamed = await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'A-1', supplierId: sup.id, rows: rows('Albendazole 300mg Tab') }, 'PUT');
    assert.equal(renamed.status, 200, JSON.stringify(renamed));
    assert.equal((await InventoryItem.findOne({ name: 'Albendazole 300mg Tab' })).quantity, 20);
    assert.equal((await InventoryItem.findOne({ name: 'Albendazole 150mg Tab Xoolo (Box)' })).quantity, 5);
    assert.equal((await buildBalanceSheet()).differenceCents, gap);
    // Quantities stay locked.
    assert.equal((await api(`/supplier-invoice-archives/${inv.data.id}`, { serialNumber: 'A-1', supplierId: sup.id, rows: [{ itemName: 'Tylovit 20% 100ml Inj', quantity: 50, cost: 0.6 }, { itemName: 'Albendazole 300mg Tab', quantity: 20, cost: 1.2 }] }, 'PUT')).status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
