import mongoose from 'mongoose';

// A copy of every message sent to the branch admins about money taken into
// the company wallet (see services/walletNotify.js), kept for the Super
// Admin. Chat messages are cleared at Close Day; these stay.
const schema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    branchName: { type: String, default: '' },
    to: { type: [String], default: [] }, // the admins' names
    text: { type: String, default: '' },
    takenCents: { type: Number, default: 0 },
    // Money given from the wallet into a branch account (not a loan).
    givenCents: { type: Number, default: 0 },
    owedCents: { type: Number, default: 0 },
    batch: { type: String, default: '' },
    automatic: { type: Boolean, default: false },
  },
  { timestamps: true }
);
schema.index({ createdAt: -1 });

export default mongoose.model('WalletNotice', schema);
