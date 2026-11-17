import Account from '../models/Account.js';
import AccountTransaction from '../models/AccountTransaction.js';
import { seesEverything as seesBalances, lastCloseAt } from '../services/staffScope.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { resolveDateRange } from '../utils/dateRange.js';
import { logAudit } from '../services/auditService.js';
import Payment from '../models/Payment.js';
import Sale from '../models/Sale.js';
import Customer from '../models/Customer.js';
import CustomerLedger from '../models/CustomerLedger.js';
import { runInTransaction } from '../utils/transaction.js';

function toDTO(a) {
  return {
    id: a._id,
    name: a.name,
    type: a.type,
    accountNumber: a.accountNumber,
    openingBalance: fromCents(a.openingBalanceCents),
    vatPercent: a.vatPercent || 0,
    currentBalance: fromCents(a.currentBalanceCents),
    isActive: a.isActive,
    createdAt: a.createdAt,
  };
}

// Only the admin sees what the accounts really hold -- everyone's money
// together. Everyone else sees only their OWN money since the last Close Day
// (sales they took, payments they received, money they paid out), back to 0
// once the day is closed. See services/staffScope.js.
//
// Their own money includes what someone else did to it: an admin cancelling
// their invoice or payment, moving it to another account, deleting it -- any
// entry on a receipt they took. So the staff member sees it was cancelled or
// corrected, and their account shows the right money.
// `withReversed`: also the cancelled pending ones, shown but never counted.
async function ownSince(user, since, { withReversed = false } = {}) {
  const refs = await AccountTransaction.distinct('referenceId', { createdBy: user._id, referenceId: { $ne: null }, createdAt: { $gte: new Date(since.getTime() - 90 * 86400000) } });
  return {
    ...(withReversed ? {} : { status: { $ne: 'REVERSED' } }),
    createdAt: { $gte: since },
    $or: [{ createdBy: user._id }, ...(refs.length ? [{ referenceId: { $in: refs } }] : [])],
  };
}

// Net cents per account of a user's own transactions since `since`
// (pending Draft sale payments included -- they are theirs today).
async function ownNet(user, since) {
  const rows = await AccountTransaction.aggregate([
    { $match: await ownSince(user, since) },
    { $group: { _id: '$account', cents: { $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$amountCents', { $multiply: ['$amountCents', -1] }] } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.cents]));
}

// The balance a user is shown for an account, and the opening they see.
async function balancesFor(user, accounts) {
  if (seesBalances(user)) {
    return { scope: 'all', since: null, balanceOf: (a) => a.currentBalanceCents, openingOf: (a) => a.openingBalanceCents };
  }
  const since = await lastCloseAt();
  const net = await ownNet(user, since);
  return { scope: 'own', since, balanceOf: (a) => net.get(String(a._id)) || 0, openingOf: () => 0 };
}

// GET /api/accounts -- cards for the Accounts page: posted balance plus
// today's still-pending (Draft) receipts, so the page stays transparent
// about money that hasn't actually landed yet.
export const listAccounts = asyncHandler(async (req, res) => {
  const accounts = await Account.find().sort({ createdAt: 1 });
  const { start, end } = resolveDateRange({ range: 'today' });

  const pendingAgg = await AccountTransaction.aggregate([
    { $match: { status: 'PENDING', createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: { account: '$account', direction: '$direction' }, amount: { $sum: '$amountCents' } } },
  ]);
  const pendingByAccount = new Map();
  for (const row of pendingAgg) {
    const key = String(row._id.account);
    const entry = pendingByAccount.get(key) || { inCents: 0, outCents: 0 };
    if (row._id.direction === 'IN') entry.inCents += row.amount;
    else entry.outCents += row.amount;
    pendingByAccount.set(key, entry);
  }

  const view = await balancesFor(req.user, accounts);
  const totalBalanceCents = accounts.reduce((sum, a) => sum + view.balanceOf(a), 0);

  res.json({
    success: true,
    data: {
      scope: view.scope,
      since: view.since,
      totalBalance: fromCents(totalBalanceCents),
      accounts: accounts.map((a) => {
        const pending = (view.scope === 'all' && pendingByAccount.get(String(a._id))) || { inCents: 0, outCents: 0 };
        const pendingNetCents = pending.inCents - pending.outCents;
        return {
          ...toDTO(a),
          openingBalance: fromCents(view.openingOf(a)),
          currentBalance: fromCents(view.balanceOf(a)),
          pendingToday: fromCents(pendingNetCents),
          expectedAfterClose: fromCents(view.balanceOf(a) + pendingNetCents),
        };
      }),
    },
  });
});

export const getAccount = asyncHandler(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw new ApiError(404, 'Account not found.');
  const view = await balancesFor(req.user, [account]);
  res.json({ success: true, data: { ...toDTO(account), openingBalance: fromCents(view.openingOf(account)), currentBalance: fromCents(view.balanceOf(account)), scope: view.scope } });
});

// Merchant VAT %: 0-100.
function cleanVat(v) {
  const n = Number(v);
  if (v === '' || v == null) return 0;
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new ApiError(400, 'VAT % must be between 0 and 100.');
  return Math.round(n * 100) / 100;
}

export const createAccount = asyncHandler(async (req, res) => {
  const { name, type = 'OTHER', accountNumber = '', openingBalance = 0, vatPercent = 0 } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Account name is required.');

  const openingBalanceCents = toCents(openingBalance);
  const account = await Account.create({
    name: name.trim(),
    type,
    accountNumber: accountNumber.trim(),
    openingBalanceCents,
    currentBalanceCents: openingBalanceCents,
    vatPercent: cleanVat(vatPercent),
  });

  await logAudit({ user: req.user, action: 'account.create', entityType: 'Account', entityId: account._id, details: { name: account.name } });
  res.status(201).json({ success: true, data: toDTO(account) });
});

export const updateAccount = asyncHandler(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw new ApiError(404, 'Account not found.');

  const { name, type, accountNumber, isActive, openingBalance, vatPercent } = req.body;
  if (vatPercent !== undefined) account.vatPercent = cleanVat(vatPercent);
  if (name !== undefined) {
    if (!name.trim()) throw new ApiError(400, 'Account name cannot be empty.');
    account.name = name.trim();
  }
  if (type !== undefined) account.type = type;
  if (accountNumber !== undefined) account.accountNumber = accountNumber.trim();
  // Accounts with financial history should be deactivated, not deleted --
  // this is the only way isActive can be flipped.
  if (isActive !== undefined) account.isActive = !!isActive;
  // Opening balance: the money the account held before the system. Changing
  // it moves the current balance by the same difference.
  if (openingBalance !== undefined && openingBalance !== '') {
    const n = Number(openingBalance);
    if (!Number.isFinite(n)) throw new ApiError(400, 'Enter a valid opening balance.');
    const newCents = toCents(n);
    const diff = newCents - (account.openingBalanceCents || 0);
    account.openingBalanceCents = newCents;
    account.currentBalanceCents = (account.currentBalanceCents || 0) + diff;
  }

  await account.save();
  await logAudit({ user: req.user, action: 'account.update', entityType: 'Account', entityId: account._id, details: req.body });
  res.json({ success: true, data: toDTO(account) });
});

// GET /api/accounts/:id/transactions -- the ledger behind this account's balance
export const getAccountTransactions = asyncHandler(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw new ApiError(404, 'Account not found.');

  const { page = 1, limit = 30, status } = req.query;
  const filter = { account: account._id };
  if (status) filter.status = status;
  const staff = !seesBalances(req.user);
  if (staff) Object.assign(filter, await ownSince(req.user, await lastCloseAt(), { withReversed: !status }));
  const view = await balancesFor(req.user, [account]);

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 30));

  const [items, total] = await Promise.all([
    AccountTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate('createdBy', 'name'),
    AccountTransaction.countDocuments(filter),
  ]);
  // Lines that can be deleted: a cancelled payment and its refund (see
  // deleteCancelledPair).
  const paymentIds = items.filter((t) => t.referenceType === 'Payment' && t.referenceId).map((t) => t.referenceId);
  const deletablePayments = new Map(
    paymentIds.length
      ? (await Payment.find({ _id: { $in: paymentIds }, $or: [{ status: 'CANCELLED', refundedTo: 'ACCOUNT' }, { status: { $ne: 'CANCELLED' }, type: 'debt_payment', paymentAccount: account._id }] }).select('_id status')).map((p) => [String(p._id), p.status])
      : []
  );

  res.json({
    success: true,
    data: {
      account: { ...toDTO(account), openingBalance: fromCents(view.openingOf(account)), currentBalance: fromCents(view.balanceOf(account)) },
      scope: view.scope,
      transactions: items.map((t) => ({
        id: t._id,
        status: t.status,
        direction: t.direction,
        type: t.type,
        amount: fromCents(t.amountCents),
        referenceType: t.referenceType,
        referenceId: t.referenceId,
        description: t.description,
        balanceBefore: !staff && t.balanceBeforeCents !== null ? fromCents(t.balanceBeforeCents) : null,
        balanceAfter: !staff && t.balanceAfterCents !== null ? fromCents(t.balanceAfterCents) : null,
        createdAt: t.createdAt,
        postedAt: t.postedAt,
        movedToName: t.movedToName || '',
        // Who made this entry (an admin cancelling a cashier's receipt shows here).
        byName: t.createdBy?.name || '',
        correctionNote: t.correctionNote || '',
        correctedByName: t.correctedByName || '',
        deletable: t.status === 'POSTED' && t.referenceType === 'Payment' && deletablePayments.has(String(t.referenceId)),
        // 'payment': a standing payment (the customer owes it again); 'pair': a cancelled one and its refund.
        deleteKind: t.status === 'POSTED' && t.referenceType === 'Payment' && deletablePayments.has(String(t.referenceId)) ? (deletablePayments.get(String(t.referenceId)) === 'CANCELLED' ? 'pair' : 'payment') : null,
      })),
    },
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

// DELETE /api/accounts/transactions/:txnId -- removes a customer's debt
// payment from the account:
// - one still standing (entered by mistake): it is cancelled -- the invoices
//   it paid and the customer owe it again -- and the money it brought in comes
//   off the account;
// - one already cancelled with its money sent back: the money that came in
//   and the refund go together (they cancel out; the balance stays).
// Nothing else can be deleted this way. The audit log keeps the lines.
export const deleteCancelledPair = asyncHandler(async (req, res) => {
  const removed = await runInTransaction(async (session) => {
    const txn = await AccountTransaction.findById(req.params.txnId).session(session);
    if (!txn) throw new ApiError(404, 'Transaction not found.');
    const payment = txn.referenceType === 'Payment' ? await Payment.findById(txn.referenceId).session(session) : null;
    if (payment && payment.status !== 'CANCELLED' && payment.type === 'debt_payment' && String(payment.paymentAccount) === String(txn.account)) {
      return deleteStandingPayment(payment, req.user, session);
    }
    if (!payment || payment.status !== 'CANCELLED' || payment.refundedTo !== 'ACCOUNT') {
      throw new ApiError(409, "Only a customer's debt payment can be deleted from an account.");
    }
    const pair = await AccountTransaction.find({ referenceType: 'Payment', referenceId: payment._id, status: 'POSTED' }).session(session);
    const inCents = pair.filter((t) => t.direction === 'IN').reduce((s, t) => s + t.amountCents, 0);
    const outCents = pair.filter((t) => t.direction === 'OUT').reduce((s, t) => s + t.amountCents, 0);
    if (!pair.length || inCents !== outCents || new Set(pair.map((t) => String(t.account))).size !== 1) {
      throw new ApiError(409, 'This payment and its refund do not cancel each other out, so they cannot be deleted.');
    }
    await AccountTransaction.deleteMany({ _id: { $in: pair.map((t) => t._id) } }, { session });
    return { payment, pair, owedAgainCents: 0 };
  });
  await logAudit({
    user: req.user,
    action: 'account.transaction.delete',
    entityType: 'Payment',
    entityId: removed.payment._id,
    details: { receiptNumber: removed.payment.receiptNumber, lines: removed.pair.map((t) => ({ direction: t.direction, type: t.type, amount: fromCents(t.amountCents), description: t.description, at: t.createdAt })) },
  });
  res.json({ success: true, data: { deleted: removed.pair.length, receiptNumber: removed.payment.receiptNumber, customerName: removed.customerName || '', owedAgain: fromCents(removed.owedAgainCents) } });
});

// A debt payment entered by mistake: undone everywhere -- the invoices it
// paid (or the opening balance) are owed again, the customer's history says
// it was deleted, and the money it brought in comes off its account.
async function deleteStandingPayment(payment, user, session) {
  for (const a of payment.allocations) {
    if (!a.sale) continue; // the opening balance: owed again through balanceCents below
    const sale = await Sale.findById(a.sale).session(session);
    if (!sale || sale.status !== 'CONFIRMED') throw new ApiError(409, `Invoice ${a.receiptNumber} was cancelled after this payment, so the payment cannot be deleted.`);
    sale.outstandingCents += a.amountCents;
    await sale.save({ session });
  }
  const customer = await Customer.findById(payment.customer).session(session);
  if (customer) {
    const before = customer.balanceCents;
    customer.balanceCents += payment.amountCents;
    customer.totalPaidCents = Math.max(0, customer.totalPaidCents - payment.amountCents);
    await customer.save({ session });
    await CustomerLedger.create([{ customer: customer._id, type: 'PAYMENT_CANCELLED', amountCents: payment.amountCents, payment: payment._id, description: `Payment ${payment.receiptNumber} deleted (entered by mistake)`, balanceBeforeCents: before, balanceAfterCents: customer.balanceCents, createdBy: user?._id }], { session });
  }
  const lines = await AccountTransaction.find({ referenceType: 'Payment', referenceId: payment._id, status: 'POSTED' }).session(session);
  for (const line of lines) {
    const acc = await Account.findById(line.account).session(session);
    if (acc) {
      acc.currentBalanceCents += line.direction === 'IN' ? -line.amountCents : line.amountCents;
      await acc.save({ session });
    }
  }
  await AccountTransaction.deleteMany({ _id: { $in: lines.map((t) => t._id) } }, { session });
  payment.status = 'CANCELLED';
  payment.cancelledAt = new Date();
  payment.cancelReason = 'Deleted from the account (entered by mistake)';
  payment.cancelledByName = user?.name || '';
  payment.refundedTo = '';
  await payment.save({ session });
  return { payment, pair: lines, owedAgainCents: payment.amountCents, customerName: customer?.name || '' };
}

// GET /api/accounts/report -- money in/out by account for a date range
export const accountsReport = asyncHandler(async (req, res) => {
  const range = resolveDateRange(req.query);
  const accounts = await Account.find().sort({ createdAt: 1 });
  const view = await balancesFor(req.user, accounts);
  // Staff never see further back than the last Close Day.
  const start = view.since && view.since > range.start ? view.since : range.start;
  const end = range.end;

  const match =
    view.scope === 'all'
      ? { status: 'POSTED', postedAt: { $gte: start, $lte: end } }
      : { ...(await ownSince(req.user, start)), createdAt: { $gte: start, $lte: end } };
  const agg = await AccountTransaction.aggregate([
    { $match: match },
    { $group: { _id: { account: '$account', direction: '$direction' }, amount: { $sum: '$amountCents' } } },
  ]);
  const byAccount = new Map();
  for (const row of agg) {
    const key = String(row._id.account);
    const entry = byAccount.get(key) || { inCents: 0, outCents: 0 };
    if (row._id.direction === 'IN') entry.inCents += row.amount;
    else entry.outCents += row.amount;
    byAccount.set(key, entry);
  }

  // The admin: what each account held when the period began (as the
  // statement works it out), so opening + in - out = closing at its end.
  // Staff start from 0: they only see their own money since the last close.
  const before = new Map();
  if (view.scope === 'all') {
    const rows = await AccountTransaction.aggregate([
      { $match: { status: 'POSTED', postedAt: { $lt: start } } },
      { $group: { _id: '$account', cents: { $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$amountCents', { $multiply: ['$amountCents', -1] }] } } } },
    ]);
    for (const r of rows) before.set(String(r._id), r.cents);
  }

  res.json({
    success: true,
    data: {
      scope: view.scope,
      since: view.since,
      range: { from: start, to: end },
      accounts: accounts.map((a) => {
        const entry = byAccount.get(String(a._id)) || { inCents: 0, outCents: 0 };
        const openingCents = view.scope === 'all' ? (a.openingBalanceCents || 0) + (before.get(String(a._id)) || 0) : 0;
        return {
          id: a._id,
          name: a.name,
          openingBalance: fromCents(openingCents),
          moneyIn: fromCents(entry.inCents),
          moneyOut: fromCents(entry.outCents),
          closingBalance: fromCents(openingCents + entry.inCents - entry.outCents),
          currentBalance: fromCents(view.balanceOf(a)),
        };
      }),
    },
  });
});

export { toDTO as accountToDTO };

// GET /api/accounts/:id/statement?range|from&to -- one account's money in and
// out over a period, oldest first: what each amount was (type), why (its
// description: invoice, expense, refund and the number, reason...), who did
// it, and the balance after -- opening and closing balance around it.
export const getAccountStatement = asyncHandler(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw new ApiError(404, 'Account not found.');
  const range = resolveDateRange(req.query);
  const staff = !seesBalances(req.user);
  const since = staff ? await lastCloseAt() : null;
  const start = since && since > range.start ? since : range.start;
  const end = range.end;

  const [before] = staff ? [null] : await AccountTransaction.aggregate([
    { $match: { account: account._id, status: 'POSTED', postedAt: { $lt: start } } },
    { $group: { _id: null, cents: { $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$amountCents', { $multiply: ['$amountCents', -1] }] } } } },
  ]);
  const openingCents = staff ? 0 : (account.openingBalanceCents || 0) + (before?.cents || 0);

  // Staff: only their own money (pending sale payments included) since the last close.
  const filter = staff
    ? { account: account._id, ...(await ownSince(req.user, start, { withReversed: true })), createdAt: { $gte: start, $lte: end } }
    : { account: account._id, status: 'POSTED', postedAt: { $gte: start, $lte: end } };
  const items = await AccountTransaction.find(filter)
    .sort({ [staff ? 'createdAt' : 'postedAt']: 1, _id: 1 })
    .limit(5000)
    .populate('createdBy', 'name')
    .lean();

  let running = openingCents;
  let inCents = 0;
  let outCents = 0;
  const rows = items.map((t) => {
    // A cancelled pending receipt is listed (marked) but moved no money.
    const counts = t.status !== 'REVERSED';
    const delta = !counts ? 0 : t.direction === 'IN' ? t.amountCents : -t.amountCents;
    running += delta;
    if (counts && t.direction === 'IN') inCents += t.amountCents;
    else if (counts) outCents += t.amountCents;
    return {
      id: t._id,
      date: t.postedAt || t.createdAt,
      direction: t.direction,
      type: t.type,
      amount: fromCents(t.amountCents),
      description: t.description || '',
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      byName: t.createdBy?.name || '',
      status: t.status,
      correctionNote: t.correctionNote || '',
      correctedByName: t.correctedByName || '',
      balanceAfter: fromCents(running),
      movedToName: t.movedToName || '',
    };
  });

  res.json({
    success: true,
    data: {
      account: { ...toDTO(account), openingBalance: staff ? 0 : fromCents(account.openingBalanceCents), currentBalance: staff ? null : fromCents(account.currentBalanceCents) },
      scope: staff ? 'own' : 'all',
      range: { from: start, to: end },
      opening: fromCents(openingCents),
      moneyIn: fromCents(inCents),
      moneyOut: fromCents(outCents),
      closing: fromCents(openingCents + inCents - outCents),
      rows,
    },
  });
});
