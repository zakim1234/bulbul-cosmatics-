import FixedAssetFundEntry from '../models/FixedAssetFundEntry.js';

// The Fixed Asset Wallet. The company's equipment (computers, the building's
// fit-out -- the Fixed Assets) was bought with money that is not the
// company's: its whole value is a debt the company owes. Profit pays it back:
//  - Set aside: part of a year's Net Income (and of the profit left to share)
//    goes into the wallet. On the Balance Sheet it moves from Net Income to a
//    "Fixed asset reserve" line in equity -- no account moves.
//  - Paid out: the money leaves an account to the owner and the debt goes
//    down by the same amount.
// Balance Sheet: Fixed asset debt (liability) = the Fixed Assets' value minus
// what has been paid back, so the Fixed Assets line is always matched and the
// sheet stays balanced at every step.

async function totals() {
  const rows = await FixedAssetFundEntry.aggregate([{ $group: { _id: '$type', cents: { $sum: '$amountCents' } } }]);
  const of = (t) => rows.find((r) => r._id === t)?.cents || 0;
  return { setAsideCents: of('SET_ASIDE'), paidOutCents: of('PAYOUT') };
}

// The wallet's balance: set aside minus paid out.
export async function fundBalanceCents() {
  const { setAsideCents, paidOutCents } = await totals();
  return setAsideCents - paidOutCents;
}

// For the Balance Sheet: the reserve (all profit ever set aside) and what
// has been paid back of the equipment debt.
export async function fundTotalsCents() {
  return totals();
}

// Profit set aside from each year's Net Income: Map(year -> cents).
export async function setAsideByYear() {
  const rows = await FixedAssetFundEntry.aggregate([{ $match: { type: 'SET_ASIDE' } }, { $group: { _id: '$year', cents: { $sum: '$amountCents' } } }]);
  return new Map(rows.map((r) => [r._id, r.cents]));
}

export async function setAsideForYearCents(year) {
  return (await setAsideByYear()).get(year) || 0;
}
