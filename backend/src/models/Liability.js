import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

// A liability: an expense charged now but not paid yet (rent, electricity,
// a supplier of services ...). It counts as an expense in Profit & Loss on
// its date -- Net Income goes down -- while no money leaves an account; the
// unpaid part shows under Liabilities on the Balance Sheet until it is paid
// from an account (payments below).
// `opening`: a debt from before this system (old books): not an expense of
// this system's periods, only a liability to pay off.
const paymentSchema = new mongoose.Schema(
  {
    amountCents: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    accountName: { type: String, default: '' },
    accountTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountTransaction', default: null },
    note: { type: String, default: '' },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, default: '' }, // an expense category (not for an opening one)
    amountCents: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    note: { type: String, default: '' },
    opening: { type: Boolean, default: false },
    // The expense it was charged as (shown on the Expenses page with its
    // EXP number). Profit & Loss counts that expense, not this line.
    expense: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null },
    paidCents: { type: Number, default: 0 },
    payments: { type: [paymentSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

schema.index({ date: -1, createdAt: -1 });
schema.index({ opening: 1, date: 1 });

schema.plugin(branchScoped);

export default mongoose.model('Liability', schema);
