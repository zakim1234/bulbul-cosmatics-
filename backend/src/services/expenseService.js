import Expense from '../models/Expense.js';
import Account from '../models/Account.js';
import { nextSequence } from '../models/Counter.js';
import { postImmediateTransaction } from './accountService.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents } from '../utils/money.js';
import Liability from '../models/Liability.js';

export async function generateExpenseNumber(session) {
  const seq = await nextSequence('expense', session);
  return `EXP-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;
}

// Records one expense paid from `account` (one OUT account transaction).
// Runs inside the caller's transaction; returns the Expense document.
export async function postExpense(session, { category, amountCents, date, account, note = '', user }) {
  const expenseNumber = await generateExpenseNumber(session);
  const txn = await postImmediateTransaction(
    {
      account,
      direction: 'OUT',
      type: 'EXPENSE',
      amountCents,
      referenceType: 'Expense',
      referenceId: null, // filled below once the expense _id exists
      description: `Expense ${expenseNumber} - ${category}${note ? `: ${note}` : ''}`,
      createdBy: user,
    },
    session
  );
  const [created] = await Expense.create(
    [
      {
        expenseNumber,
        category,
        amountCents,
        date,
        paymentAccount: account._id,
        paymentAccountName: account.name,
        accountTransaction: txn._id,
        note: String(note).trim(),
        createdBy: user?._id || null,
        createdByName: user?.name || '',
      },
    ],
    { session }
  );
  txn.referenceId = created._id;
  await txn.save({ session });
  return created;
}

// Charges an expense now and pays it later: an Expense (with its EXP number,
// on the Expenses page, in Profit & Loss) with no account moving, and a line
// on the Liabilities page to pay it from an account when the money comes.
export async function chargeExpenseLater(session, { category, amountCents, date, name, note = '', user }) {
  const expenseNumber = await generateExpenseNumber(session);
  const [expense] = await Expense.create(
    [{ expenseNumber, category, amountCents, date, paymentAccount: null, paymentAccountName: 'Liabilities -- to pay later', note: String(note || name || '').trim().slice(0, 500), createdBy: user?._id || null, createdByName: user?.name || '' }],
    { session }
  );
  const [liability] = await Liability.create(
    [{ name: String(name || `${category} -- ${expenseNumber}`).trim().slice(0, 120), category, amountCents, date, note: String(note || '').trim().slice(0, 500), expense: expense._id, createdBy: user?._id || null, createdByName: user?.name || '' }],
    { session }
  );
  expense.liability = liability._id;
  await expense.save({ session });
  return { expense, liability };
}

// Voids an expense: its money goes back to the account it was paid from.
// One charged to Liabilities: its line goes (only while nothing is paid on it).
export async function voidExpenseDoc(session, doc, { reason = '', user }) {
  if (doc.status === 'VOIDED') throw new ApiError(409, 'This expense has already been voided.');
  if (doc.liability) {
    const l = await Liability.findById(doc.liability).session(session);
    if (l && l.paidCents > 0) throw new ApiError(409, `${fromCents(l.paidCents).toFixed(2)} of ${doc.expenseNumber} is already paid on the Liabilities page. Undo that payment first.`);
    if (l) await Liability.deleteOne({ _id: l._id }, { session });
    doc.status = 'VOIDED';
    doc.voidedAt = new Date();
    doc.voidReason = reason;
    doc.voidedBy = user?._id || null;
    await doc.save({ session });
    return doc;
  }
  const account = await Account.findById(doc.paymentAccount).session(session);
  if (!account) throw new ApiError(409, 'The account this expense was paid from no longer exists. Contact an administrator.');
  await postImmediateTransaction(
    {
      account,
      direction: 'IN',
      type: 'REFUND',
      amountCents: doc.amountCents,
      referenceType: 'Expense',
      referenceId: doc._id,
      description: `Void of expense ${doc.expenseNumber}${reason ? ` (${reason})` : ''}`,
      createdBy: user,
    },
    session
  );
  doc.status = 'VOIDED';
  doc.voidedAt = new Date();
  doc.voidReason = reason;
  doc.voidedBy = user?._id || null;
  await doc.save({ session });
  return doc;
}
