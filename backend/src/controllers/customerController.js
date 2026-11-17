import mongoose from 'mongoose';
import { userHas } from '../models/User.js';
import Customer from '../models/Customer.js';
import Account from '../models/Account.js';
import { createHash } from 'node:crypto';
import { postImmediateTransaction } from '../services/accountService.js';
import Sale from '../models/Sale.js';
import Payment from '../models/Payment.js';
import CustomerLedger from '../models/CustomerLedger.js';
import CustomerWalletTransaction from '../models/CustomerWalletTransaction.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toCents, fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';
import { applyWalletToDebt, outstandingDebt, allocateDebt, OPENING_DEBT } from '../services/walletService.js';
import { logAudit } from '../services/auditService.js';
import { getCustomerItems } from '../services/customerItemsService.js';
import { escapeRegex, NAME_ORDER, startsWith } from '../utils/regex.js';

function toDTO(c) {
  return {
    id: c._id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    address: c.address,
    notes: c.notes,
    openingBalance: fromCents(c.openingBalanceCents || 0),
    balance: fromCents(c.balanceCents),
    walletBalance: fromCents(c.walletBalanceCents),
    creditLimit: c.creditLimitCents == null ? null : fromCents(c.creditLimitCents),
    walletAutoPay: !!c.walletAutoPay,
    totalPurchased: fromCents(c.totalPurchasedCents),
    totalPaid: fromCents(c.totalPaidCents),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function generatePaymentReceiptNumber(session) {
  const seq = await nextSequence('payment', session);
  const year = new Date().getFullYear();
  return `PAY-${year}-${String(seq).padStart(6, '0')}`;
}

// GET /api/customers?search=&page=&limit=
export const listCustomers = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const search = String(req.query.search ?? '').trim();
  const filter = { archivedAt: null };
  if (search) {
    const norm = escapeRegex(Customer.normalize(search));
    filter.$or = [
      { normalizedName: startsWith(norm) },
      { phone: { $regex: escapeRegex(search), $options: 'i' } },
    ];
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));

  // A to Z, upper and lower case alike.
  const [items, total] = await Promise.all([
    Customer.find(filter)
      .collation(NAME_ORDER)
      .sort({ name: 1, _id: 1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Customer.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: items.map(toDTO),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
});

// GET /api/customers/search?q=Ahmed  -- fast lightweight search used by POS
export const searchCustomers = asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ success: true, data: [] });

  const norm = escapeRegex(Customer.normalize(q));
  const customers = await Customer.find({
    archivedAt: null,
    $or: [{ normalizedName: startsWith(norm) }, { phone: { $regex: escapeRegex(q), $options: 'i' } }],
  })
    // Every match, A to Z -- not the first few.
    .collation(NAME_ORDER)
    .sort({ name: 1 });

  res.json({ success: true, data: customers.map(toDTO) });
});

export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  res.json({ success: true, data: toDTO(customer) });
});

export const createCustomer = asyncHandler(async (req, res) => {
  // Plain text only: a number or a list sent by mistake is read as text, never
  // crashes the request.
  const text = (value) => String(value ?? '').trim();
  const name = text(req.body.name);
  if (!name) throw new ApiError(400, 'Customer name is required.');

  // What the customer owed before the system: 0 or more, a real amount (the
  // same rule as editing it later and as the customers sheet).
  const { openingBalance } = req.body;
  const opening = openingBalance === '' || openingBalance == null ? 0 : Number(openingBalance);
  if (!Number.isFinite(opening) || opening < 0 || !Number.isSafeInteger(toCents(opening))) {
    throw new ApiError(400, 'The opening balance must be 0 or more.');
  }

  const openingBalanceCents = toCents(opening);
  const customer = await Customer.create({
    name,
    phone: text(req.body.phone),
    email: text(req.body.email),
    address: text(req.body.address),
    notes: String(req.body.notes ?? ''),
    openingBalanceCents,
    balanceCents: openingBalanceCents,
  });

  if (openingBalanceCents > 0) {
    await CustomerLedger.create({
      customer: customer._id,
      type: 'ADJUSTMENT',
      amountCents: openingBalanceCents,
      description: 'Opening balance',
      balanceBeforeCents: 0,
      balanceAfterCents: openingBalanceCents,
      createdBy: req.user?._id,
    });
  }

  await logAudit({
    user: req.user,
    action: 'customer.create',
    entityType: 'Customer',
    entityId: customer._id,
    details: { name: customer.name },
  });

  res.status(201).json({ success: true, data: toDTO(customer) });
});

// GET /api/customers/sheet -- every customer as a sheet row (name, phone,
// opening balance), so the Customers sheet can show and edit them all at once.
export const getCustomersSheet = asyncHandler(async (req, res) => {
  const list = await Customer.find({ archivedAt: null }).collation(NAME_ORDER).sort({ name: 1 }).select('name phone openingBalanceCents balanceCents creditLimitCents').lean();
  res.json({ success: true, data: list.map((c) => ({ id: c._id, name: c.name, phone: c.phone || '', openingBalance: fromCents(c.openingBalanceCents || 0), creditLimit: c.creditLimitCents == null ? null : fromCents(c.creditLimitCents), owed: fromCents(c.balanceCents || 0) })) });
});

// Opening balance change for one customer inside the caller's transaction:
// the debt moves by the same amount and the ledger records it. It cannot go
// below what they have already paid off (their debt would turn negative).
async function setOpeningBalance(c, newCents, user, session) {
  const old = c.openingBalanceCents;
  const diff = newCents - old;
  if (!diff) return false;
  const after = c.balanceCents + diff;
  if (after < 0) throw new ApiError(400, `${c.name} has already paid more than that: the opening balance can be at least ${fromCents(old - c.balanceCents).toFixed(2)}.`);
  await new CustomerLedger({ customer: c._id, type: 'ADJUSTMENT', amountCents: diff, description: `Opening balance changed from ${fromCents(old).toFixed(2)} to ${fromCents(newCents).toFixed(2)}`, balanceBeforeCents: c.balanceCents, balanceAfterCents: after, createdBy: user?._id }).save({ session });
  c.openingBalanceCents = newCents;
  c.balanceCents = after;
  return true;
}

// The Customers sheet: new customers (no id) are added, existing ones (id)
// get the name, phone and opening balance typed in. All or nothing. Names
// must stay unique across the sheet and every other customer. A new row sent
// again because the answer to the first send was lost (same importKey) is
// skipped, so no one is added twice; sending an edit again changes nothing.
export const createCustomersBulk = asyncHandler(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new ApiError(400, 'Send between 1 and 500 customers at a time.');
  const clean = rows.map((r, i) => {
    const name = String(r?.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new ApiError(400, `Row ${i + 1}: enter the customer's name.`);
    if (name.length > 200) throw new ApiError(400, `Row ${i + 1}: the name is too long.`);
    const phone = String(r.phone || '').trim();
    if (phone.length > 50) throw new ApiError(400, `Row ${i + 1}: the phone number is too long.`);
    const opening = r.openingBalance === '' || r.openingBalance == null ? 0 : Number(r.openingBalance);
    if (!Number.isFinite(opening) || opening < 0 || !Number.isSafeInteger(toCents(opening))) throw new ApiError(400, `Row ${i + 1} (${name}): the opening balance must be 0 or more.`);
    if (r.key !== undefined && (typeof r.key !== 'string' || r.key.length > 64)) throw new ApiError(400, `Row ${i + 1}: invalid row key.`);
    if (r.id != null && !mongoose.isValidObjectId(r.id)) throw new ApiError(400, `Row ${i + 1}: invalid customer.`);
    // Credit limit: not sent = unchanged; blank = no limit; a number = the limit.
    let creditLimitCents;
    if (r.creditLimit !== undefined) {
      if (r.creditLimit === null || r.creditLimit === '') creditLimitCents = null;
      else {
        const n = Number(r.creditLimit);
        if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(toCents(n))) throw new ApiError(400, `Row ${i + 1} (${name}): the credit limit must be 0 or more.`);
        creditLimitCents = toCents(n);
      }
    }
    return { row: i + 1, id: r.id ? String(r.id) : null, key: r.key || null, name, normalized: Customer.normalize(name), phone, openingBalanceCents: toCents(opening), creditLimitCents };
  });

  const done = new Set(
    (await Customer.find({ importKey: { $in: clean.filter((c) => !c.id).map((c) => c.key).filter(Boolean) } }).select('importKey')).map((c) => c.importKey)
  );
  const fresh = clean.filter((c) => c.id || !c.key || !done.has(c.key));
  const edits = fresh.filter((c) => c.id);
  const adds = fresh.filter((c) => !c.id);
  if (adds.length && !userHas(req.user, 'createCustomers')) throw new ApiError(403, 'You do not have permission to add new customers.');
  const canSetLimits = userHas(req.user, 'creditLimits');

  const result = await runInTransaction(async (session) => {
    let updated = 0;
    const editing = new Set(edits.map((c) => c.id));
    const existing = new Map((await Customer.find({ _id: { $in: [...editing] } }).session(session)).map((c) => [String(c._id), c]));
    const renaming = edits.filter((c) => {
      const customer = existing.get(c.id);
      if (!customer) throw new ApiError(404, `Row ${c.row}: this customer no longer exists.`);
      return customer.normalizedName !== c.normalized;
    });
    const identityChanges = [...renaming, ...adds];
    const inSheet = new Map();
    for (const c of identityChanges) {
      if (inSheet.has(c.normalized)) throw new ApiError(400, `Rows ${inSheet.get(c.normalized)} and ${c.row} are both "${c.name}". Keep one.`);
      inSheet.set(c.normalized, c.row);
    }
    if (inSheet.size) {
      const changingIds = renaming.map((c) => c.id);
      const taken = await Customer.find({
        archivedAt: null,
        normalizedName: { $in: [...inSheet.keys()] },
        _id: { $nin: changingIds },
      }).select('name').session(session);
      if (taken.length) {
        const names = taken.slice(0, 5).map((t) => `"${t.name}"`).join(', ');
        throw new ApiError(409, `Already a customer: ${names}${taken.length > 5 ? ` and ${taken.length - 5} more` : ''}. Use a different name, or edit that customer's own row.`);
      }
    }
    for (const c of edits) {
      const customer = existing.get(c.id);
      const moneyChange = customer.openingBalanceCents !== c.openingBalanceCents;
      if (moneyChange && !userHas(req.user, 'changeOpeningDebt')) throw new ApiError(403, `Row ${c.row} (${customer.name}): changing an opening balance needs the "Change opening debt" permission.`);
      const limitChange = c.creditLimitCents !== undefined && (customer.creditLimitCents ?? null) !== c.creditLimitCents;
      // Like the credit limit window: admins only.
      if (limitChange && !canSetLimits) throw new ApiError(403, `Row ${c.row} (${customer.name}): setting credit limits needs the Credit limits permission.`);
      const changed = customer.name !== c.name || customer.phone !== c.phone || moneyChange || limitChange;
      if (!changed) continue;
      customer.name = c.name;
      customer.phone = c.phone;
      if (limitChange) customer.creditLimitCents = c.creditLimitCents;
      await setOpeningBalance(customer, c.openingBalanceCents, req.user, session);
      await customer.save({ session });
      updated += 1;
    }
    for (const c of adds) {
      const customer = await new Customer({ name: c.name, phone: c.phone, openingBalanceCents: c.openingBalanceCents, balanceCents: c.openingBalanceCents, importKey: c.key || undefined, ...(c.creditLimitCents != null && canSetLimits ? { creditLimitCents: c.creditLimitCents } : {}) }).save({ session });
      if (c.openingBalanceCents > 0) {
        await new CustomerLedger({ customer: customer._id, type: 'ADJUSTMENT', amountCents: c.openingBalanceCents, description: 'Opening balance', balanceBeforeCents: 0, balanceAfterCents: c.openingBalanceCents, createdBy: req.user?._id }).save({ session });
      }
    }
    return { updated };
  });

  if (fresh.length) await logAudit({ user: req.user, action: 'customer.bulk_save', entityType: 'Customer', details: { created: adds.length, updated: result.updated } });
  res.status(201).json({ success: true, data: { created: adds.length, updated: result.updated, skipped: clean.length - fresh.length } });
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');

  const { name, phone, email, address, notes } = req.body;
  const text = (value) => String(value ?? '').trim();
  if (name !== undefined) {
    if (!text(name)) throw new ApiError(400, 'Customer name cannot be empty.');
    customer.name = text(name);
  }
  if (phone !== undefined) customer.phone = text(phone);
  if (email !== undefined) customer.email = text(email);
  if (address !== undefined) customer.address = text(address);
  if (notes !== undefined) customer.notes = String(notes ?? '');

  await customer.save();

  await logAudit({
    user: req.user,
    action: 'customer.update',
    entityType: 'Customer',
    entityId: customer._id,
    details: req.body,
  });

  res.json({ success: true, data: toDTO(customer) });
});

// PUT /api/customers/:id/opening-balance { openingBalance } -- corrects what
// the customer owed before the system. The debt moves by the same amount and
// the change is written to the ledger, so the statement stays right. It can't
// go below what they have already paid off (their debt would turn negative).
export const updateCustomerOpeningBalance = asyncHandler(async (req, res) => {
  const raw = req.body.openingBalance;
  if (raw === '' || raw == null || !Number.isFinite(Number(raw)) || Number(raw) < 0) throw new ApiError(400, 'The opening balance must be 0 or more.');
  const newCents = toCents(raw);
  const { customer, oldCents } = await runInTransaction(async (session) => {
    const c = await Customer.findById(req.params.id).session(session);
    if (!c) throw new ApiError(404, 'Customer not found.');
    const old = c.openingBalanceCents;
    if (await setOpeningBalance(c, newCents, req.user, session)) await c.save({ session });
    return { customer: c, oldCents: old };
  });
  if (oldCents !== newCents) {
    await logAudit({ user: req.user, action: 'customer.opening_balance', entityType: 'Customer', entityId: customer._id, details: { from: fromCents(oldCents), to: fromCents(newCents) } });
  }
  res.json({ success: true, data: toDTO(customer) });
});

// GET /api/customers/credit-limits -- every customer's name, limit and debt
// for the Credit limits sheet.
export const getCreditLimitsSheet = asyncHandler(async (req, res) => {
  const list = await Customer.find({ archivedAt: null }).collation(NAME_ORDER).sort({ name: 1 }).select('name creditLimitCents balanceCents').lean();
  res.json({ success: true, data: list.map((c) => ({ id: c._id, name: c.name, creditLimit: c.creditLimitCents == null ? null : fromCents(c.creditLimitCents), owed: fromCents(c.balanceCents || 0) })) });
});

// POST /api/customers/credit-limits { rows: [{ id, creditLimit }] } -- the
// Credit limits sheet: many customers' limits in one save (null = no limit,
// 0 = nothing on credit). All or nothing. The Credit limits permission.
export const setCreditLimitsBulk = asyncHandler(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new ApiError(400, 'Send between 1 and 2000 customers at a time.');
  const clean = rows.map((r, i) => {
    if (!r || !mongoose.isValidObjectId(r.id)) throw new ApiError(400, `Row ${i + 1}: unknown customer.`);
    if (r.creditLimit === null || r.creditLimit === '' || r.creditLimit === undefined) return { id: String(r.id), cents: null, row: i + 1 };
    const n = Number(r.creditLimit);
    if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(toCents(n))) throw new ApiError(400, `Row ${i + 1}: the credit limit must be 0 or more.`);
    return { id: String(r.id), cents: toCents(n), row: i + 1 };
  });
  const updated = await runInTransaction(async (session) => {
    const found = new Map((await Customer.find({ _id: { $in: clean.map((c) => c.id) } }).session(session)).map((c) => [String(c._id), c]));
    let n = 0;
    for (const c of clean) {
      const customer = found.get(c.id);
      if (!customer) throw new ApiError(404, `Row ${c.row}: this customer no longer exists.`);
      if ((customer.creditLimitCents ?? null) === c.cents) continue;
      customer.creditLimitCents = c.cents;
      await customer.save({ session });
      n += 1;
    }
    return n;
  });
  await logAudit({ user: req.user, action: 'customer.credit_limits_bulk', entityType: 'Customer', details: { updated } });
  res.status(201).json({ success: true, data: { updated } });
});

// PUT /api/customers/:id/credit-limit { limit } -- admin only. limit null or
// '' removes it; 0 means nothing on credit at all.
export const setCreditLimit = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const raw = req.body.limit;
  let cents = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(toCents(n))) throw new ApiError(400, 'Enter a valid credit limit.');
    cents = toCents(n);
  }
  const before = customer.creditLimitCents;
  customer.creditLimitCents = cents;
  await customer.save();
  await logAudit({
    user: req.user,
    action: 'customer.credit_limit',
    entityType: 'Customer',
    entityId: customer._id,
    details: { before: before == null ? null : fromCents(before), after: cents == null ? null : fromCents(cents) },
  });
  res.json({ success: true, data: toDTO(customer) });
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  if (customer.archivedAt) throw new ApiError(404, 'Customer not found.');
  customer.archivedAt = new Date();
  await customer.save();

  await logAudit({
    user: req.user,
    action: 'customer.archive',
    entityType: 'Customer',
    entityId: customer._id,
    details: { name: customer.name, balance: fromCents(customer.balanceCents), walletBalance: fromCents(customer.walletBalanceCents) },
  });

  res.json({ success: true, data: { id: req.params.id, archivedAt: customer.archivedAt } });
});

// GET /api/customers/:id/history  -- full transaction history + ledger timeline
export const getCustomerHistory = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');

  const { from, to, status } = req.query;
  const filter = { customer: customer._id };
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  if (status) {
    if (!['DRAFT', 'CONFIRMED', 'CANCELLED'].includes(status)) throw new ApiError(400, 'Invalid invoice status filter.');
    filter.status = status;
  }

  const sales = await Sale.find(filter).sort({ createdAt: -1 });
  // Wallet credit used on confirmed invoices -- paid, but never counted in
  // Customer.totalPaidCents (that cash was received at deposit time).
  const [walletUsed] = await Sale.aggregate([{ $match: { customer: customer._id, status: 'CONFIRMED' } }, { $group: { _id: null, cents: { $sum: '$walletAmountCents' } } }]);
  const payments = await Payment.find({ customer: customer._id, type: { $ne: 'sale' } })
    .sort({ createdAt: -1 });
  const ledger = await CustomerLedger.find({ customer: customer._id }).sort({ createdAt: 1 });

  res.json({
    success: true,
    data: {
      customer: toDTO(customer),
      walletPaid: fromCents(walletUsed?.cents || 0),
      sales: sales.map((s) => ({
        editedByName: s.editedByName || '',
        lockedBySuperAdmin: !!s.lockedBySuperAdmin,
        lockedByAdmin: !!s.lockedByAdmin,
        id: s._id,
        receiptNumber: s.receiptNumber,
        status: s.status,
        items: s.items.map((i) => ({
          item: i.item,
          name: i.itemName,
          quantity: i.quantity,
          returnedQuantity: i.returnedQuantity || 0,
          unitPrice: fromCents(i.unitPriceCents),
          subtotal: fromCents(i.subtotalCents),
        })),
        subtotal: fromCents(s.subtotalCents),
        discount: fromCents(s.discountCents),
        total: fromCents(s.totalCents),
        paidAmount: fromCents(s.paidAmountCents),
        balanceAdded: fromCents(s.balanceAddedCents),
        outstanding: fromCents(s.outstandingCents),
        paymentAccount: s.paymentAccount,
        walletAmount: fromCents(s.walletAmountCents || 0),
        returnCount: s.returns?.length || 0,
        returns: (s.returns || []).map((r, index) => ({
          index,
          items: r.items.map((ri) => ({ name: ri.itemName, quantity: ri.quantity, unitPrice: fromCents(ri.unitPriceCents) })),
          amount: fromCents(r.amountCents),
          debtReduced: fromCents(r.debtReducedCents),
          refund: fromCents(r.refundCents),
          walletRefund: fromCents(r.walletRefundCents || 0),
          reason: r.reason,
          createdAt: r.createdAt,
        })),
        cancelledAt: s.cancelledAt,
        cancelledReason: s.cancelledReason,
        createdAt: s.createdAt,
      })),
      payments: payments.map((p) => ({
        id: p._id,
        receiptNumber: p.receiptNumber,
        amount: fromCents(p.amountCents),
        type: p.type,
        allocations: p.allocations.map((a) => ({ receiptNumber: a.receiptNumber, amount: fromCents(a.amountCents) })),
        notes: p.notes,
        paymentAccountName: p.paymentAccountName,
        status: p.status || 'POSTED',
        cancelledAt: p.cancelledAt,
        refundedTo: p.refundedTo,
        refundReference: p.refundReference || '',
        createdAt: p.createdAt,
      })),
      timeline: ledger.map((l) => ({
        id: l._id,
        type: l.type,
        amount: fromCents(l.amountCents),
        description: l.description,
        balanceBefore: fromCents(l.balanceBeforeCents),
        balanceAfter: fromCents(l.balanceAfterCents),
        sale: l.sale,
        payment: l.payment,
        createdAt: l.createdAt,
      })),
    },
  });
});

// GET /api/customers/:id/debt -- outstanding invoices this customer still owes on
export const getCustomerDebt = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');

  const { invoices, openingCents, totalCents: totalOutstandingCents } = await outstandingDebt(customer);

  res.json({
    success: true,
    data: {
      customer: toDTO(customer),
      totalOutstanding: fromCents(totalOutstandingCents),
      // The opening balance comes first, as a line of its own (id 'opening').
      invoices: [
        ...(openingCents > 0
          // Total is the opening balance as set (300), paid what has come off it (100).
          ? [{ id: 'opening', receiptNumber: OPENING_DEBT, total: fromCents(Math.max(openingCents, customer.openingBalanceCents || 0)), paidAtSale: fromCents(Math.max(0, (customer.openingBalanceCents || 0) - openingCents)), outstanding: fromCents(openingCents), createdAt: customer.createdAt }]
          : []),
        ...invoices.map((i) => ({
          id: i._id,
          receiptNumber: i.receiptNumber,
          total: fromCents(i.totalCents),
          paidAtSale: fromCents(i.paidAmountCents),
          outstanding: fromCents(i.outstandingCents),
          createdAt: i.createdAt,
        })),
      ],
    },
  });
});

// POST /api/customers/:id/payments  -- pay down debt, allocated to specific invoices
export const payCustomerDebt = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(toCents(amount)) || toCents(amount) <= 0) throw new ApiError(400, 'Please enter a valid payment amount.');
  const amountCents = toCents(amount);
  const requestedAllocations = Array.isArray(req.body.allocations) ? req.body.allocations : null;
  if (!req.body.paymentAccountId) throw new ApiError(400, 'Please select an account for this payment.');
  const requestKey = req.body.requestKey;
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !/^[\w-]{8,100}$/.test(requestKey))) throw new ApiError(400, 'Invalid payment request reference.');
  const requestFingerprint = createHash('sha256').update(JSON.stringify([req.params.id, amountCents, req.body.paymentAccountId, requestedAllocations, req.body.notes || ''])).digest('hex');

  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) throw new ApiError(404, 'Customer not found.');

    if (requestKey) {
      const existing = await Payment.findOne({ createdBy: req.user._id, requestKey }).session(session);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw new ApiError(409, 'This payment reference was already used with different details.');
        return { payment: existing, customer };
      }
    }
    const account = await Account.findById(req.body.paymentAccountId).session(session);
    if (!account?.isActive) throw new ApiError(400, 'Selected payment account is not available.');

    const debt = await outstandingDebt(customer, session);
    const { invoices: outstandingInvoices, totalCents: totalOutstandingCents } = debt;
    if (totalOutstandingCents <= 0) {
      throw new ApiError(409, 'This customer has no outstanding debt to pay.');
    }
    if (amountCents > totalOutstandingCents) {
      throw new ApiError(
        400,
        `Payment ($${amount.toFixed(2)}) exceeds the customer's total outstanding debt ($${fromCents(totalOutstandingCents).toFixed(2)}).`
      );
    }

    const allocations = [];
    let remaining = amountCents;

    if (requestedAllocations) {
      // Manual allocation: pay specific invoices by id.
      const bySaleId = new Map(outstandingInvoices.map((s) => [s._id.toString(), s]));
      let openingLeft = debt.openingCents;
      for (const a of requestedAllocations) {
        if (String(a.saleId) === 'opening') {
          if (!Number.isFinite(Number(a.amount)) || Number(a.amount) < 0 || !Number.isSafeInteger(toCents(a.amount))) throw new ApiError(400, 'Invalid opening balance amount.');
          const allocCents = toCents(a.amount);
          if (allocCents <= 0) continue;
          if (allocCents > openingLeft) throw new ApiError(400, 'The amount for the opening balance is more than is owed on it.');
          openingLeft -= allocCents;
          allocations.push({ sale: null, receiptNumber: OPENING_DEBT, amountCents: allocCents });
          remaining -= allocCents;
          continue;
        }
        const sale = bySaleId.get(String(a.saleId));
        if (!sale) throw new ApiError(400, 'One of the selected invoices is no longer outstanding.');
        if (!Number.isFinite(Number(a.amount)) || Number(a.amount) < 0 || !Number.isSafeInteger(toCents(a.amount))) throw new ApiError(400, 'Invalid invoice allocation amount.');
        const allocCents = toCents(a.amount);
        if (allocCents <= 0) continue;
        if (allocCents > sale.outstandingCents) {
          throw new ApiError(400, `Allocation to ${sale.receiptNumber} exceeds its outstanding balance.`);
        }
        sale.outstandingCents -= allocCents;
        await sale.save({ session });
        allocations.push({ sale: sale._id, receiptNumber: sale.receiptNumber, amountCents: allocCents });
        remaining -= allocCents;
      }
      if (remaining !== 0) {
        throw new ApiError(400, 'Allocated amounts must add up exactly to the payment amount.');
      }
    } else {
      // Automatic allocation: the opening balance, then the oldest invoice first.
      allocations.push(...(await allocateDebt(debt, amountCents, session)));
      remaining = 0;
    }

    const previousBalanceCents = customer.balanceCents;
    customer.balanceCents -= amountCents;
    customer.totalPaidCents += amountCents;
    await customer.save({ session });

    const receiptNumber = await generatePaymentReceiptNumber(session);

    const [payment] = await Payment.create(
      [
        {
          receiptNumber,
          customer: customer._id,
          amountCents,
          type: 'debt_payment',
          paymentAccount: account._id,
          paymentAccountName: account.name,
          requestKey,
          requestFingerprint,
          allocations,
          previousBalanceCents,
          newBalanceCents: customer.balanceCents,
          notes: req.body.notes || '',
          createdBy: req.user?._id,
        },
      ],
      { session }
    );

    await CustomerLedger.create(
      [
        {
          customer: customer._id,
          type: 'PAYMENT',
          amountCents: -amountCents,
          payment: payment._id,
          description: `Debt payment ${receiptNumber} (${allocations.map((a) => a.receiptNumber).join(', ')})`,
          balanceBeforeCents: previousBalanceCents,
          balanceAfterCents: customer.balanceCents,
          createdBy: req.user?._id,
        },
      ],
      { session }
    );

    const transaction = await postImmediateTransaction({ account, direction: 'IN', type: 'CUSTOMER_DEBT_PAYMENT', amountCents, referenceType: 'Payment', referenceId: payment._id, description: `Debt payment ${receiptNumber} — ${customer.name}`, createdBy: req.user }, session);
    payment.accountTransaction = transaction._id;
    await payment.save({ session });
    return { payment, customer };
  });

  await logAudit({
    user: req.user,
    action: 'customer.payment',
    entityType: 'Customer',
    entityId: result.customer._id,
    details: { amount, receiptNumber: result.payment.receiptNumber },
  });

  res.status(201).json({
    success: true,
    data: { customer: toDTO(result.customer), paymentId: result.payment._id, receiptNumber: result.payment.receiptNumber },
  });
});

function walletTxnToDTO(t) {
  return {
    id: t._id,
    type: t.type,
    amount: fromCents(t.amountCents),
    account: t.account?._id || t.account,
    accountName: t.account?.name || '',
    reference: t.reference || '',
    sale: t.sale?._id || t.sale,
    saleReceiptNumber: t.sale?.receiptNumber || '',
    note: t.note,
    balanceBefore: fromCents(t.balanceBeforeCents),
    balanceAfter: fromCents(t.balanceAfterCents),
    createdBy: t.createdBy,
    createdAt: t.createdAt,
  };
}

// POST /api/customers/:id/wallet/deposit -- the customer hands over cash
// now (it enters the selected Account, exactly like any other cash
// receipt). If the customer currently owes debt, that debt is cleared
// first out of this same deposit (oldest invoice first, exactly like
// payCustomerDebt's automatic allocation); only what is left over becomes
// prepaid wallet credit. The cash still lands in the Account as ONE
// receipt -- the debt-clearing portion never posts a second Account
// transaction (that would double-count the same physical cash), it only
// moves Customer.balanceCents/Sale.outstandingCents and is recorded via a
// Payment + CustomerLedger entry exactly like a manual debt payment,
// pointing at this deposit's own AccountTransaction for traceability.
export const depositToWallet = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(toCents(amount)) || toCents(amount) <= 0) throw new ApiError(400, 'Enter a valid deposit amount.');
  if (!req.body.paymentAccountId) throw new ApiError(400, 'Please select an account for this deposit.');
  const amountCents = toCents(amount);
  const reference = String(req.body.reference || '').trim().slice(0, 100);

  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    const account = await Account.findById(req.body.paymentAccountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'Selected payment account is not available.');

    const txn = await postImmediateTransaction(
      {
        account,
        direction: 'IN',
        type: 'DEPOSIT',
        amountCents,
        referenceType: 'CustomerWalletTransaction',
        referenceId: customer._id,
        description: `Wallet deposit for ${customer.name}${reference ? ` (from ${reference})` : ''}`,
        createdBy: req.user,
      },
      session
    );

    let remainingCents = amountCents;
    let debtClearedCents = 0;
    let payment = null;

    // Use the deposit on the debt only when chosen (applyToDebt), or, when
    // nothing was chosen, if this customer pays debt from the wallet
    // automatically. Otherwise all of it stays in the wallet.
    const applyToDebt = req.body.applyToDebt == null ? !!customer.walletAutoPay : req.body.applyToDebt === true || req.body.applyToDebt === 'true';
    if (applyToDebt && customer.balanceCents > 0) {
      // The invoices plus the opening balance, capped by balanceCents so it
      // can never go negative.
      const debt = await outstandingDebt(customer, session);
      const debtPortionCents = Math.min(remainingCents, customer.balanceCents, debt.totalCents);

      if (debtPortionCents > 0) {
        const allocations = await allocateDebt(debt, debtPortionCents, session);
        debtClearedCents = allocations.reduce((sum, a) => sum + a.amountCents, 0);
        remainingCents -= debtClearedCents;

        const previousBalanceCents = customer.balanceCents;
        customer.balanceCents -= debtClearedCents;
        customer.totalPaidCents += debtClearedCents;

        const receiptNumber = await generatePaymentReceiptNumber(session);
        [payment] = await Payment.create(
          [
            {
              receiptNumber,
              customer: customer._id,
              amountCents: debtClearedCents,
              type: 'debt_payment',
              paymentAccount: account._id,
              paymentAccountName: account.name,
              accountTransaction: txn?._id || null,
              allocations,
              previousBalanceCents,
              newBalanceCents: customer.balanceCents,
              notes: `Auto-applied from wallet deposit${req.body.note ? `: ${req.body.note}` : ''}`,
              createdBy: req.user?._id,
            },
          ],
          { session }
        );

        await CustomerLedger.create(
          [
            {
              customer: customer._id,
              type: 'PAYMENT',
              amountCents: -debtClearedCents,
              payment: payment._id,
              description: `Debt payment ${receiptNumber} (${allocations.map((a) => a.receiptNumber).join(', ')}) -- auto-applied from wallet deposit`,
              balanceBeforeCents: previousBalanceCents,
              balanceAfterCents: customer.balanceCents,
              createdBy: req.user?._id,
            },
          ],
          { session }
        );
      }
    }

    const walletCreditedCents = remainingCents;
    const previousWalletBalanceCents = customer.walletBalanceCents;
    let walletTxn = null;
    if (walletCreditedCents > 0) {
      customer.walletBalanceCents += walletCreditedCents;
      const note =
        debtClearedCents > 0
          ? `Deposit ${fromCents(amountCents).toFixed(2)} -- ${fromCents(debtClearedCents).toFixed(2)} applied to debt, ${fromCents(walletCreditedCents).toFixed(2)} added to wallet${req.body.note ? `: ${req.body.note}` : ''}`
          : req.body.note || '';
      [walletTxn] = await CustomerWalletTransaction.create(
        [
          {
            customer: customer._id,
            type: 'DEPOSIT',
            amountCents: walletCreditedCents,
            account: account._id,
            accountTransaction: txn?._id || null,
            reference,
            note,
            balanceBeforeCents: previousWalletBalanceCents,
            balanceAfterCents: customer.walletBalanceCents,
            createdBy: req.user?._id,
          },
        ],
        { session }
      );
    }
    await customer.save({ session });

    return { customer, walletTxn, payment, debtClearedCents, walletCreditedCents };
  });

  await logAudit({
    user: req.user,
    action: 'customer.wallet.deposit',
    entityType: 'Customer',
    entityId: result.customer._id,
    details: { amount, debtCleared: fromCents(result.debtClearedCents), walletCredited: fromCents(result.walletCreditedCents) },
  });

  res.status(201).json({
    success: true,
    data: {
      customer: toDTO(result.customer),
      transaction: result.walletTxn ? walletTxnToDTO(result.walletTxn) : null,
      debtCleared: fromCents(result.debtClearedCents),
      walletCredited: fromCents(result.walletCreditedCents),
    },
  });
});

// POST /api/customers/:id/wallet/withdraw -- the customer takes money back
// out of their wallet: it leaves the chosen Account, and the number/account
// it was sent to is recorded. Never more than the wallet holds.
export const editWalletBalance = asyncHandler(async (req, res) => {
  const balance = Number(req.body.balance);
  if (!Number.isFinite(balance) || balance < 0 || !Number.isSafeInteger(toCents(balance))) throw new ApiError(400, 'Enter a valid balance (0 or more).');
  const newCents = toCents(balance);
  const note = String(req.body.note || '').trim().slice(0, 500);

  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    const before = customer.walletBalanceCents || 0;
    const diff = newCents - before;
    if (diff === 0) throw new ApiError(400, 'The wallet already holds this amount.');
    customer.walletBalanceCents = newCents;
    const [walletTxn] = await CustomerWalletTransaction.create(
      [
        {
          customer: customer._id,
          type: 'ADJUSTMENT',
          amountCents: diff,
          note: note || `Wallet edited from ${fromCents(before).toFixed(2)} to ${fromCents(newCents).toFixed(2)}`,
          balanceBeforeCents: before,
          balanceAfterCents: newCents,
          createdBy: req.user?._id,
        },
      ],
      { session }
    );
    await customer.save({ session });
    return { customer, walletTxn, before };
  });

  await logAudit({
    user: req.user,
    action: 'customer.wallet.edit',
    entityType: 'Customer',
    entityId: result.customer._id,
    details: { from: fromCents(result.before), to: balance, note },
  });
  res.json({ success: true, data: { customer: toDTO(result.customer), transaction: walletTxnToDTO(result.walletTxn) } });
});

export const withdrawFromWallet = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(toCents(amount)) || toCents(amount) <= 0) throw new ApiError(400, 'Enter a valid amount.');
  if (!req.body.paymentAccountId) throw new ApiError(400, 'Select the account the money is paid from.');
  const amountCents = toCents(amount);
  const reference = String(req.body.reference || '').trim().slice(0, 100);
  const note = String(req.body.note || '').trim().slice(0, 500);

  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    if (amountCents > customer.walletBalanceCents) {
      throw new ApiError(400, `The wallet only holds ${fromCents(customer.walletBalanceCents).toFixed(2)}.`);
    }
    const account = await Account.findById(req.body.paymentAccountId).session(session);
    if (!account || !account.isActive) throw new ApiError(400, 'Selected account is not available.');

    const txn = await postImmediateTransaction(
      {
        account,
        direction: 'OUT',
        type: 'WITHDRAWAL',
        amountCents,
        referenceType: 'CustomerWalletTransaction',
        referenceId: customer._id,
        description: `Wallet withdrawal for ${customer.name}${reference ? ` (sent to ${reference})` : ''}`,
        createdBy: req.user,
      },
      session
    );
    const before = customer.walletBalanceCents;
    customer.walletBalanceCents -= amountCents;
    const [walletTxn] = await CustomerWalletTransaction.create(
      [
        {
          customer: customer._id,
          type: 'WITHDRAWAL',
          amountCents: -amountCents,
          account: account._id,
          accountTransaction: txn?._id || null,
          reference,
          note,
          balanceBeforeCents: before,
          balanceAfterCents: customer.walletBalanceCents,
          createdBy: req.user?._id,
        },
      ],
      { session }
    );
    await customer.save({ session });
    await walletTxn.populate('account', 'name');
    return { customer, walletTxn };
  });

  await logAudit({
    user: req.user,
    action: 'customer.wallet.withdraw',
    entityType: 'Customer',
    entityId: result.customer._id,
    details: { amount, reference },
  });
  res.status(201).json({ success: true, data: { customer: toDTO(result.customer), transaction: walletTxnToDTO(result.walletTxn) } });
});

// GET /api/customers/:id/items?type=all|day|month|year&key= -- what this
// customer bought, item by item, with the most and least bought item.
export const getCustomerItemsReport = asyncHandler(async (req, res) => {
  const r = await getCustomerItems({ customerId: req.params.id, type: req.query.type || 'all', key: req.query.key });
  const row = (i) =>
    i && {
      itemId: i.item,
      name: i.itemName,
      quantity: i.quantity,
      invoices: i.invoices,
      unitPrice: i.quantity ? fromCents(Math.round(i.salesCents / i.quantity)) : 0,
      spent: fromCents(i.salesCents),
      cost: fromCents(i.costCents),
      profit: fromCents(i.salesCents - i.costCents),
      lastBought: i.lastBought,
    };
  res.json({
    success: true,
    data: {
      customer: { id: r.customer._id, name: r.customer.name, phone: r.customer.phone },
      type: r.type,
      key: r.key,
      invoiceCount: r.invoiceCount,
      items: r.items.map(row),
      mostBought: row(r.mostBought),
      leastBought: row(r.leastBought),
      totals: {
        items: r.items.length,
        quantity: r.totals.quantity,
        spent: fromCents(r.totals.salesCents),
        cost: fromCents(r.totals.costCents),
        profit: fromCents(r.totals.salesCents - r.totals.costCents),
      },
    },
  });
});

// GET /api/customers/:id/wallet/history?q=
export const getWalletHistory = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const q = String(req.query.q || '').trim();
  const filter = { customer: customer._id };
  let transactions = await CustomerWalletTransaction.find(filter)
    .populate('account', 'name')
    .populate('sale', 'receiptNumber')
    .sort({ createdAt: -1 });
  if (q) {
    const needle = q.toLowerCase();
    transactions = transactions.filter(
      (t) =>
        t.type.toLowerCase().includes(needle) ||
        (t.note || '').toLowerCase().includes(needle) ||
        (t.sale?.receiptNumber || '').toLowerCase().includes(needle) ||
        (t.account?.name || '').toLowerCase().includes(needle) ||
        (t.reference || '').toLowerCase().includes(needle)
    );
  }
  res.json({ success: true, data: { walletBalance: fromCents(customer.walletBalanceCents), transactions: transactions.map(walletTxnToDTO) } });
});

// GET /api/customers/:id/statement?from=&to= -- ONE consolidated document:
// every CONFIRMED invoice and every payment from the customer's join date
// (or a custom range) through today, merged into a single running-balance
// ledger. Draft invoices are deliberately excluded from the finalized
// totals/ledger and returned separately as "pendingToday" so they are never
// mistaken for posted debt/revenue.
// A customer's confirmed invoices that were cancelled later, and the money
// paid on each one (at the sale and by debt payments) -- shared by the normal
// statement (which leaves them out) and the Cancelled Invoices statement.
async function cancelledPicture(customerId, payments, from, to) {
  const range = from || to ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};
  const all = await Sale.find({ customer: customerId, status: 'CANCELLED', confirmedAt: { $ne: null }, ...range }).sort({ createdAt: 1 });
  const ids = new Set(all.map((x) => String(x._id)));
  const paidOn = new Map(); // saleId -> [{ payment, cents }]
  const onCancelledCents = new Map(); // paymentId -> cents of it that paid cancelled invoices
  for (const p of payments) {
    const parts = p.type === 'sale' && p.relatedSale ? [[String(p.relatedSale), p.amountCents]] : (p.allocations || []).map((al) => [String(al.sale), al.amountCents]);
    for (const [saleId, cents] of parts) {
      if (!ids.has(saleId)) continue;
      paidOn.set(saleId, [...(paidOn.get(saleId) || []), { payment: p, cents }]);
      onCancelledCents.set(String(p._id), (onCancelledCents.get(String(p._id)) || 0) + cents);
    }
  }
  return { sales: all, paidOn, onCancelledCents };
}
export const getCustomerStatement = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');

  const from = req.query.from ? new Date(req.query.from) : new Date(customer.createdAt);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  if (req.query.to && req.query.to.length <= 10) to.setHours(23, 59, 59, 999);

  const [sales, allPayments, todaysDrafts, adjustments, before, anyAdjustment] = await Promise.all([
    Sale.find({ customer: customer._id, status: 'CONFIRMED', createdAt: { $gte: from, $lte: to } }).sort({ createdAt: 1 }),
    Payment.find({ customer: customer._id, status: { $ne: 'CANCELLED' }, createdAt: { $gte: from, $lte: to } }).sort({ createdAt: 1 }),
    Sale.find({ customer: customer._id, status: 'DRAFT' }).sort({ createdAt: -1 }),
    // The opening balance (and any later change to it), each on its own line.
    // Opening balance changes and loans only: an adjustment tied to an invoice
    // (an edited invoice's old version, an invoice moved between customers)
    // is already in that invoice's own line at its final amount.
    CustomerLedger.find({ customer: customer._id, type: { $in: ['ADJUSTMENT', 'LOAN'] }, sale: null, createdAt: { $gte: from, $lte: to } }).sort({ createdAt: 1 }),
    // What was owed when the period starts.
    CustomerLedger.findOne({ customer: customer._id, createdAt: { $lt: from } }).sort({ createdAt: -1, _id: -1 }),
    CustomerLedger.exists({ customer: customer._id, type: 'ADJUSTMENT', sale: null }),
  ]);
  // Cancelled invoices have their own statement, so money paid on them is
  // left out here too (it went to the wallet or was given back). A debt
  // payment keeps only the part that paid invoices still standing.
  const { onCancelledCents } = await cancelledPicture(customer._id, allPayments);
  const payments = allPayments
    .map((p) => ({ p, cents: p.amountCents - (onCancelledCents.get(String(p._id)) || 0) }))
    .filter((x) => x.cents > 0);

  // Merge into one chronological, double-entry ledger: a confirmed sale is a
  // debit (increases what the customer owes), a payment is a credit.
  const entries = [
    ...sales.map((x) => ({
      date: x.createdAt,
      reference: x.receiptNumber,
      type: 'SALE',
      description: `Sale invoice ${x.receiptNumber}`,
      debitCents: x.totalCents,
      creditCents: 0,
      saleId: x._id,
    })),
    ...payments.map(({ p, cents }) => ({
      date: p.createdAt,
      reference: p.receiptNumber,
      type: p.type === 'sale' ? 'SALE_PAYMENT' : 'PAYMENT',
      description: p.type === 'sale' ? `Payment received at sale (${p.receiptNumber})` : `Debt payment ${p.receiptNumber}`,
      debitCents: 0,
      creditCents: cents,
      paymentId: p._id,
    })),
    ...adjustments.map((a) => ({
      date: a.createdAt,
      reference: a.type === 'LOAN' ? a.reference : 'Opening balance',
      type: a.type === 'LOAN' ? 'LOAN' : 'OPENING',
      loanId: a.type === 'LOAN' && a.amountCents > 0 && !a.cancelledAt ? a._id : null,
      description: a.description,
      debitCents: Math.max(0, a.amountCents),
      creditCents: Math.max(0, -a.amountCents),
    })),
  ];
  // A customer from before opening balances were recorded as their own line:
  // the opening balance is shown on the day they were added.
  let startCents = before ? before.balanceAfterCents : 0;
  if (!anyAdjustment && customer.openingBalanceCents) {
    if (new Date(customer.createdAt) >= from) entries.push({ date: customer.createdAt, reference: 'Opening balance', type: 'OPENING', description: 'Opening balance', debitCents: customer.openingBalanceCents, creditCents: 0 });
    else if (!before) startCents = customer.openingBalanceCents;
  }
  entries.sort((a, b) => new Date(a.date) - new Date(b.date) || (a.type === 'OPENING' ? -1 : b.type === 'OPENING' ? 1 : 0));

  let runningBalanceCents = startCents;
  const ledger = entries.map((e) => {
    runningBalanceCents += e.debitCents - e.creditCents;
    return {
      date: e.date,
      reference: e.reference,
      type: e.type,
      description: e.description,
      debit: fromCents(e.debitCents),
      credit: fromCents(e.creditCents),
      runningBalance: fromCents(runningBalanceCents),
      saleId: e.saleId || null,
      paymentId: e.paymentId || null,
      loanId: e.loanId || null,
    };
  });
  // What was owed before the period starts, as the first line.
  if (startCents) ledger.unshift({ date: from, reference: 'Brought forward', type: 'BROUGHT_FORWARD', description: 'Balance brought forward', debit: 0, credit: 0, runningBalance: fromCents(startCents), saleId: null, paymentId: null });

  const totalAmountPurchasedCents = sales.reduce((sum, s) => sum + s.totalCents, 0);
  const totalPaymentsCents = payments.reduce((sum, x) => sum + x.cents, 0);
  const totalCreditGeneratedCents = sales.reduce((sum, s) => sum + s.balanceAddedCents, 0);

  res.json({
    success: true,
    data: {
      customer: { ...toDTO(customer), since: customer.createdAt },
      range: { from, to },
      summary: {
        customerSince: customer.createdAt,
        totalConfirmedPurchases: sales.length,
        totalAmountPurchased: fromCents(totalAmountPurchasedCents),
        totalPayments: fromCents(totalPaymentsCents),
        openingBalance: fromCents(adjustments.filter((a) => a.type === 'ADJUSTMENT').reduce((s, a) => s + a.amountCents, 0) + (!anyAdjustment && new Date(customer.createdAt) >= from ? customer.openingBalanceCents : 0)),
        totalCreditGenerated: fromCents(totalCreditGeneratedCents),
        currentOutstandingBalance: fromCents(customer.balanceCents),
        numberOfFinalizedInvoices: sales.length,
      },
      ledger,
      invoices: sales.map((s) => ({
        id: s._id,
        receiptNumber: s.receiptNumber,
        createdAt: s.createdAt,
        items: s.items.map((i) => ({ name: i.itemName, quantity: i.quantity, unitPrice: fromCents(i.unitPriceCents), subtotal: fromCents(i.subtotalCents) })),
        total: fromCents(s.totalCents),
        paidAmount: fromCents(s.paidAmountCents),
        balance: fromCents(s.balanceAddedCents),
      })),
      pendingToday: todaysDrafts.map((s) => ({
        id: s._id,
        receiptNumber: s.receiptNumber,
        createdAt: s.createdAt,
        total: fromCents(s.totalCents),
        paidAmount: fromCents(s.paidAmountCents),
      })),
    },
  });
});

export { toDTO as customerToDTO };

// POST /api/customers/:id/wallet/pay-debt { amount? } -- the customer agreed:
// pay their debt (oldest invoice first) out of their wallet, all of it or
// up to `amount`.
export const payDebtFromWallet = asyncHandler(async (req, res) => {
  const amount = req.body.amount == null || req.body.amount === '' ? null : Number(req.body.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(toCents(amount)) || toCents(amount) <= 0)) throw new ApiError(400, 'Enter a valid amount.');
  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    if (customer.walletBalanceCents <= 0) throw new ApiError(400, 'There is no money in this customer\'s wallet.');
    if (customer.balanceCents <= 0) throw new ApiError(400, 'This customer has no debt to pay.');
    const maxCents = amount === null ? null : toCents(amount);
    if (maxCents !== null && maxCents > Math.min(customer.walletBalanceCents, customer.balanceCents)) throw new ApiError(400, 'That is more than the wallet holds or the debt owed.');
    const appliedCents = await applyWalletToDebt(customer, session, req.user, { force: true, maxCents });
    return { customer, appliedCents };
  });
  await logAudit({ user: req.user, action: 'customer.wallet.payDebt', entityType: 'Customer', entityId: result.customer._id, details: { amount: fromCents(result.appliedCents) } });
  res.json({ success: true, data: { customer: toDTO(result.customer), applied: fromCents(result.appliedCents) } });
});

// PUT /api/customers/:id/wallet/auto-pay { enabled } -- whether wallet money
// pays this customer's debt automatically.
export const setWalletAutoPay = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  customer.walletAutoPay = req.body.enabled === true;
  await customer.save();
  await logAudit({ user: req.user, action: 'customer.wallet.autoPay', entityType: 'Customer', entityId: customer._id, details: { enabled: customer.walletAutoPay } });
  res.json({ success: true, data: toDTO(customer) });
});

// POST /api/customers/:id/payments/:paymentId/cancel { reason, refundTo } --
// admin/manager: undoes a debt payment. The amount is owed again on the
// invoices it paid, and the money either stays with us as wallet credit
// (refundTo: 'WALLET') or is handed back out of the account it came into
// (refundTo: 'ACCOUNT'). A payment made from the wallet always goes back to
// the wallet.
export const cancelCustomerPayment = asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const reference = String(req.body.reference || '').trim().slice(0, 100); // where the money was sent back to
  const result = await runInTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) throw new ApiError(404, 'Customer not found.');
    const payment = await Payment.findOne({ _id: req.params.paymentId, customer: customer._id }).session(session);
    if (!payment) throw new ApiError(404, 'Payment not found.');
    if (payment.type !== 'debt_payment') throw new ApiError(409, 'Only debt payments can be cancelled here. A payment taken at the sale is undone by cancelling that invoice.');
    if (payment.status === 'CANCELLED') throw new ApiError(409, 'This payment is already cancelled.');

    const fromWallet = !payment.paymentAccount;
    const refundTo = fromWallet ? 'WALLET' : req.body.refundTo === 'ACCOUNT' ? 'ACCOUNT' : 'WALLET';

    // The debt comes back on the same invoices.
    for (const a of payment.allocations) {
      if (!a.sale) continue; // the opening balance: owed again through balanceCents below
      const sale = await Sale.findById(a.sale).session(session);
      if (!sale || sale.status !== 'CONFIRMED') {
        throw new ApiError(409, `Invoice ${a.receiptNumber} was cancelled after this payment, so the payment cannot be undone.`);
      }
      sale.outstandingCents += a.amountCents;
      await sale.save({ session });
    }
    const amountCents = payment.amountCents;
    const balanceBeforeCents = customer.balanceCents;
    customer.balanceCents += amountCents;
    customer.totalPaidCents = Math.max(0, customer.totalPaidCents - amountCents);

    if (refundTo === 'WALLET') {
      const walletBefore = customer.walletBalanceCents;
      customer.walletBalanceCents += amountCents;
      await CustomerWalletTransaction.create(
        [
          {
            customer: customer._id,
            type: 'REFUND',
            amountCents,
            note: `Payment ${payment.receiptNumber} cancelled -- money kept in the wallet${reason ? `: ${reason}` : ''}`,
            balanceBeforeCents: walletBefore,
            balanceAfterCents: customer.walletBalanceCents,
            createdBy: req.user?._id,
          },
        ],
        { session }
      );
    } else {
      const account = await Account.findById(payment.paymentAccount).session(session);
      if (!account) throw new ApiError(409, 'The account this payment came into no longer exists. Keep the money in the wallet instead.');
      await postImmediateTransaction(
        {
          account,
          direction: 'OUT',
          type: 'REFUND',
          amountCents,
          referenceType: 'Payment',
          referenceId: payment._id,
          description: `Payment ${payment.receiptNumber} cancelled -- money returned to ${customer.name}${reference ? ` (sent to ${reference})` : ''}${reason ? ` (${reason})` : ''}`,
          createdBy: req.user,
        },
        session
      );
    }
    await customer.save({ session });

    await CustomerLedger.create(
      [
        {
          customer: customer._id,
          type: 'PAYMENT_CANCELLED',
          amountCents,
          payment: payment._id,
          description: `Payment ${payment.receiptNumber} cancelled -- ${refundTo === 'WALLET' ? 'money kept in the wallet' : 'money given back from ' + (payment.paymentAccountName || 'the account') + (reference ? ` to ${reference}` : '')}${reason ? `: ${reason}` : ''}`,
          balanceBeforeCents,
          balanceAfterCents: customer.balanceCents,
          createdBy: req.user?._id,
        },
      ],
      { session }
    );

    payment.status = 'CANCELLED';
    payment.cancelledAt = new Date();
    payment.cancelReason = reason;
    payment.cancelledByName = req.user?.name || '';
    payment.refundedTo = refundTo;
    payment.refundReference = refundTo === 'ACCOUNT' ? reference : '';
    await payment.save({ session });
    return { customer, payment, refundTo };
  });

  await logAudit({
    user: req.user,
    action: 'customer.payment.cancel',
    entityType: 'Customer',
    entityId: result.customer._id,
    details: { receiptNumber: result.payment.receiptNumber, amount: fromCents(result.payment.amountCents), refundTo: result.refundTo, reference, reason },
  });
  res.json({ success: true, data: { customer: toDTO(result.customer), receiptNumber: result.payment.receiptNumber, amount: fromCents(result.payment.amountCents), refundTo: result.refundTo } });
});

// GET /api/customers/debtors -- only the customers who owe money, most owed
// first, with what is needed to follow up: contacts, how many invoices are
// unpaid and since when, the last payment, and wallet credit.
export const listDebtors = asyncHandler(async (req, res) => {
  const customers = await Customer.find({ balanceCents: { $gt: 0 } }).sort({ balanceCents: -1 });
  const ids = customers.map((c) => c._id);
  const [openInvoices, lastPayments] = await Promise.all([
    Sale.aggregate([
      { $match: { customer: { $in: ids }, status: 'CONFIRMED', outstandingCents: { $gt: 0 } } },
      { $group: { _id: '$customer', count: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
    ]),
    Payment.aggregate([
      { $match: { customer: { $in: ids }, status: { $ne: 'CANCELLED' } } },
      { $group: { _id: '$customer', last: { $max: '$createdAt' } } },
    ]),
  ]);
  const inv = new Map(openInvoices.map((r) => [String(r._id), r]));
  const pay = new Map(lastPayments.map((r) => [String(r._id), r.last]));
  const rows = customers.map((c) => ({
    id: c._id,
    name: c.name,
    phone: c.phone,
    address: c.address,
    balance: fromCents(c.balanceCents),
    walletBalance: fromCents(c.walletBalanceCents),
    totalPurchased: fromCents(c.totalPurchasedCents),
    totalPaid: fromCents(c.totalPaidCents),
    unpaidInvoices: inv.get(String(c._id))?.count || 0,
    oldestUnpaid: inv.get(String(c._id))?.oldest || null,
    lastPayment: pay.get(String(c._id)) || null,
  }));
  res.json({
    success: true,
    data: { customers: rows, totalOwed: fromCents(customers.reduce((s, c) => s + c.balanceCents, 0)), count: rows.length, asOf: new Date() },
  });
});

// GET /api/customers/:id/cancelled-statement?from&to -- the customer's
// cancelled invoices on their own: what each was, what was paid on it, when
// and why it was cancelled, and where the money went (wallet, or cash out of
// an account to a number).
export const getCancelledStatement = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new ApiError(404, 'Customer not found.');
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  if (to && req.query.to.length <= 10) to.setHours(23, 59, 59, 999);

  const payments = await Payment.find({ customer: customer._id, status: { $ne: 'CANCELLED' } }).sort({ createdAt: 1 });
  const { sales, paidOn } = await cancelledPicture(customer._id, payments, from, to);

  const invoices = sales.map((x) => {
    const paid = (paidOn.get(String(x._id)) || []).map(({ payment, cents }) => ({
      receiptNumber: payment.receiptNumber,
      date: payment.createdAt,
      kind: payment.type === 'sale' ? 'At the sale' : 'Debt payment',
      account: payment.paymentAccountName || '',
      amount: fromCents(cents),
    }));
    const paidCents = (paidOn.get(String(x._id)) || []).reduce((t, y) => t + y.cents, 0);
    const r = x.cancelRefund || {};
    const refundCents = r.to ? r.amountCents : paidCents;
    return {
      id: x._id,
      receiptNumber: x.receiptNumber,
      date: x.createdAt,
      items: x.items.map((i) => ({ name: i.itemName, quantity: i.quantity, unitPrice: fromCents(i.unitPriceCents), subtotal: fromCents(i.subtotalCents) })),
      total: fromCents(x.totalCents),
      payments: paid,
      paid: fromCents(paidCents),
      fromWallet: fromCents(x.walletAmountCents || 0),
      cancelledAt: x.cancelledAt,
      reason: x.cancelledReason || '',
      refund: refundCents > 0 ? { to: r.to || 'WALLET', amount: fromCents(refundCents), accountName: r.accountName || '', reference: r.reference || '', byName: r.byName || '' } : null,
    };
  });
  const sum = (fn) => fromCents(sales.reduce((t, x, i) => t + fn(x, invoices[i]), 0));
  res.json({
    success: true,
    data: {
      customer: { ...toDTO(customer), since: customer.createdAt },
      range: { from, to },
      invoices,
      totals: {
        count: invoices.length,
        total: sum((x) => x.totalCents),
        paid: sum((x, inv) => Math.round(inv.paid * 100)),
        toWallet: sum((x, inv) => (inv.refund?.to === 'WALLET' ? Math.round(inv.refund.amount * 100) : 0)),
        cashBack: sum((x, inv) => (inv.refund?.to === 'ACCOUNT' ? Math.round(inv.refund.amount * 100) : 0)),
      },
    },
  });
});
