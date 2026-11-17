import mongoose from 'mongoose';

// A company wallet (e.g. "Mumtaz Group Wallet"): money the owners put aside
// on its own. It is NOT one of the shop's accounts -- nothing here touches
// account balances, profit, reports or any branch. Company-wide, so it is
// not branch-scoped. balanceCents is the running total of its entries.
const companyWalletSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    note: { type: String, default: '' },
    balanceCents: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('CompanyWallet', companyWalletSchema);
