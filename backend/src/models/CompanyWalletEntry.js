import mongoose from 'mongoose';

// One movement in a company wallet: money put in (DEPOSIT) or taken out
// (WITHDRAW). balanceAfterCents is the wallet's balance right after it.
const companyWalletEntrySchema = new mongoose.Schema(
  {
    wallet: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyWallet', required: true, index: true },
    type: { type: String, enum: ['DEPOSIT', 'WITHDRAW'], required: true },
    amountCents: { type: Number, required: true, min: 1 },
    balanceAfterCents: { type: Number, default: 0 },
    date: { type: Date, default: Date.now },
    person: { type: String, trim: true, default: '' }, // who brought / took the money
    // Money the Super Admin took from a branch's account into this wallet.
    // The branch's balance sheet shows it under Cash & bank.
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    branchName: { type: String, default: '' },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    accountName: { type: String, default: '' },
    accountTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountTransaction', default: null },
    // One "Take from branches" = one batch (CWT-2026-0001): one statement.
    batch: { type: String, default: '', index: true },
    note: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

companyWalletEntrySchema.index({ wallet: 1, date: -1, createdAt: -1 });

export default mongoose.model('CompanyWalletEntry', companyWalletEntrySchema);
