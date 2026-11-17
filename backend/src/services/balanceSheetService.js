import Account from '../models/Account.js';
import StockEntry from '../models/StockEntry.js';
import Customer from '../models/Customer.js';
import Purchase from '../models/Purchase.js';
import { NET_OWED } from './supplierPaymentService.js';
import InventoryItem from '../models/InventoryItem.js';
import Partner from '../models/Partner.js';
import FixedAsset from '../models/FixedAsset.js';
import { computePeriod, toDayString } from './profitLossService.js';
import { distributedProfitCents } from './profitDistributionService.js';
import { fromCents } from '../utils/money.js';
import { ApiError } from '../utils/ApiError.js';
import { BUSINESS_NAME } from '../config/business.js';
import { getCompanySetting } from '../models/CompanySetting.js';
import mongoose from 'mongoose';
import CompanyWalletEntry from '../models/CompanyWalletEntry.js';
import { currentBranch } from './branchContext.js';
import { fundTotalsCents, setAsideByYear } from './fixedAssetFundService.js';
import Liability from '../models/Liability.js';

// Money the Super Admin took from the branch accounts into the company
// wallet. It left the accounts (Cash) but still belongs to the business, so
// it stays an asset, shown under Cash & bank. Per branch in a branch view.
// Money given back from the wallet into a branch account is in Cash again,
// so it comes off this line.
export async function getTakenToCompanyWalletCents() {
  const b = currentBranch();
  const match = { account: { $ne: null }, branch: b ? new mongoose.Types.ObjectId(String(b)) : { $ne: null } };
  const [agg] = await CompanyWalletEntry.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$type', 'WITHDRAW'] }, { $multiply: ['$amountCents', -1] }, '$amountCents'] } } } },
  ]);
  return agg?.total || 0;
}

// Every one of these is the business's CURRENT live total -- this app has no
// historical snapshot/ledger of "what the total inventory value was" or
// "what every customer's balance was" on an arbitrary past date, only of
// money movements (Sale/Expense/AccountTransaction) which genuinely do have
// dates. So "as of <date>" only actually changes which fiscal year Net
// Income/Retained Earnings are split at; every balance line below is always
// today's figure regardless of the date picked. See buildBalanceSheet's
// `asOfNote`, surfaced on the report for exactly this reason.

export async function getTotalCashCents() {
  const [agg] = await Account.aggregate([{ $group: { _id: null, total: { $sum: '$currentBalanceCents' } } }]);
  return agg?.total || 0;
}

export async function getTotalReceivableCents() {
  const [agg] = await Customer.aggregate([{ $match: { balanceCents: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$balanceCents' } } }]);
  return agg?.total || 0;
}

export async function getTotalInventoryValueCents() {
  const [agg] = await InventoryItem.aggregate([{ $group: { _id: null, total: { $sum: { $multiply: ['$quantity', '$costPriceCents'] } } } }]);
  return agg?.total || 0;
}

// Opening stock imported from Excel (stock the company already owned before
// this system): part of the owners' equity, as the old books' capital.
export async function getOpeningStockCents() {
  const [agg] = await StockEntry.aggregate([
    { $match: { opening: true } },
    { $unwind: '$rows' },
    { $group: { _id: null, total: { $sum: { $multiply: [{ $ifNull: ['$rows.quantity', 0] }, { $ifNull: ['$rows.costPriceCents', 0] }] } } } },
  ]);
  return Math.round(agg?.total || 0);
}

export async function getTotalPayableCents() {
  // Per supplier, net of any credit they hold (see NET_OWED).
  const [agg] = await Purchase.aggregate([...NET_OWED, { $group: { _id: null, total: { $sum: '$owedCents' } } }]);
  return agg?.total || 0;
}

export async function getTotalPartnerEquityCents() {
  const [agg] = await Partner.aggregate([{ $match: { isActive: true } }, { $group: { _id: null, total: { $sum: '$currentEquityCents' } } }]);
  return agg?.total || 0;
}

// Money customers have deposited into their wallets: it sits in the
// accounts (Cash) but still belongs to the customer, so it is owed back --
// a liability until it is spent on an invoice or withdrawn.
export async function getTotalCustomerDepositsCents() {
  const [agg] = await Customer.aggregate([{ $match: { walletBalanceCents: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$walletBalanceCents' } } }]);
  return agg?.total || 0;
}

// Each active partner's capital, by name -- the lines behind Partners' Capital.
export async function getPartnerCapitalLines() {
  const partners = await Partner.find({ isActive: true }).sort({ createdAt: 1 }).select('name currentEquityCents branch').lean();
  return partners.map((p) => ({ name: p.name, branch: p.branch || null, capitalCents: p.currentEquityCents }));
}

// Opening-balance equipment: bought with the company's own money before this
// system, so it is equity, not a debt.
export async function getOpeningFixedAssetsCents() {
  const [agg] = await FixedAsset.aggregate([{ $match: { isActive: true, opening: true } }, { $group: { _id: null, total: { $sum: '$valueCents' } } }]);
  return agg?.total || 0;
}

export async function getTotalFixedAssetsCents() {
  const [agg] = await FixedAsset.aggregate([{ $match: { isActive: true } }, { $group: { _id: null, total: { $sum: '$valueCents' } } }]);
  return agg?.total || 0;
}

function parseAsOfDate(value) {
  if (!value) {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    return now;
  }
  const day = String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new ApiError(400, 'Enter a valid date.');
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d, 23, 59, 59, 999);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new ApiError(400, 'Enter a valid date.');
  return date;
}

// Net Income (this line, on the Balance Sheet) = accrual profit from the
// start of the calendar year containing `asOf` through `asOf`.
// Retained Earnings = accrual profit from all recorded history before that
// year began. Together they are the business's total accumulated profit to
// date, split at the fiscal-year boundary the way a standard balance sheet
// does. "Fiscal year = calendar year" is a default, not something the app
// lets an admin configure yet.
async function getNetIncomeAndRetainedEarnings(asOf) {
  const fiscalYearStart = new Date(asOf.getFullYear(), 0, 1, 0, 0, 0, 0);
  const inception = new Date(2000, 0, 1); // any date before this system could have real data
  const [currentYear, priorYears, distributedCents, setting, setAside] = await Promise.all([
    computePeriod({ start: fiscalYearStart, end: asOf, basis: 'accrual' }),
    computePeriod({ start: inception, end: new Date(fiscalYearStart.getTime() - 1), basis: 'accrual' }),
    distributedProfitCents(asOf),
    getCompanySetting(),
    setAsideByYear(),
  ]);
  // Profit set aside into the Fixed Asset Wallet: off that year's Net
  // Income, and off Retained Earnings once that year is over.
  let setAsideThisYear = 0;
  let setAsideBefore = 0;
  for (const [y, cents] of setAside) {
    if (y === asOf.getFullYear()) setAsideThisYear += cents;
    else if (y < asOf.getFullYear()) setAsideBefore += cents;
  }
  // The opening balance: profit built up before the company moved to this
  // system (entered once by the Super Admin).
  const openingCents = setting.openingRetainedEarningsCents || 0;
  // This year's profit from before the move: in Net Income for that year;
  // once that year is over it becomes part of Retained Earnings.
  const openingNiCents = setting.openingNetIncomeCents || 0;
  const niYear = setting.openingNetIncomeYear;
  const year = asOf.getFullYear();
  const niThisYear = niYear === year ? openingNiCents : 0;
  const niBefore = niYear && niYear < year ? openingNiCents : 0;
  // Profit already shared out to the partners is no longer retained: paid
  // out it left the business, added to capital it sits in Partners' Capital.
  return { netIncomeCents: currentYear.netIncomeCents + niThisYear - setAsideThisYear, retainedEarningsCents: openingCents + niBefore + priorYears.netIncomeCents - distributedCents - setAsideBefore, openingRetainedEarningsCents: openingCents, openingNetIncomeCents: niThisYear, setAsideThisYearCents: setAsideThisYear };
}

// `includeCompanyWallet`: only the Super Admin's balance sheet shows the money
// taken into the company wallet; a branch admin sees it as it always was.
export async function buildBalanceSheet({ date, includeCompanyWallet = false } = {}) {
  const asOf = parseAsOfDate(date);
  // Compared as the same "YYYY-MM-DD" string `date` already is against
  // today's local calendar day, not `new Date(date).toDateString()`: a bare
  // "YYYY-MM-DD" string parses as UTC midnight, which `.toDateString()`
  // then renders in the server's local timezone -- a day behind for any
  // timezone behind UTC (e.g. America/Los_Angeles), which would make an
  // admin's own "today" never match and show a misleading "not necessarily
  // today" note.
  const isToday = !date || String(date).slice(0, 10) === toDayString(new Date());

  const [cashCents, receivableCents, inventoryCents, payableCents, fixedAssetsCents, partnersEquityCents, { netIncomeCents, retainedEarningsCents, openingRetainedEarningsCents, openingNetIncomeCents, setAsideThisYearCents }, customerDepositsCents, partnerLines, walletTakenCents, fund, openingFixedAssetsCents, unpaid, openingStockCents] =
    await Promise.all([
      getTotalCashCents(),
      getTotalReceivableCents(),
      getTotalInventoryValueCents(),
      getTotalPayableCents(),
      getTotalFixedAssetsCents(),
      getTotalPartnerEquityCents(),
      getNetIncomeAndRetainedEarnings(asOf),
      getTotalCustomerDepositsCents(),
      getPartnerCapitalLines(),
      includeCompanyWallet ? getTakenToCompanyWalletCents() : 0,
      fundTotalsCents(),
      getOpeningFixedAssetsCents(),
      Liability.aggregate([{ $group: { _id: '$opening', cents: { $sum: { $subtract: ['$amountCents', { $ifNull: ['$paidCents', 0] }] } } } }]),
      getOpeningStockCents(),
    ]);
  // Liabilities page: expenses charged but not paid yet, and debts from the
  // old books (opening) -- what is still unpaid of each.
  const unpaidExpensesCents = unpaid.filter((r) => r._id !== true).reduce((t, r) => t + r.cents, 0);
  const openingLiabilitiesCents = unpaid.filter((r) => r._id === true).reduce((t, r) => t + r.cents, 0);
  // The equipment was bought with money that is not the company's: its value
  // is owed, less what profit has paid back. Profit set aside for it sits in
  // equity as the Fixed asset reserve. Opening-balance equipment (the
  // company's own, from before this system) is not a debt, and it is not
  // added to equity either: the old books' capital and profit already
  // include it, so it shows in Fixed Assets only.
  const fixedAssetDebtCents = Math.max(0, fixedAssetsCents - openingFixedAssetsCents - fund.paidOutCents);
  const fixedAssetReserveCents = fund.setAsideCents;

  const totalCurrentAssetsCents = cashCents + walletTakenCents + receivableCents + inventoryCents;
  // Stock is valued at its exact average cost (it may hold a fraction of a
  // cent), so the two sides are compared in whole cents.
  const totalAssetsCents = Math.round(totalCurrentAssetsCents + fixedAssetsCents);
  const totalLiabilitiesCents = payableCents + customerDepositsCents + fixedAssetDebtCents + unpaidExpensesCents + openingLiabilitiesCents;
  const totalEquityCents = partnersEquityCents + retainedEarningsCents + netIncomeCents + fixedAssetReserveCents + openingStockCents;
  const totalLiabilitiesAndEquityCents = Math.round(totalLiabilitiesCents + totalEquityCents);

  return {
    title: 'Balance Sheet',
    business: BUSINESS_NAME,
    // Local calendar day, not asOf.toISOString().slice(0, 10) -- that
    // converts to UTC first, which silently rolls a late-day local instant
    // (asOf is pinned to 23:59:59.999 local) into the next UTC day for any
    // server timezone behind UTC (e.g. asking for "today" in America/Los_
    // Angeles could come back labelled tomorrow).
    asOf: toDayString(asOf),
    asOfNote: isToday
      ? null
      : "Cash, Receivables, Inventory, Payables, Partners' Capital and Fixed Assets are always today's figures -- this app keeps no historical snapshot of them for a past date. Only Net Income/Retained Earnings reflect the date chosen.",
    assets: {
      cash: fromCents(cashCents),
      companyWallet: fromCents(walletTakenCents),
      receivable: fromCents(receivableCents),
      inventory: fromCents(inventoryCents),
      totalCurrentAssets: fromCents(totalCurrentAssetsCents),
      fixedAssets: fromCents(fixedAssetsCents),
      totalAssets: fromCents(totalAssetsCents),
    },
    liabilities: {
      payable: fromCents(payableCents),
      customerDeposits: fromCents(customerDepositsCents),
      fixedAssetDebt: fromCents(fixedAssetDebtCents),
      unpaidExpenses: fromCents(unpaidExpensesCents),
      openingLiabilities: fromCents(openingLiabilitiesCents),
      totalCurrentLiabilities: fromCents(totalLiabilitiesCents),
      totalLiabilities: fromCents(totalLiabilitiesCents),
    },
    equity: {
      partnersCapital: fromCents(partnersEquityCents),
      partners: partnerLines.map((p) => ({ name: p.name, branch: p.branch, capital: fromCents(p.capitalCents) })),
      retainedEarnings: fromCents(retainedEarningsCents),
      openingRetainedEarnings: fromCents(openingRetainedEarningsCents),
      openingNetIncome: fromCents(openingNetIncomeCents),
      netIncome: fromCents(netIncomeCents),
      setAsideThisYear: fromCents(setAsideThisYearCents || 0),
      fixedAssetReserve: fromCents(fixedAssetReserveCents),
      openingStock: fromCents(openingStockCents),
      totalEquity: fromCents(totalEquityCents),
    },
    totalLiabilitiesAndEquity: fromCents(totalLiabilitiesAndEquityCents),
    // A non-zero difference means something was recorded outside the paths
    // this report knows about (e.g. a Fixed Asset added with no matching
    // capital contribution/account deduction) -- expected until every such
    // gap is entered, not necessarily a bug. See QAYBTA 4 of the spec.
    isBalanced: totalAssetsCents === totalLiabilitiesAndEquityCents,
    differenceCents: totalAssetsCents - totalLiabilitiesAndEquityCents,
    difference: fromCents(totalAssetsCents - totalLiabilitiesAndEquityCents),
  };
}
