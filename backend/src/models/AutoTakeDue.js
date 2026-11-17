import mongoose from 'mongoose';

// Automatic daily take (see services/autoWalletTake.js): what each branch
// still owes the company wallet. Every day at 12:00 noon the daily amount is
// added; whatever the branch's accounts can cover is taken at once, the rest
// stays owed and is taken as soon as money comes into any of its accounts.
// Company-wide (not branch-scoped): one document per branch.
const schema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true },
    branchName: { type: String, default: '' },
    owedCents: { type: Number, default: 0 },
    // This branch's own daily amount, set by the Super Admin. null: the
    // amount set for every branch.
    dailyCents: { type: Number, default: null },
    // The business day (YYYY-MM-DD) the daily amount was last added.
    lastChargedDay: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('AutoTakeDue', schema);
