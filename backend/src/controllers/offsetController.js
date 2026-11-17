import Customer from '../models/Customer.js';
import Purchase from '../models/Purchase.js';
import Supplier from '../models/Supplier.js';
import Offset from '../models/Offset.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { fromCents } from '../utils/money.js';
import { runInTransaction } from '../utils/transaction.js';
import { logAudit } from '../services/auditService.js';
import { createOffset, cancelOffset, deleteOffset, supplierOwedCents, customerOwesCents } from '../services/offsetService.js';
import { NET_OWED } from '../services/supplierPaymentService.js';

const dto = (o) => ({
  id: o._id,
  number: o.offsetNumber,
  customerId: o.customer,
  customerName: o.customerName,
  supplierId: o.supplier,
  supplierName: o.supplierName,
  amount: fromCents(o.amountCents),
  customerBefore: fromCents(o.customerBeforeCents),
  customerAfter: fromCents(o.customerAfterCents),
  supplierBefore: fromCents(o.supplierBeforeCents),
  supplierAfter: fromCents(o.supplierAfterCents),
  customerReceipt: o.customerReceipt,
  supplierReceipt: o.supplierReceipt,
  date: o.date,
  note: o.note,
  status: o.status,
  cancelledAt: o.cancelledAt,
  cancelReason: o.cancelReason,
  createdByName: o.createdByName,
  createdAt: o.createdAt,
});

// GET /api/offsets
export const listOffsets = asyncHandler(async (req, res) => {
  // ?customerId / ?supplierId: one person's offsets (as customer or supplier).
  const or = [];
  if (req.query.customerId) or.push({ customer: req.query.customerId });
  if (req.query.supplierId) or.push({ supplier: req.query.supplierId });
  const rows = await Offset.find(or.length ? { $or: or } : {}).sort({ createdAt: -1 }).limit(1000);
  res.json({ success: true, data: rows.map(dto) });
});

// GET /api/offsets/:id
export const getOffset = asyncHandler(async (req, res) => {
  const o = await Offset.findById(req.params.id);
  if (!o) throw new ApiError(404, 'Offset not found.');
  res.json({ success: true, data: dto(o) });
});

// GET /api/offsets/parties -- every customer and every supplier (any
// names: the customer and the supplier do not have to be the same person),
// those with something owed first.
export const listParties = asyncHandler(async (req, res) => {
  const [customers, suppliers, owedRows] = await Promise.all([
    Customer.find({}).sort({ name: 1 }).select('name phone balanceCents').lean(),
    Supplier.find({}).sort({ name: 1 }).select('name').lean(),
    Purchase.aggregate(NET_OWED),
  ]);
  const owed = new Map(owedRows.map((r) => [String(r._id), r.owedCents]));
  const byOwed = (a, b) => (b.amount > 0) - (a.amount > 0) || a.name.localeCompare(b.name);
  res.json({
    success: true,
    data: {
      customers: customers.map((c) => ({ id: c._id, name: c.name, phone: c.phone || '', owes: fromCents(Math.max(0, c.balanceCents)), amount: c.balanceCents })).sort(byOwed),
      suppliers: suppliers.map((s) => ({ id: s._id, name: s.name, owed: fromCents(owed.get(String(s._id)) || 0), amount: owed.get(String(s._id)) || 0 })).sort(byOwed),
    },
  });
});

// GET /api/offsets/preview?customerId&supplierId
export const previewOffset = asyncHandler(async (req, res) => {
  // Either side may be missing (the statement of someone who is only a
  // customer, or only a supplier).
  const customer = req.query.customerId ? await Customer.findById(req.query.customerId) : null;
  if (req.query.customerId && !customer) throw new ApiError(404, 'Customer not found.');
  const owes = customer ? await customerOwesCents(customer) : 0;
  const owed = req.query.supplierId ? await supplierOwedCents(req.query.supplierId) : 0;
  const amount = Math.min(owes, owed);
  res.json({ success: true, data: { customerOwes: fromCents(owes), supplierOwed: fromCents(owed), amount: fromCents(Math.max(0, amount)), customerAfter: fromCents(owes - Math.max(0, amount)), supplierAfter: fromCents(owed - Math.max(0, amount)) } });
});

// POST /api/offsets { customerId, supplierId, date, note }
export const postOffset = asyncHandler(async (req, res) => {
  const date = req.body.date ? new Date(`${String(req.body.date).slice(0, 10)}T12:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'Enter a valid date.');
  const doc = await runInTransaction((session) => createOffset(session, { customerId: req.body.customerId, supplierId: req.body.supplierId, date, note: String(req.body.note || '').slice(0, 500), user: req.user }));
  await logAudit({ user: req.user, action: 'offset.create', entityType: 'Offset', entityId: doc._id, details: { number: doc.offsetNumber, amount: fromCents(doc.amountCents) } });
  res.status(201).json({ success: true, data: dto(doc) });
});

// POST /api/offsets/:id/cancel { reason }
export const postCancelOffset = asyncHandler(async (req, res) => {
  const doc = await runInTransaction((session) => cancelOffset(session, req.params.id, { reason: String(req.body.reason || '').slice(0, 300), user: req.user }));
  await logAudit({ user: req.user, action: 'offset.cancel', entityType: 'Offset', entityId: doc._id, details: { number: doc.offsetNumber } });
  res.json({ success: true, data: dto(doc) });
});

// DELETE /api/offsets/:id -- undo everything and remove it.
export const removeOffset = asyncHandler(async (req, res) => {
  const doc = await runInTransaction((session) => deleteOffset(session, req.params.id, { user: req.user }));
  await logAudit({ user: req.user, action: 'offset.delete', entityType: 'Offset', entityId: doc._id, details: { number: doc.offsetNumber, amount: fromCents(doc.amountCents) } });
  res.json({ success: true, data: { id: doc._id, number: doc.offsetNumber } });
});
