import { createSaleDraft, assertWithinCreditLimit, normalizeSaleNotes, validateSaleItems, resolveLinePricing, debitWallet, restoreWallet, assertBusinessDayOpen, priceChangesOf, merchantVat, netOfMerchantVat } from '../services/saleService.js';
import { whoLabel } from '../utils/whoLabel.js';
import Sale from '../models/Sale.js';
import { userHas } from '../models/User.js';
import Customer from '../models/Customer.js';
import InventoryItem from '../models/InventoryItem.js';
import InventoryLot from '../models/InventoryLot.js';
import Account from '../models/Account.js';
import AccountTransaction from '../models/AccountTransaction.js';
import Payment from '../models/Payment.js';
import CustomerLedger from '../models/CustomerLedger.js';
import CustomerWalletTransaction from '../models/CustomerWalletTransaction.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';
import { resolveDateRange } from '../utils/dateRange.js';
import { logAudit } from '../services/auditService.js';
import { applyWalletToDebt } from '../services/walletService.js';
import { restoreLotConsumption } from '../services/lotService.js';
import { bookStockValueGap } from '../services/stockRevaluationService.js';
import { reserveStock, releaseReservation } from '../services/stockService.js';
import { calculateWeightedAverageCost } from '../services/costingService.js';
import { createPendingTransaction, reverseTransaction, postImmediateTransaction } from '../services/accountService.js';
import { confirmSale } from '../services/dayCloseService.js';

// The Super Admin edited it: only they, or someone given the permission, may change it again.
function assertNotLocked(sale, user) {
  if (user?.isSuperAdmin || userHas(user, 'changeLockedInvoices')) return;
  if (sale.lockedBySuperAdmin || (sale.lockedByAdmin && user?.role !== 'admin')) {
    throw new ApiError(403, `${sale.editedByName || 'An admin'} corrected ${sale.receiptNumber}. You can see the change, but you cannot change it unless you are given permission.`);
  }
}

function toDTO(sale) {
  return {
    id: sale._id,
    editedAt: sale.editedAt || null,
    editedByName: sale.editedByName || '',
    lockedBySuperAdmin: !!sale.lockedBySuperAdmin,
    lockedByAdmin: !!sale.lockedByAdmin,
    awaitingDayClose: !!sale.awaitingDayClose,
    receiptNumber: sale.receiptNumber,
    // `customer`/`paymentAccount` are populated (objects) by getSale/getReceipt
    // but plain ObjectIds everywhere else -- always normalize to a bare id
    // string so callers never have to guess the shape.
    customer: sale.customer?._id || sale.customer,
    customerName: sale.customerName,
    items: sale.items.map((i) => ({
      item: i.item,
      name: i.itemName,
      itemCode: i.itemCode,
      serialNumber: i.serialNumber,
      quantity: i.quantity,
      returnedQuantity: i.returnedQuantity || 0,
      unitPrice: fromCents(i.unitPriceCents),
      costPrice: fromCents(i.costPriceCents),
      discount: fromCents(i.discountCents),
      subtotal: fromCents(i.subtotalCents),
      lineTotal: fromCents(i.subtotalCents - (i.discountCents || 0)),
      allocations: i.lotConsumption,
      batchReservations: i.batchReservations,
    })),
    subtotal: fromCents(sale.subtotalCents),
    discount: fromCents(sale.discountCents),
    total: fromCents(sale.totalCents),
    paidAmount: fromCents(sale.paidAmountCents),
    vatPercent: sale.vatPercent || 0,
    vat: fromCents(sale.vatCents || 0),
    walletAmount: fromCents(sale.walletAmountCents),
    paymentAccount: sale.paymentAccount?._id || sale.paymentAccount,
    notes: sale.notes || '',
    balanceAdded: fromCents(sale.balanceAddedCents),
    outstanding: fromCents(sale.outstandingCents),
    profit: fromCents(sale.profitCents),
    previousBalance: fromCents(sale.previousBalanceCents),
    newBalance: fromCents(sale.previousBalanceCents + sale.balanceAddedCents),
    status: sale.status,
    confirmedAt: sale.confirmedAt,
    cancelledAt: sale.cancelledAt,
    cancelledReason: sale.cancelledReason,
    cancelRefund: sale.cancelRefund?.to
      ? {
          to: sale.cancelRefund.to,
          amount: fromCents(sale.cancelRefund.amountCents),
          accountName: sale.cancelRefund.accountName,
          reference: sale.cancelRefund.reference,
          byName: sale.cancelRefund.byName,
        }
      : null,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
    quotation: sale.quotation || null,
    settledPaidAmount: fromCents(sale.status === 'CONFIRMED' ? sale.totalCents - sale.outstandingCents : sale.paidAmountCents),
    returns: (sale.returns || []).map((r, i) => ({
      index: i,
      items: r.items.map((i2) => ({ item: i2.item, name: i2.itemName, quantity: i2.quantity, unitPrice: fromCents(i2.unitPriceCents) })),
      amount: fromCents(r.amountCents),
      debtReduced: fromCents(r.debtReducedCents),
      refund: fromCents(r.refundCents),
      walletRefund: fromCents(r.walletRefundCents || 0),
      refundTo: r.refundTo || (r.refundCents > 0 ? 'ACCOUNT' : ''),
      refundAccountName: r.refundAccountName || '',
      refundReference: r.refundReference || '',
      reason: r.reason,
      invoiceBalanceAfter: r.invoiceBalanceAfterCents != null ? fromCents(r.invoiceBalanceAfterCents) : null,
      customerBalanceAfter: r.customerBalanceAfterCents != null ? fromCents(r.customerBalanceAfterCents) : null,
      createdAt: r.createdAt,
    })),
  };
}

// POST /api/sales -- always creates a DRAFT/PENDING invoice. Stock is
// reserved (never physically deducted) and any payment is recorded as a
// PENDING account receipt. Nothing here touches customer balance, revenue,
// COGS, or profit -- those are only posted for real when Close Day confirms
// this invoice.
export const createSale = asyncHandler(async (req, res) => {
  // A sales invoice is final at once -- it does not wait as Pending for
  // Close Day: stock, the customer's debt and the account are posted now.
  // Close Day still counts it in that day's totals (awaitingDayClose).
  const result = await runInTransaction(async (session) => {
    const sale = await createSaleDraft(req.body, req.user, session);
    await confirmSale(sale, session, req.user);
    sale.awaitingDayClose = true;
    await sale.save({ session });
    return sale;
  });

  await logAudit({
    user: req.user,
    action: 'sale.create',
    entityType: 'Sale',
    entityId: result._id,
    details: { receiptNumber: result.receiptNumber, total: fromCents(result.totalCents) },
  });
  await logPriceChanges(req.user, result);

  res.status(201).json({ success: true, data: toDTO(result) });
});

// Records an invoice's price changes and discounts in the audit log. Only a
// record: it never stops or changes the sale, and a failure here never
// fails the request (the sale is already saved).
async function logPriceChanges(user, sale) {
  try {
    const changes = await priceChangesOf(sale);
    if (changes) await logAudit({ user, action: 'sale.price_override', entityType: 'Sale', entityId: sale._id, details: changes });
  } catch (err) {
    console.error('[audit] could not record price changes:', err.message);
  }
}

// PUT /api/sales/:id -- same-day edit of a DRAFT invoice: items, quantities,
// discount, paid amount and payment account can all change. Reservations
// and the pending account receipt are recomputed from scratch each time.
// Editing an invoice after Close Day: the old version is undone first --
// its stock goes back (at its own historical cost), the customer's debt and
// payment come off, the money paid at the sale leaves the account again (its
// own entry, so the history stays) -- then the new version is saved and
// confirmed straight away, same invoice number and date. Not when items were
// returned or debt payments were made on it later (those are undone first).
async function undoConfirmedSale(sale, session, user) {
  if (sale.items.some((l) => (l.returnedQuantity || 0) > 0)) throw new ApiError(409, 'Items were returned on this invoice, so it cannot be edited. Cancel the return first.');
  const paidLaterCents = Math.max(0, sale.balanceAddedCents - sale.outstandingCents);
  if (paidLaterCents > 0) throw new ApiError(409, `${fromCents(paidLaterCents).toFixed(2)} of this invoice was paid later as debt. Cancel that payment first, then edit the invoice.`);
  const label = `Invoice ${sale.receiptNumber} edited`;

  for (const line of sale.items) {
    const itemDoc = await InventoryItem.findById(line.item).session(session);
    if (itemDoc) {
      const oldQuantity = itemDoc.quantity;
      const oldAverageCostCents = itemDoc.costPriceCents;
      const newAverageCostCents = calculateWeightedAverageCost({ oldQuantity, oldAverageCostCents, incomingQuantity: line.quantity, incomingUnitCostCents: line.costPriceCents });
      itemDoc.stockEvents.push({ type: 'SALE_REVERSAL', reference: sale.receiptNumber, quantityBefore: oldQuantity, quantityAfter: oldQuantity + line.quantity, averageCostBeforeCents: oldAverageCostCents, averageCostAfterCents: newAverageCostCents });
      await bookStockValueGap(session, itemDoc, { oldQuantity, oldCostCents: oldAverageCostCents, newQuantity: oldQuantity + line.quantity, newCostCents: newAverageCostCents, incomingQuantity: line.quantity, incomingUnitCostCents: line.costPriceCents }, { reason: `${sale.receiptNumber} edited: units sold ahead of stock`, user });
      itemDoc.quantity = oldQuantity + line.quantity;
      itemDoc.costPriceCents = newAverageCostCents;
      await itemDoc.save({ session });
      await restoreLotConsumption(line.lotConsumption, session);
    }
    line.lotConsumption = [];
    line.batchReservations = [];
  }

  const customer = sale.customer ? await Customer.findById(sale.customer).session(session) : null;
  if (customer) {
    const before = customer.balanceCents;
    customer.balanceCents -= sale.outstandingCents;
    customer.totalPurchasedCents -= sale.totalCents;
    customer.totalPaidCents = Math.max(0, customer.totalPaidCents - sale.paidAmountCents);
    await customer.save({ session });
    if (sale.outstandingCents > 0) {
      await CustomerLedger.create([{ customer: customer._id, type: 'ADJUSTMENT', amountCents: -sale.outstandingCents, sale: sale._id, description: `${label} -- old version taken off`, balanceBeforeCents: before, balanceAfterCents: customer.balanceCents, createdBy: user?._id }], { session });
    }
    if (sale.walletAmountCents > 0) await restoreWallet(customer, sale.walletAmountCents, sale, session, user);
  }
  sale.walletAmountCents = 0;

  // The money paid at the sale leaves the account it came into.
  const txn = sale.accountTransaction ? await AccountTransaction.findById(sale.accountTransaction).session(session) : null;
  if (txn?.status === 'POSTED') {
    const account = await Account.findById(txn.account).session(session);
    if (account) await postImmediateTransaction({ account, direction: 'OUT', type: 'REFUND', amountCents: txn.amountCents, referenceType: 'Sale', referenceId: sale._id, description: `${label} -- old payment taken back`, createdBy: user }, session);
  } else if (txn?.status === 'PENDING') {
    await reverseTransaction(txn._id, session);
  }
  sale.accountTransaction = null;
  await Payment.updateMany({ type: 'sale', relatedSale: sale._id, status: { $ne: 'CANCELLED' } }, { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: `${label} -- replaced` } }, { session });
  sale.status = 'DRAFT';
}

export const updateSale = asyncHandler(async (req, res) => {
  const { items, discount = 0, paidAmount = 0, walletAmount = 0, paymentAccountId, vatPercent } = req.body;
  const notes = req.body.notes === undefined ? undefined : normalizeSaleNotes(req.body.notes);
  validateSaleItems({ items, discount, paidAmount });
  if (!Number.isFinite(Number(walletAmount)) || !Number.isSafeInteger(toCents(walletAmount)) || Number(walletAmount) < 0) {
    throw new ApiError(400, 'Wallet amount cannot be negative.');
  }
  await assertBusinessDayOpen();

  const result = await runInTransaction(async (session) => {
    const sale = await Sale.findById(req.params.id).session(session);
    if (!sale) throw new ApiError(404, 'Sale not found.');
    if (sale.status === 'CANCELLED') throw new ApiError(409, 'This invoice is cancelled and cannot be edited.');
    assertNotLocked(sale, req.user);
    // A confirmed invoice: undo the confirmed version, then save the new one.
    // Only one from a day already closed needs "Edit invoices after Close Day";
    // today's (still to be counted by Close Day) needs just Edit invoices.
    const wasConfirmed = sale.status === 'CONFIRMED';
    if (wasConfirmed && !sale.awaitingDayClose && !userHas(req.user, 'editClosedInvoices')) throw new ApiError(403, 'Editing an invoice after Close Day needs the "Edit invoices after Close Day" permission.');


    let account = null;
    if (paymentAccountId) {
      account = await Account.findById(paymentAccountId).session(session);
      if (!account || !account.isActive) throw new ApiError(400, 'Selected payment account is not available.');
    }
    // Validated before anything is mutated: runInTransaction falls back to no
    // session at all on a standalone (non-replica-set) MongoDB, so a
    // mid-function throw would NOT roll back reservations already touched.
    if (toCents(paidAmount) > 0 && !account) {
      throw new ApiError(400, 'Please select a payment account for the amount being paid.');
    }

    if (wasConfirmed) {
      await undoConfirmedSale(sale, session, req.user);
    } else {
      // Release every existing reservation for this draft before re-reserving
      // against the new line items, so a removed/reduced line frees stock.
      for (const line of sale.items) {
        await releaseReservation(line.item, line.quantity, session, line.batchReservations);
      }
      if (sale.accountTransaction) {
        await reverseTransaction(sale.accountTransaction, session);
        sale.accountTransaction = null;
      }
    }

    // Restore any previously-applied wallet credit before re-validating and
    // re-applying the (possibly different) new amount below.
    const customer = await Customer.findById(sale.customer).session(session);
    if (customer && sale.walletAmountCents > 0) {
      await restoreWallet(customer, sale.walletAmountCents, sale, session, req.user);
    }

    const saleItems = [];
    let subtotalCents = 0;
    let lineDiscountTotalCents = 0;
    for (const line of items) {
      const item = await InventoryItem.findById(line.itemId).session(session);
      if (!item) throw new ApiError(404, `Product not found (id: ${line.itemId}).`);
      const qty = Math.round(Number(line.quantity));
      const batchReservations = await reserveStock(item._id, qty, session);

      const { unitPriceCents, costPriceCents, discountCents: lineDiscountCents, subtotalCents: subtotalLineCents } = resolveLinePricing(line, item);
      saleItems.push({
        item: item._id,
        itemName: item.name,
        itemCode: item.itemCode,
        serialNumber: item.serialNumber,
        quantity: qty,
        unitPriceCents,
        costPriceCents,
        discountCents: lineDiscountCents,
        subtotalCents: subtotalLineCents,
        lotConsumption: [],
        batchReservations,
      });
      subtotalCents += subtotalLineCents;
      lineDiscountTotalCents += lineDiscountCents;
    }

    const discountCents = Math.min(toCents(discount) + lineDiscountTotalCents, subtotalCents);
    const totalCents = subtotalCents - discountCents;
    let paidAmountCents = toCents(paidAmount);
    const walletAmountCents = toCents(walletAmount);
    if (paidAmountCents + walletAmountCents > totalCents) {
      throw new ApiError(400, 'Amount paid plus wallet amount cannot exceed the invoice total.');
    }
    if (customer && walletAmountCents > customer.walletBalanceCents) {
      throw new ApiError(400, `Wallet balance (${(customer.walletBalanceCents / 100).toFixed(2)}) is less than the requested wallet payment.`);
    }
    if (customer) await assertWithinCreditLimit(customer, totalCents - paidAmountCents - walletAmountCents, session, sale._id);

    sale.items = saleItems;
    if (notes !== undefined) sale.notes = notes;
    sale.subtotalCents = subtotalCents;
    sale.discountCents = discountCents;
    sale.totalCents = totalCents;
    sale.paidAmountCents = paidAmountCents;
    sale.walletAmountCents = walletAmountCents;
    sale.paymentAccount = account?._id || null;
    Object.assign(sale, merchantVat(account, paidAmountCents, vatPercent));
    sale.balanceAddedCents = totalCents - paidAmountCents - walletAmountCents;

    if (customer && walletAmountCents > 0) {
      await debitWallet(customer, walletAmountCents, sale, session, req.user);
    }

    if (paidAmountCents > 0 && account) {
      const txn = await createPendingTransaction(
        {
          account,
          direction: 'IN',
          type: 'SALE_PAYMENT',
          amountCents: netOfMerchantVat(sale, paidAmountCents),
          referenceType: 'Sale',
          referenceId: sale._id,
          description: `${wasConfirmed ? 'Sale' : 'Draft sale'} ${sale.receiptNumber}${sale.vatCents ? ` (merchant kept VAT ${sale.vatPercent}%: ${(sale.vatCents / 100).toFixed(2)})` : ''} (edited${wasConfirmed ? '' : ', pending Close Day'})`,
          createdBy: req.user,
        },
        session
      );
      sale.accountTransaction = txn?._id || null;
      // Edited by someone else (e.g. the Super Admin): the cashier who made
      // it sees, in their account, that it was changed and by whom.
      if (txn && sale.createdBy && String(sale.createdBy) !== String(req.user?._id)) {
        await AccountTransaction.updateOne({ _id: txn._id }, { $set: { correctionNote: `Invoice ${sale.receiptNumber} edited`, correctedByName: whoLabel(req.user) } }, { session });
      }
    }

    // Who edited it; the Super Admin's edit locks it for everyone else.
    sale.editedAt = new Date();
    sale.editedByName = whoLabel(req.user);
    if (req.user?.isSuperAdmin) sale.lockedBySuperAdmin = true;
    else if (req.user?.role === 'admin' && String(sale.createdBy || '') !== String(req.user._id)) sale.lockedByAdmin = true;
    await sale.save({ session });
    // Edited after Close Day: final again at once (stock, customer, account).
    if (wasConfirmed) await confirmSale(sale, session, req.user);
    return sale;
  });

  await logAudit({
    user: req.user,
    action: result.confirmedAt && result.status === 'CONFIRMED' ? 'sale.edit_confirmed' : 'sale.edit_draft',
    entityType: 'Sale',
    entityId: result._id,
    details: { receiptNumber: result.receiptNumber },
  });
  await logPriceChanges(req.user, result);

  res.json({ success: true, data: toDTO(result) });
});

// POST /api/sales/:id/cancel -- cancels an entire DRAFT invoice. The
// document is kept (never deleted) so the audit trail is preserved; only
// its reservation and pending payment are released.
export const cancelSale = asyncHandler(async (req, res) => {
  const { reason = '' } = req.body;

  const result = await runInTransaction(async (session) => {
    const sale = await Sale.findById(req.params.id).session(session);
    if (!sale) throw new ApiError(404, 'Sale not found.');
    assertNotLocked(sale, req.user);
    if (sale.status !== 'DRAFT') {
      throw new ApiError(409, 'Only pending (Draft) invoices can be cancelled directly. Use a return/reversal for a confirmed sale.');
    }

    for (const line of sale.items) {
      await releaseReservation(line.item, line.quantity, session, line.batchReservations);
    }
    if (sale.accountTransaction) {
      await reverseTransaction(sale.accountTransaction, session);
    }
    if (sale.walletAmountCents > 0) {
      const customer = await Customer.findById(sale.customer).session(session);
      if (customer) {
        await restoreWallet(customer, sale.walletAmountCents, sale, session, req.user);
        // The returned credit pays any debt the customer already owes.
        await applyWalletToDebt(customer, session, req.user);
      }
    }

    sale.status = 'CANCELLED';
    sale.cancelledAt = new Date();
    sale.cancelledReason = reason;
    await sale.save({ session });
    return sale;
  });

  await logAudit({
    user: req.user,
    action: 'sale.cancel_draft',
    entityType: 'Sale',
    entityId: result._id,
    details: { reason },
  });

  res.json({ success: true, data: toDTO(result) });
});

// GET /api/sales/refunds?from&to&refundTo -- every cancelled invoice whose
// money was given back: to the customer's wallet or as cash out of an account
// (with the number it was sent to), newest first, with totals.
export const listRefunds = asyncHandler(async (req, res) => {
  const filter = { status: 'CANCELLED', 'cancelRefund.amountCents': { $gt: 0 } };
  if (req.query.from || req.query.to) {
    filter.cancelledAt = {};
    if (req.query.from) filter.cancelledAt.$gte = new Date(String(req.query.from).slice(0, 10) + 'T00:00:00');
    if (req.query.to) filter.cancelledAt.$lte = new Date(String(req.query.to).slice(0, 10) + 'T23:59:59.999');
  }
  if (['WALLET', 'ACCOUNT'].includes(req.query.refundTo)) filter['cancelRefund.to'] = req.query.refundTo;
  const sales = await Sale.find(filter).sort({ cancelledAt: -1 }).limit(1000).lean();
  const rows = sales.map((s) => ({
    id: s._id,
    branch: s.branch || null,
    receiptNumber: s.receiptNumber,
    customer: s.customer || null,
    customerName: s.customerName || 'Walk-in',
    invoiceDate: s.createdAt,
    cancelledAt: s.cancelledAt,
    reason: s.cancelledReason || '',
    total: fromCents(s.totalCents),
    amount: fromCents(s.cancelRefund.amountCents),
    to: s.cancelRefund.to,
    accountName: s.cancelRefund.accountName || '',
    reference: s.cancelRefund.reference || '',
    byName: s.cancelRefund.byName || '',
  }));
  const sum = (to) => fromCents(sales.filter((s) => !to || s.cancelRefund.to === to).reduce((t, s) => t + s.cancelRefund.amountCents, 0));
  res.json({
    success: true,
    data: { rows, totals: { count: rows.length, amount: sum(), wallet: sum('WALLET'), cash: sum('ACCOUNT') } },
  });
});

// GET /api/sales/drafts/today -- convenient Seller access to today's pending invoices
export const listTodayDrafts = asyncHandler(async (req, res) => {
  const { start, end } = resolveDateRange({ range: 'today' });
  const drafts = await Sale.find({ status: 'DRAFT', createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 });
  res.json({ success: true, data: drafts.map(toDTO) });
});

export const listSales = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, from, to, range, customer, status } = req.query;
  const filter = {};
  if (customer) filter.customer = customer;
  if (status) filter.status = status;
  const literal = value => String(value).slice(0, 150).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (req.query.id) filter.receiptNumber = new RegExp(literal(req.query.id), 'i');
  const nameFilters = [req.query.title, req.query.customerName].filter(Boolean);
  // Customer names match from the start ("C" finds Cali, not Abdi Cali).
  if (nameFilters.length) filter.$and = nameFilters.map(value => ({ customerName: new RegExp(`^\\s*${literal(value)}`, 'i') }));
  if (range || from || to) {
    const { start, end } = resolveDateRange({ range, from, to });
    filter.createdAt = { $gte: start, $lte: end };
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 20));

  const [items, total] = await Promise.all([
    Sale.find(filter)
      .sort({ [req.query.sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt']: req.query.sortDir === 'asc' ? 1 : -1, _id: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Sale.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: items.map(toDTO),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

export const getSale = asyncHandler(async (req, res) => {
  const sale = await Sale.findById(req.params.id).populate('customer', 'name phone').populate('paymentAccount', 'name');
  if (!sale) throw new ApiError(404, 'Sale not found.');
  res.json({ success: true, data: { ...toDTO(sale), customerPhone: sale.customer?.phone || '', paymentAccountName: sale.paymentAccount?.name || '' } });
});

// GET /api/sales/:id/receipt -- data shaped for the printable A5 invoice
export const getReceipt = asyncHandler(async (req, res) => {
  const sale = await Sale.findById(req.params.id).populate('customer', 'name phone').populate('paymentAccount', 'name');
  if (!sale) throw new ApiError(404, 'Sale not found.');
  res.json({
    success: true,
    data: {
      ...toDTO(sale),
      customerPhone: sale.customer?.phone || '',
      paymentAccountName: sale.paymentAccount?.name || '',
    },
  });
});

// POST /api/sales/:id/reverse -- for a CONFIRMED sale only (admin/manager).
// This is the authorized "return/reversal" path Close-Day-confirmed history
// requires instead of ever silently rewriting it: it reopens stock/lots,
// reverses the customer ledger, and posts an OUT account transaction if a
// payment had already been posted for this sale.
export const reverseSale = asyncHandler(async (req, res) => {
  const { reason = '' } = req.body;
  const reference = String(req.body.reference || '').trim().slice(0, 100); // number the money was sent back to

  const result = await runInTransaction(async (session) => {
    const sale = await Sale.findById(req.params.id).session(session);
    if (!sale) throw new ApiError(404, 'Sale not found.');
    assertNotLocked(sale, req.user);
    if (sale.status === 'DRAFT') throw new ApiError(409, 'This is still a Draft invoice -- cancel it instead of reversing it.');
    if (sale.status === 'CANCELLED') throw new ApiError(409, 'This sale has already been cancelled/reversed.');
    // Money already received for this invoice: at the sale (paidAmount) and
    // by debt payments made on it later (the part of its credit no longer
    // outstanding). All of it goes to one place: the customer's wallet, or
    // (refundTo: 'ACCOUNT') cash handed back out of the chosen account --
    // accountId, defaulting to the one the sale was paid into -- with the
    // number it was sent to. A walk-in sale (no customer) can only be refunded.
    const paidLaterCents = Math.max(0, sale.balanceAddedCents - sale.outstandingCents);
    const paidBackCents = sale.paidAmountCents + paidLaterCents;
    const refundTo = !sale.customer ? 'ACCOUNT' : req.body.refundTo === 'ACCOUNT' ? 'ACCOUNT' : 'WALLET';
    let refundAccount = null;
    if (refundTo === 'ACCOUNT' && paidBackCents > 0) {
      const accountId = req.body.accountId || sale.paymentAccount;
      refundAccount = accountId ? await Account.findById(accountId).session(session) : null;
      if (!refundAccount || !refundAccount.isActive) throw new ApiError(400, 'Choose the account the money is given back from.');
    }

    // Only the portion not already restored by a prior partial return (see
    // returnSale) is restored here -- lotConsumption entries are decremented
    // as returns consume them, so this always reflects what remains. This is
    // an incoming inventory movement at the line's own historical WAC
    // snapshot (never today's cost), blended into whatever the item's
    // average cost is right now -- same treatment as a partial return.
    for (const line of sale.items) {
      const stillConsumed = line.quantity - (line.returnedQuantity || 0);
      if (stillConsumed <= 0) continue;
      const itemDoc = await InventoryItem.findById(line.item).session(session);
      if (!itemDoc) continue; // item deleted: nothing to put back
      const oldQuantity = itemDoc.quantity;
      const oldAverageCostCents = itemDoc.costPriceCents;
      const newAverageCostCents = calculateWeightedAverageCost({
        oldQuantity,
        oldAverageCostCents,
        incomingQuantity: stillConsumed,
        incomingUnitCostCents: line.costPriceCents,
      });
      itemDoc.stockEvents.push({
        type: 'SALE_REVERSAL',
        reference: sale.receiptNumber,
        quantityBefore: oldQuantity,
        quantityAfter: oldQuantity + stillConsumed,
        averageCostBeforeCents: oldAverageCostCents,
        averageCostAfterCents: newAverageCostCents,
      });
      await bookStockValueGap(session, itemDoc, { oldQuantity, oldCostCents: oldAverageCostCents, newQuantity: oldQuantity + stillConsumed, newCostCents: newAverageCostCents, incomingQuantity: stillConsumed, incomingUnitCostCents: line.costPriceCents }, { reason: `${sale.receiptNumber} cancelled: units sold ahead of stock`, user: req.user });
      itemDoc.quantity = oldQuantity + stillConsumed;
      itemDoc.costPriceCents = newAverageCostCents;
      await itemDoc.save({ session });
      await restoreLotConsumption(line.lotConsumption, session);
    }

    const customer = await Customer.findById(sale.customer).session(session);
    if (customer) {
      // Only what is still owed on this invoice comes off the balance; what
      // was paid on it is handled as money (wallet or refund) below.
      const previousBalanceCents = customer.balanceCents;
      customer.balanceCents -= sale.outstandingCents;
      customer.totalPurchasedCents -= sale.totalCents;
      customer.totalPaidCents = Math.max(0, customer.totalPaidCents - sale.paidAmountCents - paidLaterCents);
      await customer.save({ session });

      if (sale.outstandingCents > 0) {
        await CustomerLedger.create(
          [
            {
              customer: customer._id,
              type: 'SALE_VOID',
              amountCents: -sale.outstandingCents,
              sale: sale._id,
              description: `Reversed sale ${sale.receiptNumber}${reason ? ` (${reason})` : ''}`,
              balanceBeforeCents: previousBalanceCents,
              balanceAfterCents: customer.balanceCents,
              createdBy: req.user?._id,
            },
          ],
          { session }
        );
      }
    }

    const toWalletCents = customer && refundTo === 'WALLET' ? paidBackCents : 0;
    if (toWalletCents > 0) {
      const walletBefore = customer.walletBalanceCents;
      customer.walletBalanceCents += toWalletCents;
      await customer.save({ session });
      await CustomerWalletTransaction.create(
        [
          {
            customer: customer._id,
            type: 'REFUND',
            amountCents: toWalletCents,
            sale: sale._id,
            note: `Invoice ${sale.receiptNumber} cancelled -- money paid on it moved to the wallet${reason ? `: ${reason}` : ''}`,
            balanceBeforeCents: walletBefore,
            balanceAfterCents: customer.walletBalanceCents,
            createdBy: req.user?._id,
          },
        ],
        { session }
      );
    }

    // The payments were already POSTED -- the refund leaves the chosen
    // account as its own transaction rather than deleting that history.
    if (refundAccount) {
      await postImmediateTransaction(
        {
          account: refundAccount,
          direction: 'OUT',
          type: 'REFUND',
          amountCents: paidBackCents,
          referenceType: 'Sale',
          referenceId: sale._id,
          description: `Refund for cancelled invoice ${sale.receiptNumber}${sale.customerName ? ` — ${sale.customerName}` : ''}${reference ? ` (sent to ${reference})` : ''}${reason ? ` (${reason})` : ''}`,
          createdBy: req.user,
        },
        session
      );
    }
    if (paidBackCents > 0) {
      sale.cancelRefund = {
        to: refundTo,
        amountCents: paidBackCents,
        account: refundAccount?._id || null,
        accountName: refundAccount?.name || '',
        reference: refundTo === 'ACCOUNT' ? reference : '',
        by: req.user?._id || null,
        byName: req.user?.name || '',
      };
    }

    // The sale is being fully undone -- give back whatever wallet credit it
    // consumed, exactly as a Draft cancellation already does.
    if (sale.walletAmountCents > 0 && customer) {
      await restoreWallet(customer, sale.walletAmountCents, sale, session, req.user);
    }

    sale.status = 'CANCELLED';
    sale.cancelledAt = new Date();
    sale.cancelledReason = reason || 'Reversed after confirmation';
    sale.outstandingCents = 0;
    await sale.save({ session });

    // Wallet credit given back above pays any other debt the customer owes
    // when they pay debt from the wallet automatically (run after this sale
    // is CANCELLED so it is never paid itself).
    if ((sale.walletAmountCents > 0 || toWalletCents > 0) && customer) await applyWalletToDebt(customer, session, req.user);

    return sale;
  });

  await logAudit({
    user: req.user,
    action: 'sale.reverse',
    entityType: 'Sale',
    entityId: result._id,
    details: { reason, refundTo: result.cancelRefund?.to || 'WALLET', amount: fromCents(result.cancelRefund?.amountCents || 0), account: result.cancelRefund?.accountName || '', reference: result.cancelRefund?.reference || '' },
  });

  res.json({ success: true, data: toDTO(result) });
});

// POST /api/sales/:id/return -- partial return for a CONFIRMED sale
// (admin/manager). Unlike reverseSale (which voids the whole invoice), this
// returns a chosen quantity of specific lines: it restores stock into the
// exact lots those units were consumed from (preserving batch traceability
// and historical cost -- never today's cost), reduces this invoice's
// subtotal/discount/total by the returned value, and reconciles the
// difference by first relieving this invoice's still-unpaid balance, then
// giving back what was already paid -- at the sale or by debt payments later:
// wallet credit back to the wallet, the rest to the customer's wallet
// (refundTo: 'WALLET') or as cash out of an account (refundTo: 'ACCOUNT',
// accountId -- default the account the sale was paid into -- and the number
// it was sent to).
export const returnSale = asyncHandler(async (req, res) => {
  const { items: returnItems, reason = '' } = req.body;
  const reference = String(req.body.reference || '').trim().slice(0, 100);
  if (!Array.isArray(returnItems) || !returnItems.length) throw new ApiError(400, 'Select at least one item to return.');

  const result = await runInTransaction(async (session) => {
    const sale = await Sale.findById(req.params.id).session(session);
    if (!sale) throw new ApiError(404, 'Sale not found.');
    if (sale.status !== 'CONFIRMED') throw new ApiError(409, 'Only confirmed invoices can have items returned. Cancel a Draft instead.');

    const indexByItem = new Map(sale.items.map((line, index) => [String(line.item), index]));
    const seen = new Set();
    let deltaSubtotalCents = 0;
    let deltaCogsCents = 0;
    const returnedLines = [];
    for (const line0 of returnItems) {
      const index = indexByItem.get(String(line0.itemId));
      if (index === undefined || seen.has(index)) throw new ApiError(400, 'Select valid, distinct items from this invoice.');
      seen.add(index);
      const line = sale.items[index];
      const qty = Math.round(Number(line0.quantity));
      if (!Number.isSafeInteger(qty) || qty <= 0) throw new ApiError(400, `Return quantity for "${line.itemName}" must be a positive whole number.`);
      const returnable = line.quantity - (line.returnedQuantity || 0);
      if (qty > returnable) throw new ApiError(409, `Cannot return ${qty} of "${line.itemName}": only ${returnable} remain returnable.`);
      deltaSubtotalCents += qty * line.unitPriceCents;
      deltaCogsCents += qty * line.costPriceCents;
      returnedLines.push({ index, qty, line });
    }

    const newSubtotalCents = sale.subtotalCents - deltaSubtotalCents;
    const newDiscountCents = Math.min(sale.discountCents, newSubtotalCents);
    const newTotalCents = newSubtotalCents - newDiscountCents;
    const deltaCents = sale.totalCents - newTotalCents;
    const reduceFromOutstanding = Math.min(deltaCents, sale.outstandingCents);
    // The already-paid portion goes back the way it was paid: wallet credit
    // first (back into the wallet), then cash out of the payment account.
    const paidBackCents = deltaCents - reduceFromOutstanding;
    const walletRefundCents = Math.min(paidBackCents, sale.walletAmountCents || 0);
    const refundCents = paidBackCents - walletRefundCents;

    // Paid at the sale first, then what debt payments paid on it later.
    const refundFromSaleCents = Math.min(refundCents, sale.paidAmountCents);
    const refundFromLaterCents = refundCents - refundFromSaleCents;
    // Where that money goes. A walk-in sale has no wallet: cash only.
    const wanted = req.body.refundTo === 'WALLET' || req.body.refundTo === 'ACCOUNT' ? req.body.refundTo : null;
    const refundTo = refundCents <= 0 ? '' : !sale.customer ? 'ACCOUNT' : wanted || (sale.paymentAccount ? 'ACCOUNT' : 'WALLET');
    // Validated before any lot/stock mutation.
    let account = null;
    if (refundTo === 'ACCOUNT') {
      const accountId = req.body.accountId || sale.paymentAccount;
      account = accountId ? await Account.findById(accountId).session(session) : null;
      if (!account || !account.isActive) throw new ApiError(400, 'Choose the account the money is given back from.');
    }

    // Restore stock into the exact lots each line consumed, most-recently
    // consumed lot first, so batch cost/traceability is never fabricated.
    // Each lotConsumption entry's quantity is decremented as it is restored
    // (rather than left untouched), so a later full reverseSale on this same
    // invoice only restores what these returns have not already restored.
    //
    // Costing: a customer return is an incoming inventory movement at the
    // HISTORICAL cost snapshot assigned when those units were originally
    // sold (line.costPriceCents) -- never today's selling price and never
    // blindly today's WAC. It is blended into the item's current average
    // exactly like a Stock IN receipt (same zero-stock rule applies if the
    // item has since sold out completely).
    for (const { index, qty, line } of returnedLines) {
      // Units sold ahead of stock came from no batch: returning them first
      // only makes up the shortfall; the rest go back to their batches.
      const stillOut = line.quantity - (line.returnedQuantity || 0);
      const fromBatches = line.lotConsumption.reduce((s, e) => s + e.quantity, 0);
      let remaining = qty - Math.min(qty, Math.max(0, stillOut - fromBatches));
      for (let i = line.lotConsumption.length - 1; i >= 0 && remaining > 0; i--) {
        const entry = line.lotConsumption[i];
        if (entry.quantity <= 0) continue;
        const take = Math.min(entry.quantity, remaining);
        await InventoryLot.findByIdAndUpdate(entry.lot, { $inc: { remainingQuantity: take } }, { session });
        entry.quantity -= take;
        remaining -= take;
      }
      const itemDoc = await InventoryItem.findById(line.item).session(session);
      if (!itemDoc) {
        // Item deleted: the money side of the return still happens.
        sale.items[index].returnedQuantity = (line.returnedQuantity || 0) + qty;
        continue;
      }
      const oldQuantity = itemDoc.quantity;
      const oldAverageCostCents = itemDoc.costPriceCents;
      const newAverageCostCents = calculateWeightedAverageCost({
        oldQuantity,
        oldAverageCostCents,
        incomingQuantity: qty,
        incomingUnitCostCents: line.costPriceCents,
      });
      itemDoc.stockEvents.push({
        type: 'CUSTOMER_RETURN',
        reference: sale.receiptNumber,
        quantityBefore: oldQuantity,
        quantityAfter: oldQuantity + qty,
        averageCostBeforeCents: oldAverageCostCents,
        averageCostAfterCents: newAverageCostCents,
      });
      await bookStockValueGap(session, itemDoc, { oldQuantity, oldCostCents: oldAverageCostCents, newQuantity: oldQuantity + qty, newCostCents: newAverageCostCents, incomingQuantity: qty, incomingUnitCostCents: line.costPriceCents }, { reason: `${sale.receiptNumber} returned: units sold ahead of stock`, user: req.user });
      itemDoc.quantity = oldQuantity + qty;
      itemDoc.costPriceCents = newAverageCostCents;
      await itemDoc.save({ session });
      sale.items[index].returnedQuantity = (line.returnedQuantity || 0) + qty;
    }

    sale.subtotalCents = newSubtotalCents;
    sale.discountCents = newDiscountCents;
    sale.totalCents = newTotalCents;
    sale.costOfGoodsCents -= deltaCogsCents;
    sale.profitCents = sale.totalCents - sale.costOfGoodsCents;
    sale.balanceAddedCents -= reduceFromOutstanding + refundFromLaterCents;
    sale.outstandingCents -= reduceFromOutstanding;
    sale.paidAmountCents -= refundFromSaleCents;
    sale.walletAmountCents -= walletRefundCents;

    // Resolved before the return entry is pushed so the Return Receipt can
    // show the balances exactly as they stood right after this return, even
    // if the invoice/customer changes again later.
    const customer = await Customer.findById(sale.customer).session(session);
    const customerBalanceAfterCents = customer ? customer.balanceCents - reduceFromOutstanding : null;

    sale.returns.push({
      items: returnedLines.map(({ qty, line }) => ({ item: line.item, itemName: line.itemName, quantity: qty, unitPriceCents: line.unitPriceCents })),
      amountCents: deltaCents,
      debtReducedCents: reduceFromOutstanding,
      refundCents,
      walletRefundCents,
      refundTo,
      refundAccountName: account?.name || '',
      refundReference: refundTo === 'ACCOUNT' ? reference : '',
      reason,
      invoiceBalanceAfterCents: sale.outstandingCents,
      customerBalanceAfterCents,
      createdBy: req.user?._id,
    });
    await sale.save({ session });

    if (customer) {
      const previousBalanceCents = customer.balanceCents;
      customer.balanceCents -= reduceFromOutstanding;
      customer.totalPurchasedCents -= deltaCents;
      customer.totalPaidCents -= refundCents;
      await customer.save({ session });

      if (reduceFromOutstanding > 0) {
        await CustomerLedger.create(
          [
            {
              customer: customer._id,
              type: 'SALE_RETURN',
              amountCents: -reduceFromOutstanding,
              sale: sale._id,
              description: `Return on sale ${sale.receiptNumber}${reason ? ` (${reason})` : ''}`,
              balanceBeforeCents: previousBalanceCents,
              balanceAfterCents: previousBalanceCents - reduceFromOutstanding,
              createdBy: req.user?._id,
            },
          ],
          { session }
        );
      }

      // Paid money handed back to the wallet instead of as cash.
      if (refundTo === 'WALLET' && refundCents > 0) {
        const walletBefore = customer.walletBalanceCents;
        customer.walletBalanceCents += refundCents;
        await customer.save({ session });
        await CustomerWalletTransaction.create(
          [
            {
              customer: customer._id,
              type: 'REFUND',
              amountCents: refundCents,
              sale: sale._id,
              note: `Items returned on ${sale.receiptNumber} -- money paid for them moved to the wallet${reason ? `: ${reason}` : ''}`,
              balanceBeforeCents: walletBefore,
              balanceAfterCents: customer.walletBalanceCents,
              createdBy: req.user?._id,
            },
          ],
          { session }
        );
      }

      if (walletRefundCents > 0 || (refundTo === 'WALLET' && refundCents > 0)) {
        if (walletRefundCents > 0) await restoreWallet(customer, walletRefundCents, sale, session, req.user);
        // Credit given back to the wallet pays any other debt the customer owes.
        await applyWalletToDebt(customer, session, req.user);
      }
    }

    if (refundTo === 'ACCOUNT' && account && refundCents > 0) {
      await postImmediateTransaction(
        {
          account,
          direction: 'OUT',
          type: 'REFUND',
          amountCents: refundCents,
          referenceType: 'Sale',
          referenceId: sale._id,
          description: `Refund for return on sale ${sale.receiptNumber}${sale.customerName ? ` — ${sale.customerName}` : ''}${reference ? ` (sent to ${reference})` : ''}${reason ? ` (${reason})` : ''}`,
          createdBy: req.user,
        },
        session
      );
    }

    return sale;
  });

  await logAudit({
    user: req.user,
    action: 'sale.return_items',
    entityType: 'Sale',
    entityId: result._id,
    details: { reason },
  });

  res.json({ success: true, data: toDTO(result) });
});

export { toDTO as saleToDTO };

// POST /api/sales/:id/transfer { customerId, reason } -- an invoice put on the
// wrong customer moves to the right one, with all its money:
// - what it still owes comes off the first customer's debt and goes onto the
//   other's, with its purchase and paid totals (net of any returns);
// - payments made on it (at the sale or later, cash or account) move with it
//   -- a later payment that also paid other invoices is split, and only this
//   invoice's part moves;
// - wallet money used on it belonged to the first customer: it goes back to
//   their wallet, and the right customer owes that part instead.
// Both customers' histories record the move.
export const transferSale = asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!reason) throw new ApiError(400, 'Say why the invoice is being moved.');
  const result = await runInTransaction(async (session) => {
    const sale = await Sale.findById(req.params.id).session(session);
    if (!sale) throw new ApiError(404, 'Invoice not found.');
    if (sale.status === 'CANCELLED') throw new ApiError(409, 'A cancelled invoice cannot be moved.');
    if (String(sale.customer) === String(req.body.customerId)) throw new ApiError(400, 'The invoice is already on this customer.');
    const [from, to] = await Promise.all([Customer.findById(sale.customer).session(session), Customer.findById(req.body.customerId).session(session)]);
    if (!to || to.archivedAt) throw new ApiError(404, 'Choose an active customer the invoice belongs to.');
    const fromName = sale.customerName;
    let walletBackCents = 0;

    // A Draft: its wallet money goes back; nothing else is posted yet.
    if (sale.status === 'DRAFT') {
      if (sale.walletAmountCents > 0 && from) await restoreWallet(from, sale.walletAmountCents, sale, session, req.user);
      walletBackCents = sale.walletAmountCents;
      sale.walletAmountCents = 0;
    }

    if (sale.status === 'CONFIRMED') {
      const ownedBefore = sale.outstandingCents;
      // Later payments on this invoice.
      const payments = await Payment.find({ type: 'debt_payment', status: { $ne: 'CANCELLED' }, 'allocations.sale': sale._id }).session(session);
      for (const p of payments) {
        const mine = p.allocations.filter((a) => String(a.sale) === String(sale._id));
        const partCents = mine.reduce((s, a) => s + a.amountCents, 0);
        if (partCents <= 0) continue;
        if (!p.paymentAccount) {
          // Paid from the first customer's wallet: back to it; owed again.
          walletBackCents += partCents;
          p.allocations = p.allocations.filter((a) => String(a.sale) !== String(sale._id));
          p.amountCents -= partCents;
          if (p.amountCents <= 0) { p.status = 'CANCELLED'; p.cancelledAt = new Date(); p.cancelReason = `Invoice ${sale.receiptNumber} moved to ${to.name}`; p.refundedTo = 'WALLET'; }
          await p.save({ session });
          continue;
        }
        if (mine.length === p.allocations.length) {
          p.customer = to._id;
          await p.save({ session });
        } else {
          // Split: this invoice's part becomes the right customer's payment.
          p.allocations = p.allocations.filter((a) => String(a.sale) !== String(sale._id));
          p.amountCents -= partCents;
          await p.save({ session });
          let number = `${p.receiptNumber}-M`;
          for (let n = 2; await Payment.exists({ receiptNumber: number }).session(session); n += 1) number = `${p.receiptNumber}-M${n}`;
          await Payment.create([{ receiptNumber: number, customer: to._id, amountCents: partCents, type: 'debt_payment', paymentAccount: p.paymentAccount, paymentAccountName: p.paymentAccountName, allocations: mine.map((a) => ({ sale: a.sale, receiptNumber: a.receiptNumber, amountCents: a.amountCents })), previousBalanceCents: 0, newBalanceCents: 0, notes: `Part of ${p.receiptNumber} that paid ${sale.receiptNumber}, moved with it`, createdAt: p.createdAt, createdBy: req.user?._id }], { session });
        }
      }
      // Wallet money used at the sale.
      walletBackCents += sale.walletAmountCents;
      if (walletBackCents > 0 && from) {
        const before = from.walletBalanceCents;
        from.walletBalanceCents += walletBackCents;
        await CustomerWalletTransaction.create([{ customer: from._id, type: 'REFUND', amountCents: walletBackCents, sale: sale._id, note: `Invoice ${sale.receiptNumber} moved to ${to.name}: wallet money used on it given back`, balanceBeforeCents: before, balanceAfterCents: from.walletBalanceCents, createdBy: req.user?._id }], { session });
      }
      sale.walletAmountCents = 0;
      sale.outstandingCents += walletBackCents;

      const netPurchasedCents = Math.max(0, sale.totalCents - (sale.returns || []).reduce((s, r) => s + (r.amountCents || 0), 0));
      const owedCents = sale.outstandingCents;
      const paidCents = Math.max(0, netPurchasedCents - owedCents);
      const note = (dir, other) => `Invoice ${sale.receiptNumber} moved ${dir} ${other} -- ${reason}`;
      if (from) {
        const before = from.balanceCents;
        from.balanceCents -= ownedBefore;
        from.totalPurchasedCents = Math.max(0, from.totalPurchasedCents - netPurchasedCents);
        from.totalPaidCents = Math.max(0, from.totalPaidCents - Math.max(0, paidCents - walletBackCents));
        await from.save({ session });
        await CustomerLedger.create([{ customer: from._id, type: 'ADJUSTMENT', amountCents: -ownedBefore, sale: sale._id, description: note('to', to.name), balanceBeforeCents: before, balanceAfterCents: from.balanceCents, createdBy: req.user?._id }], { session });
      }
      const before = to.balanceCents;
      to.balanceCents += owedCents;
      to.totalPurchasedCents += netPurchasedCents;
      to.totalPaidCents += paidCents;
      await to.save({ session });
      await CustomerLedger.create([{ customer: to._id, type: 'ADJUSTMENT', amountCents: owedCents, sale: sale._id, description: note('from', fromName), balanceBeforeCents: before, balanceAfterCents: to.balanceCents, createdBy: req.user?._id }], { session });
      // The payment taken at the sale belongs to the invoice.
      await Payment.updateMany({ type: 'sale', relatedSale: sale._id }, { $set: { customer: to._id } }, { session });
    }
    sale.customer = to._id;
    sale.customerName = to.name;
    await sale.save({ session });
    // The cashier who took the money sees the invoice was put on the right customer.
    // Every line of money in on this invoice gets the note (also where it
    // was moved to after a wrong account), added to any earlier correction.
    const note = `Wrong customer corrected: ${fromName} → ${to.name}`;
    await AccountTransaction.updateMany(
      { referenceType: 'Sale', referenceId: sale._id, direction: 'IN', status: { $ne: 'REVERSED' } },
      [{ $set: { correctionNote: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$correctionNote', ''] } }, 0] }, { $concat: ['$correctionNote', ' · ', note] }, note] }, correctedByName: whoLabel(req.user) } }],
      { session }
    );
    return { sale, fromName, to, walletBackCents };
  });
  await logAudit({ user: req.user, action: 'sale.transfer', entityType: 'Sale', entityId: result.sale._id, details: { receiptNumber: result.sale.receiptNumber, from: result.fromName, to: result.to.name, reason, walletGivenBack: fromCents(result.walletBackCents) } });
  res.json({ success: true, data: { id: result.sale._id, receiptNumber: result.sale.receiptNumber, from: result.fromName, to: result.to.name, customerId: result.to._id, walletGivenBack: fromCents(result.walletBackCents) } });
});
