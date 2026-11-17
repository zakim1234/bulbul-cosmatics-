import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import Sale from '../src/models/Sale.js';
import InventoryItem from '../src/models/InventoryItem.js';
import { receiveStock } from '../src/services/stockReceiptService.js';
import { createSaleDraft } from '../src/services/saleService.js';
import { closeDay } from '../src/services/dayCloseService.js';
import { buildBalanceSheet, getTotalInventoryValueCents } from '../src/services/balanceSheetService.js';
import { runInTransaction } from '../src/utils/transaction.js';

test('STOCK -- the average cost is kept exact: nothing is lost to rounding, the Balance Sheet does not drift', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/exact_wac_${Date.now()}?replicaSet=stocktest`);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  try {
    const user = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
    const evc = await Account.create({ name: 'EVC Plus' });
    const cali = await Customer.create({ name: 'Cali' });
    // 1 at $1.00, then 2 at $1.01: $3.02 of stock, 100.666... cents each.
    await runInTransaction((session) => receiveStock(session, { rows: [{ name: 'Panadol', quantity: 1, costPrice: 1, sellingPrice: 5 }], user }));
    await runInTransaction((session) => receiveStock(session, { rows: [{ name: 'Panadol', quantity: 2, costPrice: 1.01, sellingPrice: 5 }], user }));
    const item = await InventoryItem.findOne({ name: 'Panadol' });
    assert.ok(Math.abs(item.costPriceCents - 302 / 3) < 1e-9, `exact average, got ${item.costPriceCents}`);
    assert.ok(Math.abs((await getTotalInventoryValueCents()) - 302) < 1e-6, 'the stock is worth exactly what it cost');
    const gapBefore = (await buildBalanceSheet()).differenceCents;

    // All 3 sold for $15 cash: the cost of goods is exactly $3.02.
    const draft = await runInTransaction((session) => createSaleDraft({ customerId: cali.id, items: [{ itemId: item.id, quantity: 3 }], paidAmount: 15, paymentAccountId: evc.id }, user, session));
    await closeDay({ user });
    const sale = await Sale.findById(draft._id);
    assert.ok(Math.abs(sale.costOfGoodsCents - 302) < 1e-6, `cost of goods ${sale.costOfGoodsCents}`);
    assert.equal((await buildBalanceSheet()).differenceCents, gapBefore, 'not a cent of drift');
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
