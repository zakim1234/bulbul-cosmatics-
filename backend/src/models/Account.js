import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['MOBILE_MONEY', 'BANK', 'MERCHANT', 'OTHER'], default: 'OTHER' },
    accountNumber: { type: String, trim: true, default: '' },
    openingBalanceCents: { type: Number, default: 0 },
    // Reflects only POSTED account transactions. Pending (same-day draft)
    // receipts are never added here -- see AccountTransaction for those.
    currentBalanceCents: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // MERCHANT accounts: VAT % the customer pays on top of what they send
    // through this account (e.g. 5 -> $100 paid comes in as $105).
    vatPercent: { type: Number, default: 0, min: 0, max: 100 },
    // The branch's commission account: the staff's 30% is moved in here and
    // commission is paid out of it (Commissions page). One per branch.
    commission: { type: Boolean, default: false },
  },
  { timestamps: true }
);

accountSchema.index({ branch: 1, name: 1 }, { unique: true });
accountSchema.plugin(branchScoped);

export default mongoose.model('Account', accountSchema);
