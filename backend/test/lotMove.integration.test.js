import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Supplier from '../src/models/Supplier.js';
import InventoryItem from '../src/models/InventoryItem.js';
import InventoryLot from '../src/models/InventoryLot.js';
import SupplierInvoiceArchive from '../src/models/SupplierInvoiceArchive.js';
import { buildBalanceSheet } from '../src/services/balanceSheetService.js';

test('BATCH MOVE -- 30 tablets put on the wrong item move to the right one; stock worth the same', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/lot_move_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-lot-move';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cashier = await User.create({ username: 'cash', name: 'Cashier', passwordHash: 'unused', role: 'cashier', permissions: ['inventory'] });
  const xaaji = await Supplier.create({ name: 'Xaaji Gate Drug Co.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const api = async (path, body, user = owner) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    // The wrong item had 1 at $0.75; the right one has 10 at $3.
    await api('/supplier-invoice-archives', { serialNumber: 'W-1', supplierId: xaaji.id, addToStock: true, rows: [{ itemName: 'Wrong Tab', quantity: 1, cost: 0.75, sellingPrice: 0.8 }] });
    await api('/supplier-invoice-archives', { serialNumber: 'R-1', supplierId: xaaji.id, addToStock: true, rows: [{ itemName: 'Right Tab', quantity: 10, cost: 3, sellingPrice: 4 }] });
    // 30 at $4 received under the wrong item by mistake.
    const mistake = await api('/supplier-invoice-archives', { serialNumber: 'X-180', supplierId: xaaji.id, addToStock: true, rows: [{ itemName: 'Wrong Tab', quantity: 30, cost: 4, sellingPrice: 4.1 }] });
    const wrong = await InventoryItem.findOne({ name: 'Wrong Tab' });
    const right = await InventoryItem.findOne({ name: 'Right Tab' });
    const lot = await InventoryLot.findOne({ item: wrong._id, originalQuantity: 30 });
    const gap = (await buildBalanceSheet()).differenceCents;

    assert.equal((await api(`/inventory/lots/${lot.id}/move`, { toItemId: right.id }, cashier)).status, 403, 'needs the permission');
    const moved = await api(`/inventory/lots/${lot.id}/move`, { toItemId: right.id });
    assert.equal(moved.status, 200, JSON.stringify(moved));

    const w = await InventoryItem.findById(wrong._id);
    const r = await InventoryItem.findById(right._id);
    assert.deepEqual([w.quantity, w.costPriceCents], [1, 75], 'the wrong item is back to 1 at $0.75');
    assert.equal(r.quantity, 40);
    assert.ok(Math.abs(r.costPriceCents - (10 * 300 + 30 * 400) / 40) < 1e-6, 'the right item blends the 30 at $4');
    assert.equal(String((await InventoryLot.findById(lot._id)).item), String(right._id), 'the batch is on the right item');
    assert.equal((await SupplierInvoiceArchive.findById(mistake.data.id)).rows[0].itemName, 'Right Tab', 'its supplier invoice names it too');
    assert.equal((await buildBalanceSheet()).differenceCents, gap, 'the Balance Sheet does not move');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
