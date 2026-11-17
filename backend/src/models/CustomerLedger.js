import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

// The append-only source of truth for every customer balance change.
// Customer.balanceCents is a cached, always-atomically-updated projection
// of this ledger, kept for fast reads - but this collection is what answers
// "where did this debt come from" and must never be edited or deleted.
const customerLedgerSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    type: {
      type: String,
      // LOAN: money lent to the customer in cash (no goods): +debt; its
      // cancel is a LOAN with a minus amount.
      enum: ['SALE_CREDIT', 'PAYMENT', 'ADJUSTMENT', 'SALE_VOID', 'SALE_RETURN', 'REFUND', 'PAYMENT_CANCELLED', 'LOAN'],
      required: true,
    },
    amountCents: { type: Number, required: true }, // signed: +increases debt, -decreases debt
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    description: { type: String, default: '' },
    // A loan: its number (LOAN-YYYY-NNNN), the account the money came from,
    // and whether it was cancelled (by a second, opposite LOAN line).
    reference: { type: String, default: '' },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    cancelledAt: { type: Date, default: null },
    balanceBeforeCents: { type: Number, required: true },
    balanceAfterCents: { type: Number, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

customerLedgerSchema.index({ customer: 1, createdAt: 1 });
customerLedgerSchema.index({ sale: 1 });

customerLedgerSchema.plugin(branchScoped);

export default mongoose.model('CustomerLedger', customerLedgerSchema);
