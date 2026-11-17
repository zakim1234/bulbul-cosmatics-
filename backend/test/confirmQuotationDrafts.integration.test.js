import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import Account from '../src/models/Account.js';
import Customer from '../src/models/Customer.js';
import Sale from '../src/models/Sale.js';
import InventoryItem from '../src/models/InventoryItem.js';
import DayClose from '../src/models/DayClose.js';
import { createSaleDraft } from '../src/services/saleService.js';
import { closeDay } from '../src/services/dayCloseService.js';
import { runInTransaction } from '../src/utils/transaction.js';
import { confirmQuotationDrafts } from '../src/utils/confirmQuotationDrafts.js';

test('SALES -- invoices still Pending (from a quotation or the POS) are confirmed on start-up, once, and counted at Close Day', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/confirm_quotation_drafts_${Date.now()}?replicaSet=stocktest`);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  try {
    const user = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
    const evc = await Account.create({ name: 'EVC Plus' });
    const cali = await Customer.create({ name: 'Cali' });
    const item = await InventoryItem.create({ name: 'Panadol', itemCode: 'P-1', quantity: 10, costPriceCents: 100, sellingPriceCents: 1000 });
    // The day starts open.
    // The old way: a Pending invoice from a quotation, $10 paid of $30.
    const quotationId = new mongoose.Types.ObjectId();
    const draft = await runInTransaction((session) => createSaleDraft({ customerId: cali.id, items: [{ itemId: item.id, quantity: 3 }], paidAmount: 10, paymentAccountId: evc.id }, user, session, { quotationId }));
    // An ordinary Pending invoice from the POS, nothing paid.
    const plain = await runInTransaction((session) => createSaleDraft({ customerId: cali.id, items: [{ itemId: item.id, quantity: 1 }], paidAmount: 0 }, user, session));

    assert.deepEqual(await confirmQuotationDrafts(), { found: 2, confirmed: 2 });
    const sale = await Sale.findById(draft._id);
    assert.deepEqual([sale.status, sale.awaitingDayClose], ['CONFIRMED', true]);
    assert.deepEqual([(await Sale.findById(plain._id)).status, (await Sale.findById(plain._id)).awaitingDayClose], ['CONFIRMED', true], 'POS invoices too');
    assert.equal((await InventoryItem.findById(item._id)).quantity, 6);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 1000);
    assert.equal((await Customer.findById(cali._id)).balanceCents, 2000 + 1000, 'both on the customer');
    assert.deepEqual(await confirmQuotationDrafts(), { found: 0, confirmed: 0 }, 'only once');

    await closeDay({ user });
    const dc = await DayClose.findOne();
    assert.equal(dc.revenueCents, 3000 + 1000, 'both counted in the day');
    assert.equal((await Sale.findById(draft._id)).awaitingDayClose, false);
    assert.equal((await Account.findById(evc._id)).currentBalanceCents, 1000, 'not posted twice');
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
