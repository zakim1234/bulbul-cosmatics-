import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

// A durable, non-trade asset (computer, shelving, furniture, ...) recorded
// for the Balance Sheet's Fixed Assets section. Not inventory -- these are
// never sold and never touch Stock/WAC.
const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    valueCents: { type: Number, required: true, min: 0 },
    // Who it was bought from / whose money paid for it: the company owes
    // them its value until it is paid back from the Fixed Asset Wallet.
    owedTo: { type: String, trim: true, default: '' },
    // Opening balance: equipment the company bought with its own money
    // before this system. It is not a debt -- nobody is owed for it.
    opening: { type: Boolean, default: false },
    dateAdded: { type: Date, required: true },
    notes: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    removedAt: { type: Date, default: null },
    removedReason: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

schema.index({ isActive: 1, dateAdded: -1 });

schema.plugin(branchScoped);

export default mongoose.model('FixedAsset', schema);
