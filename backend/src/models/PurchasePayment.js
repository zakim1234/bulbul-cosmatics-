import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

// One payment made toward a Purchase invoice's balance -- there can be many
// of these over time as a supplier is paid in installments. Distinct from
// the customer-facing Payment model (that one requires a `customer` and
// allocates against Sales; this one belongs to a Purchase/supplier instead).
const schema = new mongoose.Schema(
  {
    paymentNumber: { type: String, required: true, unique: true }, // PPAY-YYYY-NNNNNN
    purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', required: true },
    amountCents: { type: Number, required: true, min: 0 },
    paymentAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null }, // null: an offset (no money moved)
    paymentAccountName: { type: String, default: '' },
    accountTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountTransaction', default: null },
    previousBalanceCents: { type: Number, required: true }, // Purchase.balanceCents immediately before this payment
    newBalanceCents: { type: Number, required: true },
    note: { type: String, default: '', maxlength: 500 },
    // Serial number on the supplier's own (often handwritten) payment receipt.
    receiptNo: { type: String, default: '', maxlength: 60, trim: true },
    // The business date of the payment (editable); defaults to when it was
    // recorded. createdAt stays the moment it was entered.
    paymentDate: { type: Date, default: null },
    // Set when this payment is one part of a Bulk Payment to the supplier.
    bulkPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'BulkPurchasePayment', default: null },
    editedAt: { type: Date, default: null },
    status: { type: String, enum: ['POSTED', 'REVERSED'], default: 'POSTED' },
    // A discount the supplier gave when paying (e.g. owed 1000, paid 800,
    // 200 off): it clears the invoice like a payment but no money moves --
    // it is Discount Received (income) on the Profit & Loss.
    discount: { type: Boolean, default: false },
    reversedAt: { type: Date, default: null },
    reversalReason: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

schema.index({ purchase: 1, createdAt: -1 });

schema.plugin(branchScoped);

export default mongoose.model('PurchasePayment', schema);
