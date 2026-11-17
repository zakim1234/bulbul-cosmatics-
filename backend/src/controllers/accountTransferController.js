import mongoose from 'mongoose';
import Account from '../models/Account.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { logAudit } from '../services/auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents, toCents } from '../utils/money.js';

// POST /api/accounts/transfer { toAccountId, items: [{ fromAccountId, amount }], note }
// Moves money between the business's own accounts -- e.g. everything into one
// account. Each move is a pair of entries (out of one, into the other) shown
// on both statements; nothing is income or an expense, so profit and the
// Balance Sheet do not change.
export const transferBetweenAccounts = asyncHandler(async (req, res) => {
  const { toAccountId } = req.body;
  const note = String(req.body.note || '').trim().slice(0, 200);
  if (!mongoose.isValidObjectId(toAccountId)) throw new ApiError(400, 'Choose the account the money goes to.');
  const items = (Array.isArray(req.body.items) ? req.body.items : [])
    .map((i) => ({ fromAccountId: i?.fromAccountId, amountCents: toCents(Number(i?.amount)) }))
    .filter((i) => i.amountCents > 0);
  if (!items.length) throw new ApiError(400, 'Enter an amount to move from at least one account.');
  const seen = new Set();
  for (const i of items) {
    if (!mongoose.isValidObjectId(i.fromAccountId)) throw new ApiError(400, 'Choose the account the money comes from.');
    if (String(i.fromAccountId) === String(toAccountId)) throw new ApiError(400, 'An account cannot send money to itself.');
    if (seen.has(String(i.fromAccountId))) throw new ApiError(400, 'An account is listed twice.');
    seen.add(String(i.fromAccountId));
  }

  const done = await runInTransaction(async (session) => {
    const to = await Account.findOne({ _id: toAccountId, isActive: true }).session(session);
    if (!to) throw new ApiError(400, 'The account the money goes to is not available.');
    const moved = [];
    const tail = note ? ` -- ${note}` : '';
    for (const i of items) {
      const from = await Account.findOne({ _id: i.fromAccountId, isActive: true }).session(session);
      if (!from) throw new ApiError(400, 'One of the accounts is not available.');
      if (from.currentBalanceCents < i.amountCents) throw new ApiError(400, `${from.name} has only ${fromCents(from.currentBalanceCents).toFixed(2)}.`);
      await postImmediateTransaction({ account: from, direction: 'OUT', type: 'WITHDRAWAL', amountCents: i.amountCents, referenceType: 'Manual', description: `Transfer to ${to.name}${tail}`, createdBy: req.user }, session);
      await postImmediateTransaction({ account: to, direction: 'IN', type: 'DEPOSIT', amountCents: i.amountCents, referenceType: 'Manual', description: `Transfer from ${from.name}${tail}`, createdBy: req.user }, session);
      moved.push({ from: from.name, amountCents: i.amountCents });
    }
    return { to: to.name, moved, balanceCents: to.currentBalanceCents };
  });

  const totalCents = done.moved.reduce((t, m) => t + m.amountCents, 0);
  await logAudit({ user: req.user, action: 'account.transfer', entityType: 'Account', entityId: toAccountId, details: { to: done.to, total: fromCents(totalCents), from: done.moved.map((m) => `${m.from} ${fromCents(m.amountCents)}`) } });
  res.status(201).json({ success: true, data: { to: done.to, total: fromCents(totalCents), moved: done.moved.map((m) => ({ from: m.from, amount: fromCents(m.amountCents) })), balance: fromCents(done.balanceCents) } });
});
