import mongoose from 'mongoose';
import Account from '../models/Account.js';
import AccountTransaction from '../models/AccountTransaction.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { currentBranch } from '../services/branchContext.js';
import { logAudit } from '../services/auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents, toCents } from '../utils/money.js';

// The branch's commission account: the staff's 30% of the profit is moved
// into it from the other accounts, and commission is paid out of it. Moving
// money between accounts is not income or an expense, so profit and the
// Balance Sheet do not change.
export const COMMISSION_ACCOUNT_NAME = 'Commission 30%';

function needBranch() {
  if (!currentBranch()) throw new ApiError(400, 'Open a branch first.');
}

const dto = (a) => (a ? { id: a._id, name: a.name, balance: fromCents(a.currentBalanceCents) } : null);

// GET /api/commissions/account
export const getCommissionAccount = asyncHandler(async (req, res) => {
  needBranch();
  const account = await Account.findOne({ commission: true, isActive: true });
  const moves = account
    ? await AccountTransaction.find({ account: account._id, status: 'POSTED' }).sort({ postedAt: -1 }).limit(30).lean()
    : [];
  res.json({
    success: true,
    data: {
      account: dto(account),
      moves: moves.map((m) => ({ id: m._id, direction: m.direction, amount: fromCents(m.amountCents), description: m.description, date: m.postedAt })),
    },
  });
});

// POST /api/commissions/account -- create it (once per branch).
export const createCommissionAccount = asyncHandler(async (req, res) => {
  needBranch();
  let account = await Account.findOne({ commission: true });
  if (account) {
    if (!account.isActive) {
      account.isActive = true;
      await account.save();
    }
  } else {
    if (await Account.exists({ name: COMMISSION_ACCOUNT_NAME })) throw new ApiError(409, `An account called "${COMMISSION_ACCOUNT_NAME}" already exists in this branch.`);
    account = await Account.create({ name: COMMISSION_ACCOUNT_NAME, type: 'OTHER', commission: true });
  }
  await logAudit({ user: req.user, action: 'commission.account_create', entityType: 'Account', entityId: account._id });
  res.status(201).json({ success: true, data: dto(account) });
});

// POST /api/commissions/account/move { otherAccountId, amount, direction: 'IN'|'OUT', note }
// IN: from the other account into the commission account; OUT: back.
export const moveCommissionMoney = asyncHandler(async (req, res) => {
  needBranch();
  const { otherAccountId, direction = 'IN' } = req.body;
  const amountCents = toCents(Number(req.body.amount));
  const note = String(req.body.note || '').trim().slice(0, 200);
  if (!['IN', 'OUT'].includes(direction)) throw new ApiError(400, 'Choose in or out.');
  if (!(amountCents > 0)) throw new ApiError(400, 'Enter an amount greater than zero.');
  if (!mongoose.isValidObjectId(otherAccountId)) throw new ApiError(400, 'Choose the account.');

  const result = await runInTransaction(async (session) => {
    const commission = await Account.findOne({ commission: true, isActive: true }).session(session);
    if (!commission) throw new ApiError(400, 'Create the commission account first.');
    const other = await Account.findOne({ _id: otherAccountId, isActive: true }).session(session);
    if (!other) throw new ApiError(400, 'That account is not available.');
    if (String(other._id) === String(commission._id)) throw new ApiError(400, 'Choose a different account.');
    const from = direction === 'IN' ? other : commission;
    const to = direction === 'IN' ? commission : other;
    if (from.currentBalanceCents < amountCents) throw new ApiError(400, `${from.name} has only ${fromCents(from.currentBalanceCents).toFixed(2)}.`);
    const by = req.user;
    const tail = note ? ` -- ${note}` : '';
    await postImmediateTransaction({ account: from, direction: 'OUT', type: 'WITHDRAWAL', amountCents, referenceType: 'Manual', description: `Moved to ${to.name}${tail}`, createdBy: by }, session);
    await postImmediateTransaction({ account: to, direction: 'IN', type: 'DEPOSIT', amountCents, referenceType: 'Manual', description: `Moved from ${from.name}${tail}`, createdBy: by }, session);
    return commission;
  });
  await logAudit({ user: req.user, action: 'commission.account_move', entityType: 'Account', entityId: result._id, details: { direction, amount: fromCents(amountCents), otherAccountId } });
  res.status(201).json({ success: true, data: dto(result) });
});
