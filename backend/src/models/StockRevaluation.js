import mongoose from 'mongoose';
import { branchScoped } from '../services/branchContext.js';

// An item's cost price changed by hand (Inventory -> Edit item) while it had
// stock: the stock is now worth more or less than it cost. That difference
// (quantity x (new cost - old cost)) is a gain or a loss in Profit & Loss
// ("Inventory Adjustments"), so the Balance Sheet stays balanced.
const stockRevaluationSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true },
    oldCostCents: { type: Number, required: true },
    newCostCents: { type: Number, required: true },
    // Signed: more than 0 = the stock is worth more (a gain), less than 0 = a loss.
    changeCents: { type: Number, required: true },
    reason: { type: String, default: 'Cost price changed' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

stockRevaluationSchema.index({ createdAt: -1 });
stockRevaluationSchema.plugin(branchScoped);

export default mongoose.model('StockRevaluation', stockRevaluationSchema);
