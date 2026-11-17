import Account from '../models/Account.js';
import ProfitDistribution from '../models/ProfitDistribution.js';
import PartnerCapitalTransaction from '../models/PartnerCapitalTransaction.js';
import FixedAssetFundEntry from '../models/FixedAssetFundEntry.js';
import CommissionPayment from '../models/CommissionPayment.js';
import Expense from '../models/Expense.js';
import Liability from '../models/Liability.js';
import AccountTransaction from '../models/AccountTransaction.js';
import Customer from '../models/Customer.js';
import Purchase from '../models/Purchase.js';
import StockEntry from '../models/StockEntry.js';
import { buildBalanceSheet } from './balanceSheetService.js';
import { fromCents } from '../utils/money.js';

// "Where does the difference come from?" -- read-only checks of the records
// a Balance Sheet gap usually comes from, each with the amount and where to
// open it. Nothing is changed, and the Balance Sheet's own figures are not
// touched: this only points at records to look at.
export async function checkBalanceSheet({ date, includeCompanyWallet = false } = {}) {
  const sheet = await buildBalanceSheet({ date, includeCompanyWallet });
  const gapCents = sheet.differenceCents; // Assets − (Liabilities + Equity)
  const findings = [];

  // 1. Suppliers we paid more than we owed: that credit is ours (an asset),
  // but Accounts payable leaves them out and nothing else counts it.
  const supplierRows = await Purchase.aggregate([
    { $match: { status: 'completed', balanceCents: { $ne: 0 } } },
    { $group: { _id: '$supplier', name: { $first: '$supplierName' }, cents: { $sum: '$balanceCents' } } },
    { $match: { cents: { $lt: 0 } } },
  ]);
  if (supplierRows.length) {
    findings.push({
      key: 'supplierCredit',
      title: 'Suppliers paid more than they were owed',
      why: 'The extra is money they hold for us, but the Balance Sheet does not show it anywhere -- Liabilities + Equity come out higher than Assets.',
      cents: -supplierRows.reduce((t, r) => t + r.cents, 0),
      items: supplierRows.map((r) => ({ label: r.name, cents: -r.cents, link: `/suppliers/${r._id}` })),
    });
  }

  // 2. Customers who paid more than they owed (a negative balance that is
  // not in their wallet): owed back to them, but not shown as a liability.
  const customerRows = await Customer.find({ balanceCents: { $lt: 0 } }).select('name balanceCents').lean();
  if (customerRows.length) {
    findings.push({
      key: 'customerCredit',
      title: 'Customers who paid more than they owed',
      why: 'The extra is owed back to them, but it is not in Customer deposits -- Assets come out higher than Liabilities + Equity.',
      cents: -customerRows.reduce((t, r) => t + r.balanceCents, 0),
      items: customerRows.map((r) => ({ label: r.name, cents: -r.balanceCents, link: `/customers/${r._id}` })),
    });
  }

  // 3. Accounts whose balance does not match their own history.
  const sums = new Map(
    (
      await AccountTransaction.aggregate([
        { $match: { status: 'POSTED' } },
        { $group: { _id: '$account', cents: { $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$amountCents', { $multiply: ['$amountCents', -1] }] } } } },
      ])
    ).map((r) => [String(r._id), r.cents])
  );
  const accountRows = (await Account.find().select('name openingBalanceCents currentBalanceCents').lean())
    .map((a) => ({ a, diff: a.currentBalanceCents - ((a.openingBalanceCents || 0) + (sums.get(String(a._id)) || 0)) }))
    .filter((r) => r.diff !== 0);
  if (accountRows.length) {
    findings.push({
      key: 'accountMismatch',
      title: 'Accounts whose balance does not match their history',
      why: 'The balance is not the opening balance plus every entry in and out. A difference here was changed outside the normal paths.',
      cents: accountRows.reduce((t, r) => t + r.diff, 0),
      items: accountRows.map((r) => ({ label: r.a.name, cents: r.diff, link: '/accounts' })),
    });
  }

  // 4. Purchase invoices whose balance is not total − paid.
  const purchaseRows = await Purchase.find({ status: 'completed', $expr: { $ne: ['$balanceCents', { $subtract: ['$totalCostCents', '$paidAmountCents'] }] } })
    .select('purchaseNumber supplierName totalCostCents paidAmountCents balanceCents')
    .limit(50)
    .lean();
  if (purchaseRows.length) {
    findings.push({
      key: 'purchaseMismatch',
      title: 'Purchase invoices whose balance is not total minus paid',
      why: 'What is owed on the invoice does not match its total and what was paid.',
      cents: purchaseRows.reduce((t, p) => t + (p.balanceCents - (p.totalCostCents - p.paidAmountCents)), 0),
      items: purchaseRows.map((p) => ({ label: `${p.purchaseNumber} · ${p.supplierName}`, cents: p.balanceCents - (p.totalCostCents - p.paidAmountCents), link: `/purchases/${p._id}` })),
    });
  }

  // 5. Stock received with no purchase invoice (Stock page without a
  // supplier, POS "+ New item" with stock): it adds to Inventory, but nothing
  // is owed for it and nothing goes into equity. Last 60 days, newest first;
  // one that is exactly the gap is put first.
  const since = new Date(Date.now() - 60 * 86400000);
  const entries = await StockEntry.find({ purchaseInvoice: null, opening: { $ne: true }, createdAt: { $gte: since } }).select('stockSerial createdAt rows').sort({ createdAt: -1 }).limit(200).lean();
  const stockRows = entries
    .map((e) => ({ e, cents: Math.round((e.rows || []).reduce((t, r) => t + Math.max(0, r.quantity || 0) * (r.costPriceCents || 0), 0)) }))
    .filter((x) => x.cents > 0);
  if (stockRows.length) {
    const exact = stockRows.findIndex((x) => x.cents === Math.abs(gapCents));
    if (exact > 0) stockRows.unshift(...stockRows.splice(exact, 1));
    findings.push({
      key: 'stockWithoutPurchase',
      title: 'Stock received with no purchase invoice (last 60 days)',
      why: 'Stock added on the Stock page without a supplier, or with POS "+ New item": Inventory goes up, but nothing is owed for it. If it was bought, add its Supplier Invoice; if it was opening stock, it belongs in the opening balances.',
      cents: stockRows.reduce((t, x) => t + x.cents, 0),
      exactCents: exact >= 0 ? stockRows[0].cents : null,
      items: stockRows.slice(0, 30).map(({ e, cents }) => ({ label: `${e.stockSerial} · ${new Date(e.createdAt).toLocaleDateString()} · ${(e.rows || []).map((r) => r.itemName).slice(0, 3).join(', ')}${(e.rows || []).length > 3 ? '…' : ''}`, cents, link: '/stock' })),
    });
  }

  // 6. Records dated after today (the server's day): an expense, liability or
  // commission typed with tomorrow's date counts in profit only from that
  // day, while its money has already moved -- the two sides meet only then.
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const after = { date: { $gt: endOfToday } };
  const pick = 'amountCents date category name description';
  const [futureExpenses, futureLiabilities, futureShares, futureCapital, futureFund, futureCommissions] = await Promise.all([
    Expense.find({ status: 'POSTED', ...after }).select(pick).limit(50).lean(),
    Liability.find(after).select(pick).limit(50).lean(),
    ProfitDistribution.find(after).limit(50).lean(),
    PartnerCapitalTransaction.find(after).limit(50).lean(),
    FixedAssetFundEntry.find(after).limit(50).lean(),
    CommissionPayment.find(after).limit(50).lean(),
  ]);
  const day = (d) => new Date(d).toLocaleDateString();
  const money = (x) => x.amountCents ?? x.totalCents ?? x.totalAmountCents ?? 0;
  const future = [
    ...futureExpenses.map((x) => ({ label: `Expense · ${x.category || ''} · ${day(x.date)}${x.description ? ` · ${x.description}` : ''}`, cents: money(x), link: '/expenses' })),
    ...futureLiabilities.map((x) => ({ label: `Liability · ${x.name || x.category || ''} · ${day(x.date)}`, cents: money(x), link: '/liabilities' })),
    ...futureShares.map((x) => ({ label: `Profit sharing · ${day(x.date)}`, cents: money(x), link: '/partners/profit-sharing' })),
    ...futureCapital.map((x) => ({ label: `Partner capital · ${day(x.date)}`, cents: money(x), link: '/partners' })),
    ...futureFund.map((x) => ({ label: `Fixed Asset Wallet · ${day(x.date)}`, cents: money(x), link: '/fixed-assets' })),
    ...futureCommissions.map((x) => ({ label: `Commission · ${day(x.date)}`, cents: money(x), link: '/commissions' })),
  ];
  if (future.length) {
    findings.push({
      key: 'futureDated',
      title: 'Records dated after today',
      why: "They count in profit only from their date, but their money or debt is already in the books. Check the date (the server's day may still be yesterday) -- correct it to today.",
      cents: future.reduce((t, x) => t + x.cents, 0),
      items: future,
    });
  }

  // Which finding alone explains the gap exactly.
  const absGap = Math.abs(gapCents);
  for (const f of findings) f.matchesGap = absGap > 0 && (Math.abs(f.cents) === absGap || f.exactCents === absGap);

  return {
    gap: fromCents(gapCents),
    side: gapCents > 0 ? 'assets' : gapCents < 0 ? 'liabilitiesEquity' : null,
    findings: findings.map((f) => ({ ...f, amount: fromCents(f.cents), cents: undefined, exactCents: undefined, items: f.items.map((i) => ({ label: i.label, amount: fromCents(i.cents), link: i.link, isTheGap: absGap > 0 && Math.abs(i.cents) === absGap })) })),
    // A few cents and no finding: rounding of average stock cost (each sale
    // and stock change works in whole cents, so tiny amounts can build up).
    roundingNote: absGap > 0 && absGap < 100 && !findings.some((f) => f.matchesGap)
      ? 'A gap of a few cents with no other cause is rounding: the average cost of stock is kept in whole cents, so selling, returning and editing invoices can leave tiny differences in the stock value. It does not mean money is missing.'
      : null,
  };
}
