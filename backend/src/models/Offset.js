import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

// A customer who is also a supplier: what they owe us and what we owe them
// are set off against each other. The smaller amount comes off both sides
// (it becomes 0), the bigger one keeps the difference. No money moves.
const offsetSchema = new mongoose.Schema(
  {
    offsetNumber: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, default: '' },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, default: '' },
    amountCents: { type: Number, required: true, min: 1 },
    customerBeforeCents: { type: Number, default: 0 },
    customerAfterCents: { type: Number, default: 0 },
    supplierBeforeCents: { type: Number, default: 0 },
    supplierAfterCents: { type: Number, default: 0 },
    customerPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    customerReceipt: { type: String, default: '' },
    supplierPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'BulkPurchasePayment', default: null },
    supplierReceipt: { type: String, default: '' },
    date: { type: Date, default: Date.now },
    note: { type: String, default: '' },
    status: { type: String, enum: ['POSTED', 'CANCELLED'], default: 'POSTED' },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);
offsetSchema.index({ createdAt: -1 });
offsetSchema.plugin(branchScoped);

export default mongoose.model('Offset', offsetSchema);
