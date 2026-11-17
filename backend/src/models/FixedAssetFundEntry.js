import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

// The Fixed Asset Wallet (on the Fixed Assets page): part of a year's profit
// set aside (SET_ASIDE) and owed to the owners until it is paid out to them
// (PAYOUT). See services/fixedAssetFundService.js.
const schema = new mongoose.Schema(
  {
    type: { type: String, enum: ['SET_ASIDE', 'PAYOUT'], required: true },
    amountCents: { type: Number, required: true, min: 1 },
    year: { type: Number, default: null }, // SET_ASIDE: the year whose profit it came from
    date: { type: Date, required: true },
    note: { type: String, default: '', maxlength: 500 },
    // PAYOUT: who received it, and the account it was paid from.
    person: { type: String, default: '' },
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', default: null },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    accountName: { type: String, default: '' },
    accountTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountTransaction', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

schema.index({ date: -1, createdAt: -1 });
schema.index({ type: 1, year: 1 });

schema.plugin(branchScoped);

export default mongoose.model('FixedAssetFundEntry', schema);
