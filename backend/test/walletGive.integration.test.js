import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Branch from '../src/models/Branch.js';
import Account from '../src/models/Account.js';
import ChatMessage from '../src/models/ChatMessage.js';
import CompanyWallet from '../src/models/CompanyWallet.js';
import AutoTakeDue from '../src/models/AutoTakeDue.js';
import CompanySetting from '../src/models/CompanySetting.js';
import { clearBranchCache } from '../src/middleware/auth.js';
import { runWithBranch } from '../src/services/branchContext.js';
import { getTakenToCompanyWalletCents } from '../src/services/balanceSheetService.js';

test('COMPANY WALLET -- give part of the money to a branch account, not as a loan', { timeout: 60000 }, async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27028/wallet_give_${Date.now()}?replicaSet=stocktest`);
  process.env.JWT_SECRET = 'isolated-wallet-give';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const kaaran = await Branch.create({ name: 'Kaaran' });
  clearBranchCache();
  const owner = await User.create({ username: 'owner', name: 'Owner', passwordHash: 'unused', role: 'admin', isSuperAdmin: true });
  const cabdi = await User.create({ username: 'cabdi', name: 'Cabdi', passwordHash: 'unused', role: 'admin', branch: kaaran._id });
  const cashier = await User.create({ username: 'cash', name: 'Cash', passwordHash: 'unused', role: 'cashier', branch: kaaran._id });
  const evc = await runWithBranch(kaaran._id, () => Account.create({ name: 'EVC Plus', currentBalanceCents: 30000 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const as = (user) => async (path, body, method = body != null ? 'POST' : 'GET') => {
    const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body != null ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = as(owner);
  const balance = async () => (await Account.findById(evc._id).setOptions({ skipBranchScope: true }).lean()).currentBalanceCents;
  try {
    const wallet = (await api('/company-wallets', { name: 'Group' })).data;
    // $100 taken from the branch into the wallet.
    assert.equal((await api(`/company-wallets/${wallet.id}/take`, { items: [{ branchId: kaaran.id, accountId: evc.id, amount: 100 }] })).status, 201);
    assert.equal(await balance(), 20000);

    // $40 given back into the account: the wallet goes down, the account up.
    const give = { branchId: kaaran.id, accountId: evc.id, amount: 40, note: 'Kharashka dukaanka' };
    const given = await api(`/company-wallets/${wallet.id}/give`, give);
    assert.equal(given.status, 201, JSON.stringify(given));
    assert.match(given.data.batch, /^CWG-\d{4}-\d{4}$/);
    assert.equal(await balance(), 24000);
    assert.equal((await CompanyWallet.findById(wallet.id)).balanceCents, 6000);

    // Not a loan: the branch owes nothing for it.
    assert.equal((await AutoTakeDue.findOne({ branch: kaaran._id }))?.owedCents || 0, 0);

    // The branch admin is told by chat; the cashier is not.
    const msg = await ChatMessage.findOne({ to: cabdi._id, text: /lagu shubay \$40\.00/ });
    assert.ok(msg, 'the admin got the message');
    assert.match(msg.text, /EVC Plus/);
    assert.match(msg.text, /deyn ma aha/);
    assert.match(msg.text, /Kharashka dukaanka/);
    assert.equal(await ChatMessage.countDocuments({ to: cashier._id }), 0);
    const notices = await api('/company-wallets/notices');
    assert.ok(notices.data.some((n) => n.batch === given.data.batch && n.given === 40 && n.to.includes('Cabdi')));

    // History: one line for the give; stats keep it apart from "Taken out".
    const detail = (await api(`/company-wallets/${wallet.id}/entries`)).data;
    const row = detail.rows.find((r) => r.batch === given.data.batch);
    assert.deepEqual([row.kind, row.type, row.amount, row.items[0].accountName], ['GIVE', 'WITHDRAW', 40, 'EVC Plus']);
    assert.deepEqual([detail.fromBranches, detail.givenToBranches, detail.withdrawn], [100, 40, 0]);

    // The balance sheet's "company wallet" line is what is still out: 100 - 40.
    assert.equal(await runWithBranch(kaaran._id, () => getTakenToCompanyWalletCents()), 6000);

    // Refused: more than the wallet has, a bad account, a branch admin.
    assert.equal((await api(`/company-wallets/${wallet.id}/give`, { ...give, amount: 61 })).status, 400);
    assert.equal((await api(`/company-wallets/${wallet.id}/give`, { ...give, accountId: new mongoose.Types.ObjectId().toString() })).status, 400);
    assert.equal((await as(cabdi)(`/company-wallets/${wallet.id}/give`, give)).status, 403);

    // A branch that owes the daily take would lose it straight away: refused.
    await CompanySetting.findOneAndUpdate({ _id: 'company' }, { $set: { autoTakeEnabled: true, autoTakeWallet: wallet.id } }, { upsert: true });
    await AutoTakeDue.create({ branch: kaaran._id, branchName: 'Kaaran', owedCents: 500 });
    const owes = await api(`/company-wallets/${wallet.id}/give`, { ...give, amount: 10 });
    assert.equal(owes.status, 409);
    assert.match(owes.message, /owes 5\.00/);
    assert.equal(await balance(), 24000);
    await AutoTakeDue.updateOne({ branch: kaaran._id }, { owedCents: 0 });

    // Undo: the account gives it back and the wallet is whole again.
    assert.equal((await api(`/company-wallets/${wallet.id}/takes/${given.data.batch}`, null, 'DELETE')).status, 200);
    assert.equal(await balance(), 20000);
    assert.equal((await CompanyWallet.findById(wallet.id)).balanceCents, 10000);

    // A give whose money the branch already spent cannot be undone.
    const again = await api(`/company-wallets/${wallet.id}/give`, { ...give, amount: 50 });
    assert.equal(again.status, 201);
    await Account.updateOne({ _id: evc._id }, { currentBalanceCents: 1000 }).setOptions({ skipBranchScope: true });
    assert.equal((await api(`/company-wallets/${wallet.id}/takes/${again.data.batch}`, null, 'DELETE')).status, 400);
    assert.equal((await CompanyWallet.findById(wallet.id)).balanceCents, 5000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
