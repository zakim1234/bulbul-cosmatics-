import { ApiError } from '../utils/ApiError.js';

// The single authoritative Weighted Average Cost (WAC) formula for the whole
// application. Every place that receives inventory (Stock IN, a customer
// return, a full sale reversal) must call this instead of recalculating its
// own blend, so the business rule can never drift between call sites.
//
// Canonical formula:
//   newAverageCost = (oldQuantity * oldAverageCost + incomingQuantity * incomingUnitCost)
//                     / (oldQuantity + incomingQuantity)
//
// Zero-stock rule: if there is no stock currently on hand, any stale old
// average cost is discarded entirely rather than blended in -- the new
// average simply becomes the incoming unit cost.
//
// No rounding: the average is kept exactly as it divides (e.g. 33.333...
// cents), never cut to whole cents. Rounding it lost a fraction of a cent on
// every blend, and those fractions built up into a gap between the stock
// value and the books (the Balance Sheet out by a few cents). Kept exact,
// the stock value and the cost of what is sold always agree; amounts are
// rounded to whole cents only when shown (utils/money.js fromCents).
export function calculateWeightedAverageCost({ oldQuantity, oldAverageCostCents, incomingQuantity, incomingUnitCostCents }) {
  // oldQuantity may be below zero (sold ahead of stock): like zero, the
  // incoming cost becomes the average.
  if (!Number.isFinite(oldQuantity)) throw new ApiError(400, 'Invalid current stock quantity for cost calculation.');
  if (!Number.isFinite(oldAverageCostCents) || oldAverageCostCents < 0) throw new ApiError(400, 'Invalid current average cost for cost calculation.');
  if (!Number.isSafeInteger(incomingQuantity) || incomingQuantity <= 0) throw new ApiError(400, 'Incoming quantity must be a positive whole number.');
  if (!Number.isFinite(incomingUnitCostCents) || incomingUnitCostCents < 0) throw new ApiError(400, 'Incoming unit cost cannot be negative.');

  if (oldQuantity <= 0) return incomingUnitCostCents;

  const newQuantity = oldQuantity + incomingQuantity;
  const newInventoryValueCents = oldQuantity * oldAverageCostCents + incomingQuantity * incomingUnitCostCents;
  return newInventoryValueCents / newQuantity;
}
