import Customer from '../models/Customer.js';
import CustomerLedger from '../models/CustomerLedger.js';
import Account from '../models/Account.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';
import { postImmediateTransaction } from '../services/accountService.js';
import { outstandingDebt } from '../services/walletService.js';
import { logAudit } from '../services/auditService.js';

// Money lent to a customer in cash -- no goods. It leaves the chosen account
// and is added to what the customer owes; they pay it back like any debt
// (Pay debt). Cash out, debt in: the Balance Sheet does not move.

// POST /api/customers/:id/loans  { amount, accountId, note }
export const giveLoan = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  const amountCents = toCents(amount);
  if (!Number.isFinite(amount) || amountCents <= 0) throw new ApiError(400, 'Enter the amount lent.');
  if (!req.body.accountId) throw new ApiError(400, 'Choose the account the money is given from.');
  const note = String(req.body.note || '').trim().slice(0, 300);

  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer || customer.archivedAt) throw new ApiError(404, 'Customer not found.');
    const account = await Account.findById(req.body.accountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'That account is not available.');
    if (account.currentBalanceCents < amountCents) throw new ApiError(400, `${account.name} has only ${fromCents(account.currentBalanceCents).toFixed(2)}.`);
    const seq = await nextSequence('customerLoan', session);
    const number = `LOAN-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
    const before = customer.balanceCents;
    customer.balanceCents += amountCents;
    await customer.save({ session });
    const [line] = await CustomerLedger.create(
      [{ customer: customer._id, type: 'LOAN', amountCents, reference: number, account: account._id, description: `Loan ${number} -- cash from ${account.name}${note ? `: ${note}` : ''}`, balanceBeforeCents: before, balanceAfterCents: customer.balanceCents, createdBy: req.user?._id || null }],
      { session }
    );
    await postImmediateTransaction({ account, direction: 'OUT', type: 'CUSTOMER_LOAN', amountCents, referenceType: 'Manual', referenceId: line._id, description: `Loan ${number} to ${customer.name}${note ? ` (${note})` : ''}`, createdBy: req.user }, session);
    return { customer, number, account, line };
  });
  await logAudit({ user: req.user, action: 'customer.loan', entityType: 'Customer', entityId: result.customer._id, details: { number: result.number, amount, account: result.account.name, note } });
  res.status(201).json({ success: true, data: { id: result.line._id, number: result.number, amount, account: result.account.name, balance: fromCents(result.customer.balanceCents) } });
});

// POST /api/customers/:id/loans/:loanId/cancel -- a loan given by mistake:
// the money goes back into its account and off the customer's debt. Only
// while that much of their debt is still unpaid loan / opening debt.
export const cancelLoan = asyncHandler(async (req, res) => {
  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    const loan = await CustomerLedger.findOne({ _id: req.params.loanId, customer: customer._id, type: 'LOAN', amountCents: { $gt: 0 } }).session(session);
    if (!loan) throw new ApiError(404, 'Loan not found.');
    if (loan.cancelledAt) throw new ApiError(409, 'This loan was already cancelled.');
    const { openingCents } = await outstandingDebt(customer, session);
    if (openingCents < loan.amountCents) throw new ApiError(409, `Part of this loan was already paid back (${fromCents(openingCents).toFixed(2)} of it is still owed). Cancel those payments first.`);
    const account = await Account.findById(loan.account).session(session);
    if (!account) throw new ApiError(409, 'The account it came from is gone.');
    const before = customer.balanceCents;
    customer.balanceCents -= loan.amountCents;
    await customer.save({ session });
    loan.cancelledAt = new Date();
    await loan.save({ session });
    await CustomerLedger.create(
      [{ customer: customer._id, type: 'LOAN', amountCents: -loan.amountCents, reference: loan.reference, account: account._id, description: `Loan ${loan.reference} cancelled -- money back in ${account.name}`, balanceBeforeCents: before, balanceAfterCents: customer.balanceCents, createdBy: req.user?._id || null }],
      { session }
    );
    await postImmediateTransaction({ account, direction: 'IN', type: 'CUSTOMER_LOAN', amountCents: loan.amountCents, referenceType: 'Manual', referenceId: loan._id, description: `Loan ${loan.reference} cancelled -- back from ${customer.name}`, createdBy: req.user }, session);
    return { customer, loan };
  });
  await logAudit({ user: req.user, action: 'customer.loan_cancel', entityType: 'Customer', entityId: result.customer._id, details: { number: result.loan.reference, amount: fromCents(result.loan.amountCents) } });
  res.json({ success: true, data: { number: result.loan.reference, balance: fromCents(result.customer.balanceCents) } });
});
