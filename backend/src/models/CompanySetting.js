import mongoose from 'mongoose';

// Company-wide settings: one document, _id 'company'. Not branch-scoped.
//   openingRetainedEarningsCents: the profit the company had already built up
//   before it moved to this system (from QuickBooks, the old books ...). It is
//   added to Retained Earnings on the Balance Sheet.
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: 'company' },
    openingRetainedEarningsCents: { type: Number, default: 0 },
    openingRetainedEarningsNote: { type: String, default: '' },
    // This year's profit made before the move (from the old system's P&L).
    // Counted in Net Income only for that fiscal year.
    openingNetIncomeCents: { type: Number, default: 0 },
    openingNetIncomeYear: { type: Number, default: null },
    updatedByName: { type: String, default: '' },
    // Automatic daily take into a company wallet (services/autoWalletTake.js):
    // every branch, every day at 12:00 noon Somalia time.
    autoTakeEnabled: { type: Boolean, default: false },
    autoTakeAmountCents: { type: Number, default: 0 },
    autoTakeWallet: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyWallet', default: null },
  },
  { timestamps: true }
);

export default mongoose.model('CompanySetting', schema);

export async function getCompanySetting() {
  return (await mongoose.model('CompanySetting').findById('company')) || { openingRetainedEarningsCents: 0, openingRetainedEarningsNote: '', openingNetIncomeCents: 0, openingNetIncomeYear: null };
}
