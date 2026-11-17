import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, Plus, Search, Save, FileText, Building2, Pencil, ArrowRightLeft, CheckCircle2, Boxes, Folder, FolderOpen, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDebounce } from '../../hooks/useDebounce.js';
import { formatCurrency, formatDate, formatDateTime } from '../../utils/format.js';
import Button from '../../components/ui/Button.jsx';
import Modal from '../../components/ui/Modal.jsx';
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx';
import { FormField, Input, Textarea } from '../../components/ui/Field.jsx';
import { PageSpinner } from '../../components/ui/Spinner.jsx';
import SupplierPicker from '../purchases/SupplierPicker.jsx';
import { hasPermission } from '../../constants/permissions.js';
import { previewWeightedAverageCost } from '../../utils/wac.js';

const emptyRow = () => ({ itemName: '', quantity: '', cost: '', sellingPrice: '', expiryDate: '' });

// A manually-entered archive of a supplier's paper invoice, saved exactly as
// typed -- and, when chosen on save, received into stock (see
// supplierInvoiceArchiveController on the backend). Default view is a
// searchable file browser of every archived invoice; the entry form only
// appears inside the "+ Manual Entry Invoice" modal (also used to edit).
// Edit and Delete are admin/manager only (the server enforces it too).
export default function ManualSupplierInvoiceArchive() {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager'; // Delete
  const canEdit = hasPermission(user, 'editSupplierInvoices');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 250);
  const [archives, setArchives] = useState(null); // null = loading
  const [loading, setLoading] = useState(true);
  // One folder per supplier; a search, or an opened folder, shows invoices.
  const [folders, setFolders] = useState(null);
  const [folder, setFolder] = useState(null); // { supplier, name }
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const showFolders = !debouncedQuery.trim() && !folder;
  const [viewing, setViewing] = useState(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    (nextPage = 1) => {
      setLoading(true);
      const req = showFolders
        ? client.get('/supplier-invoice-archives/by-supplier').then((res) => setFolders(res.data.data))
        : client
            .get('/supplier-invoice-archives', { params: { q: debouncedQuery.trim() || undefined, supplier: debouncedQuery.trim() ? undefined : folder?.supplier, page: nextPage, limit: 50 } })
            .then((res) => {
              setArchives((prev) => (nextPage === 1 ? res.data.data : [...(prev || []), ...res.data.data]));
              setPage(nextPage);
              setHasMore(res.data.pagination.page < res.data.pagination.pages);
            });
      req.catch((err) => toast.error(err.friendlyMessage || 'Failed to load supplier invoice archives.')).finally(() => setLoading(false));
    },
    [debouncedQuery, folder, showFolders] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (!showFolders) setArchives(null);
    load(1);
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (archive) => {
    setViewing(null);
    setEditing(archive);
  };
  const startDelete = (archive) => {
    setViewing(null);
    setDeleteTarget(archive);
  };

  const [sending, setSending] = useState(null);
  const sendToPurchases = async (archive) => {
    setSending(archive.id);
    try {
      const res = await client.post(`/supplier-invoice-archives/${archive.id}/to-purchase`, {});
      toast.success(`Added to Purchase Invoices as ${res.data.data.purchaseNumber} — ${formatCurrency(archive.grandTotal)} owed to ${archive.supplierName}.`);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not add it to Purchase Invoices.');
    } finally {
      setSending(null);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await client.delete(`/supplier-invoice-archives/${deleteTarget.id}`);
      const alsoPurchase = deleteTarget.purchaseNumber ? ` and its purchase invoice ${deleteTarget.purchaseNumber}` : '';
      toast.success(
        res.data.data.refunded > 0
          ? `Serial ${deleteTarget.serialNumber}${alsoPurchase} deleted — ${formatCurrency(res.data.data.refunded)} paid on it went back to the account.`
          : `Serial ${deleteTarget.serialNumber}${alsoPurchase} deleted.`
      );
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not delete this invoice.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <Input
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by Shop/Supplier Serial Number, Supplier name..."
          />
        </div>
        <Button onClick={() => setEntryOpen(true)}>
          <Plus className="h-4 w-4" /> Manual Entry Invoice
        </Button>
      </div>

      {folder && !debouncedQuery.trim() && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setFolder(null)} className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800">
            <ArrowLeft className="h-4 w-4" /> All suppliers
          </button>
          <span className="text-neutral-300">/</span>
          <span className="inline-flex items-center gap-1.5 text-sm font-bold text-neutral-900">
            <FolderOpen className="h-4 w-4 text-brand-600" /> {folder.name}
          </span>
        </div>
      )}

      {showFolders ? (
        folders === null ? (
          <PageSpinner />
        ) : folders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-200/80 bg-white py-14 text-center text-sm text-neutral-400">No supplier invoice archives yet. Click "+ Manual Entry Invoice" to add one.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {folders.map((fo) => (
              <button
                key={fo.supplier}
                type="button"
                onClick={() => setFolder({ supplier: fo.supplier, name: fo.name })}
                className="group flex items-center gap-3 rounded-xl border border-neutral-200/80 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <Folder className="h-10 w-10 shrink-0 text-brand-400 group-hover:text-brand-600" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-neutral-900">{fo.name}</p>
                  <p className="text-xs text-neutral-500">
                    {fo.count} invoice{fo.count === 1 ? '' : 's'} · last {formatDate(fo.lastAt)}
                  </p>
                  <p className="mt-0.5 text-base font-bold tabular-nums text-neutral-900">{formatCurrency(fo.total)}</p>
                </div>
              </button>
            ))}
          </div>
        )
      ) : archives === null ? (
        <PageSpinner />
      ) : archives.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200/80 bg-white py-14 text-center text-sm text-neutral-400">
          {query ? 'Wax natiijo ah lama helin.' : 'No invoices here any more.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {archives.map((a) => (
            <div
              key={a.id}
              className="group flex flex-col rounded-xl border border-neutral-200/80 bg-white transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
            >
              <button
                onClick={() => setViewing(a)}
                className="flex flex-1 flex-col items-start gap-1.5 rounded-t-xl p-4 text-left focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <div className="flex w-full items-center gap-2">
                  <FileText className="h-8 w-8 shrink-0 text-brand-400 group-hover:text-brand-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-neutral-900">Serial: {a.serialNumber}</p>
                    <p className="truncate text-xs text-neutral-400">{a.archiveNumber}</p>
                  </div>
                </div>
                <div className="mt-1 flex w-full items-center gap-1.5 text-xs text-neutral-500">
                  <Building2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{a.supplierName || '(no supplier)'}</span>
                </div>
                <p className="text-xs text-neutral-400">{formatDate(a.createdAt)}</p>
                <p className="mt-1 text-base font-bold tabular-nums text-neutral-900">{formatCurrency(a.grandTotal)}</p>
              </button>
              <div className="flex flex-wrap gap-1.5 px-4 pb-2.5">
                {a.stockSerial && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-[11px] font-semibold text-brand-700">
                    <Boxes className="h-3.5 w-3.5" /> In stock · {a.stockSerial}
                  </span>
                )}
                {a.purchaseNumber ? (
                  <Link
                    to={`/purchases/${a.purchase}`}
                    className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-1 text-[11px] font-semibold text-neutral-700 hover:bg-neutral-200"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-brand-600" /> In Purchase Invoices · {a.purchaseNumber}
                  </Link>
                ) : a.supplier ? (
                  <button
                    type="button"
                    disabled={sending === a.id}
                    onClick={() => sendToPurchases(a)}
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" /> {sending === a.id ? 'Adding…' : 'Add to Purchase Invoices'}
                  </button>
                ) : (
                  <span className="text-[11px] text-neutral-400">No supplier — Edit to choose one, then add to Purchase Invoices</span>
                )}
              </div>
              {(canEdit || canManage) && (
                <div className="flex gap-1.5 border-t border-neutral-100 px-4 py-2.5">
                  {canEdit && <CardAction icon={Pencil} label="Edit" onClick={() => startEdit(a)} />}
                  {canManage && <CardAction icon={Trash2} label="Delete" danger onClick={() => startDelete(a)} />}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!showFolders && hasMore && (
        <div className="text-center">
          <Button variant="secondary" loading={loading} onClick={() => load(page + 1)}>
            Show more
          </Button>
        </div>
      )}

      <ArchiveDetailModal archive={viewing} onClose={() => setViewing(null)} canManage={canManage} canEdit={canEdit} onEdit={startEdit} onDelete={startDelete} />
      <ManualEntryModal
        open={entryOpen || !!editing}
        archive={editing}
        onClose={() => {
          setEntryOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setEntryOpen(false);
          setEditing(null);
          load();
        }}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Supplier Invoice"
        message={`Ma hubtaa inaad tirtirto invoice-ka Serial ${deleteTarget?.serialNumber} (${formatCurrency(deleteTarget?.grandTotal)})? Falkan dib looma celin karo. ${deleteTarget?.purchase ? ' Its purchase invoice is deleted too; anything paid on it goes back to the account.' : ''} ${deleteTarget?.stockEntry ? ' Stock-gii lagu helay invoice-kan (inta aan weli la iibin) Inventory-ga ayaa laga saarayaa.' : ''}`}
        confirmLabel="Confirm Delete"
        variant="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function CardAction({ icon: Icon, label, onClick, danger = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
        danger ? 'border-brand-200 text-brand-600 hover:bg-brand-50' : 'border-neutral-200 text-neutral-600 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700'
      }`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function ArchiveDetailModal({ archive, onClose, canManage, canEdit, onEdit, onDelete }) {
  if (!archive) return null;
  return (
    <Modal
      open={!!archive}
      onClose={onClose}
      title={`Serial: ${archive.serialNumber}`}
      size="lg"
      footer={
        (canEdit || canManage) && (
          <div className="flex justify-end gap-2">
            {canEdit && (
              <Button variant="secondary" onClick={() => onEdit(archive)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
            {canManage && (
              <Button variant="danger" onClick={() => onDelete(archive)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Field label="Archive No." value={archive.archiveNumber} />
          <Field label="Supplier" value={archive.supplierName || '(none)'} />
          <Field label="Date" value={formatDateTime(archive.createdAt)} />
          <Field label="Grand Total" value={archive.discount ? `${formatCurrency(archive.grandTotal)} (${formatCurrency(archive.subtotal)} − ${formatCurrency(archive.discount)} discount)` : formatCurrency(archive.grandTotal)} />
        </div>
        {archive.stockSerial && (
          <p className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
            <Boxes className="h-4 w-4 shrink-0" /> Received into stock as {archive.stockSerial}.
          </p>
        )}
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase text-neutral-500">Item Name</th>
                <th className="px-2 py-2 text-center text-xs font-medium uppercase text-neutral-500">Qty</th>
                <th className="px-2 py-2 text-right text-xs font-medium uppercase text-neutral-500">Cost</th>
                {archive.stockSerial && <th className="px-2 py-2 text-right text-xs font-medium uppercase text-neutral-500">Selling</th>}
                {archive.stockSerial && <th className="px-2 py-2 text-left text-xs font-medium uppercase text-neutral-500">Expiry</th>}
                <th className="px-3 py-2 text-right text-xs font-medium uppercase text-neutral-500">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {archive.rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 text-neutral-700">{r.itemName}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums text-neutral-600">{r.quantity}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-neutral-600">{formatCurrency(r.cost)}</td>
                  {archive.stockSerial && <td className="px-2 py-1.5 text-right tabular-nums text-neutral-600">{r.sellingPrice == null ? '—' : formatCurrency(r.sellingPrice)}</td>}
                  {archive.stockSerial && <td className="px-2 py-1.5 text-neutral-600">{r.expiryDate ? formatDate(r.expiryDate) : '—'}</td>}
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums text-neutral-900">{formatCurrency(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {archive.notes && (
          <div>
            <p className="text-xs font-medium uppercase text-neutral-400">Notes</p>
            <p className="text-sm text-neutral-600">{archive.notes}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs uppercase text-neutral-400">{label}</p>
      <p className="font-semibold text-neutral-800">{value}</p>
    </div>
  );
}

const normalName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
// No set limit; one invoice is one database record, which holds about
// 40,000 rows (the server's MAX_INVOICE_ROWS).
const MAX_ROWS = 40000;

// A pasted expiry: 2027-06-30, or 6/30/2027 (30/6/2027 when the first number
// cannot be a month). Anything else is left empty.
function pastedDate(text) {
  const t = String(text || '').trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    [, mo, d, y] = m;
    if (Number(mo) > 12) [mo, d] = [d, mo];
  } else return '';
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : '';
}

// Unsaved new invoice, kept until it is saved, so a long list survives a
// closed window or a reload.
const draftKey = () => `manual_invoice_draft:${localStorage.getItem('pos_branch') || ''}`;
function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey()) || 'null');
    return d && Array.isArray(d.rows) ? d : null;
  } catch {
    return null;
  }
}

// The item name cell: while it has focus, suggests items already in stock
// (from `known`, the list the modal loaded once -- nothing to wait for).
// `match` is the item the stock goes to, and drives the preview below the row.
function ItemNameCell({ row, match, known, onChange, onPaste, inputRef, disabled, lookup }) {
  const [active, setActive] = useState(false);
  const [hi, setHi] = useState(0); // the highlighted suggestion (arrow keys)
  const [box, setBox] = useState(null); // where the list shows, under the box
  const ownRef = useRef(null);
  const listRef = useRef(null);
  const name = normalName(row.itemName);
  const matches = useMemo(() => {
    if (!lookup || !active || !name || !known) return [];
    const found = [];
    for (const [key, item] of known) {
      if (key.startsWith(name)) found.push(item);
      if (found.length >= 50) break;
    }
    return found.sort((a, b) => Number(!normalName(a.name).startsWith(name)) - Number(!normalName(b.name).startsWith(name)) || a.name.localeCompare(b.name)).slice(0, 12);
  }, [lookup, active, name, known]);
  const showList = lookup && active && name && matches.length > 0 && !(matches.length === 1 && match?.id === matches[0].id);

  useEffect(() => setHi(0), [name]);
  // The list is drawn over the page (not inside the table, which would cut
  // it short), right under the box, and follows it when the page scrolls.
  useEffect(() => {
    if (!showList) return undefined;
    const place = () => {
      const r = ownRef.current?.getBoundingClientRect();
      if (r) setBox({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 420) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [showList]);
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const choose = (item) => {
    onChange({ itemName: item.name, sellingPrice: row.sellingPrice === '' ? String(item.sellingPrice ?? '') : row.sellingPrice });
    setActive(false);
  };

  return (
    <div className="relative" ref={ownRef}>
      <input
        ref={inputRef}
        value={row.itemName}
        disabled={disabled}
        onChange={(e) => {
          onChange({ itemName: e.target.value });
          setActive(true);
        }}
        onPaste={onPaste}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(matches[Math.min(hi, matches.length - 1)]);
          } else if (e.key === 'Escape') {
            e.stopPropagation(); // closes only the list, not the invoice window
            setActive(false);
          }
        }}
        placeholder="Item name..."
        className="w-full rounded-md border border-transparent px-2 py-1.5 text-sm outline-none focus:border-brand-300 focus:ring-1 focus:ring-brand-200 disabled:bg-transparent disabled:text-neutral-500"
      />
      {showList &&
        box &&
        createPortal(
          <div
            ref={listRef}
            style={{ position: 'fixed', top: box.top, left: box.left, width: box.width, maxHeight: `min(26rem, calc(100vh - ${box.top + 16}px))` }}
            className="z-[1000] overflow-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-2xl"
          >
            {matches.map((item, i) => (
              <button
                type="button"
                key={item.id}
                className={`block w-full px-3 py-2 text-left text-sm ${i === hi ? 'bg-brand-50 text-brand-900' : 'hover:bg-neutral-50'}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(item);
                }}
              >
                <span className="font-medium">{item.name}</span>
                <small className="block text-neutral-500">
                  {item.quantity} in stock · cost {formatCurrency(item.costPrice)}
                </small>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

// New archive, or (with `archive`) edit an existing one. A new one can also
// be received into stock in the same save (Add to stock): each row then needs
// a selling price, expiry is optional, an item already in stock gets the
// quantity added and its average cost blended, and a new name becomes a new
// item. An invoice already received keeps its items, quantities, costs and
// supplier (the stock has them); only its serial number and notes change.
function ManualEntryModal({ open, archive, onClose, onSaved }) {
  const toast = useToast();
  const { user } = useAuth();
  // The Stock page, or just "Manual Entry: add goods to stock".
  const canStock = hasPermission(user, 'stock') || hasPermission(user, 'manualEntryStock');
  const editing = !!archive;
  const received = !!archive?.stockEntry;
  const [supplier, setSupplier] = useState(null);
  const [serialNumber, setSerialNumber] = useState('');
  const [notes, setNotes] = useState('');
  // The supplier's discount on the whole invoice (what is owed is less).
  const [discount, setDiscount] = useState('');
  const [rows, setRows] = useState([emptyRow()]);
  const [addToStock, setAddToStock] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);
  const [known, setKnown] = useState(null); // normalized name -> item in stock; null until loaded
  const nameRefs = useRef({});
  const stockMode = editing ? received : addToStock;

  // Every item in stock, read once when the form opens, so whether a typed
  // name is already in stock shows at once, with no waiting while typing.
  useEffect(() => {
    if (!open || !stockMode) return undefined;
    let alive = true;
    client
      .get('/inventory/names')
      .then((res) => alive && setKnown(new Map(res.data.data.map((item) => [normalName(item.name), item]))))
      .catch(() => alive && setKnown(new Map()));
    return () => {
      alive = false;
    };
  }, [open, stockMode, editing]);

  useEffect(() => {
    if (!open) return;
    if (archive) {
      setSupplier(archive.supplier ? { id: archive.supplier, name: archive.supplierName } : null);
      setSerialNumber(archive.serialNumber);
      setNotes(archive.notes || '');
      setDiscount(archive.discount ? String(archive.discount) : '');
      setRows(
        archive.rows.map((r) => ({
          itemName: r.itemName,
          quantity: String(r.quantity),
          cost: String(r.cost),
          sellingPrice: r.sellingPrice == null ? '' : String(r.sellingPrice),
          expiryDate: r.expiryDate ? String(r.expiryDate).slice(0, 10) : '',
        }))
      );
      setRestored(false);
    } else {
      const draft = readDraft();
      setSupplier(draft?.supplier || null);
      setSerialNumber(draft?.serialNumber || '');
      setNotes(draft?.notes || '');
      setDiscount(draft?.discount || '');
      setRows(draft?.rows?.length ? draft.rows.map((r) => ({ ...emptyRow(), ...r })) : [emptyRow()]);
      setAddToStock(canStock && (draft ? draft.addToStock !== false : true));
      setRestored(!!draft);
    }
  }, [open, archive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the new invoice as a draft while it is being typed (after the
  // effect above, so a draft is read before it could be overwritten).
  useEffect(() => {
    if (!open || editing) return;
    const filled = rows.some((r) => r.itemName.trim() || r.quantity || r.cost) || serialNumber.trim() || supplier;
    try {
      if (filled) localStorage.setItem(draftKey(), JSON.stringify({ supplier, serialNumber, notes, discount, addToStock, rows }));
      else localStorage.removeItem(draftKey());
    } catch {
      // Storage full or blocked: the list just is not kept.
    }
  }, [open, editing, supplier, serialNumber, notes, discount, addToStock, rows]);

  const startOver = () => {
    setSupplier(null);
    setSerialNumber('');
    setNotes('');
    setDiscount('');
    setRows([emptyRow()]);
    setRestored(false);
  };

  // Rows copied from Excel (Item, Qty, Cost[, Selling, Expiry]) pasted into
  // an item name cell fill that row and the ones below it.
  const pasteRows = (index, e) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    const pasted = lines.map((line) => {
      const [itemName = '', quantity = '', cost = '', sellingPrice = '', expiry = ''] = line.split('\t').map((c) => c.trim());
      const num = (v) => v.replace(/[^0-9.-]/g, '');
      return { ...emptyRow(), itemName, quantity: num(quantity), cost: num(cost), sellingPrice: num(sellingPrice), expiryDate: pastedDate(expiry) };
    });
    setRows((prev) => {
      const next = [...prev.slice(0, index), ...pasted, ...prev.slice(index + pasted.length)];
      if (next.length > MAX_ROWS) toast.error(`Only ${MAX_ROWS.toLocaleString()} rows fit in one invoice; the rest were left out.`);
      return next.slice(0, MAX_ROWS);
    });
  };

  const subtotal = useMemo(() => rows.reduce((sum, r) => sum + (Number(r.quantity) || 0) * (Number(r.cost) || 0), 0), [rows]);
  const discountNum = Number(discount) || 0;
  const grandTotal = Math.max(0, subtotal - discountNum);
  // Each item goes into stock at its share of the discount off.
  const costFactor = discountNum > 0 && subtotal > 0 ? grandTotal / subtotal : 1;

  // Typing in the last row opens the next one, so Tab always has a row to go
  // to (empty rows are ignored when saving).
  const patchRow = (index, changes) =>
    setRows((prev) => {
      const next = prev.map((r, i) => (i === index ? { ...r, ...changes } : r));
      const last = next[next.length - 1];
      if (index === prev.length - 1 && next.length < MAX_ROWS && Object.values(last).some((v) => String(v ?? '').trim())) next.push(emptyRow());
      return next;
    });

  const addRow = (focus = true) => {
    if (rows.length >= MAX_ROWS) return toast.error(`One invoice holds at most ${MAX_ROWS} rows.`);
    setRows((prev) => [...prev, emptyRow()]);
    if (focus) setTimeout(() => nameRefs.current[rows.length]?.focus(), 0);
  };

  const removeRow = (index) => setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

  const handleLastCellKeyDown = (index, e) => {
    const isLastRow = index === rows.length - 1;
    if (isLastRow && e.key === 'Tab' && !e.shiftKey && rows[index].itemName.trim()) {
      e.preventDefault();
      addRow();
    }
  };

  // Enter in a box saves, the same as clicking the Save button -- except in
  // the notes (a new line), the supplier search, or when Enter picks an item
  // from the suggestions.
  const saveOnEnter = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.defaultPrevented || e.nativeEvent.isComposing || saving) return;
    const t = e.target;
    if (t.tagName !== 'INPUT' || t.form || t.closest('[data-enter-save="off"]')) return;
    e.preventDefault();
    handleSave();
  };

  const handleSave = async () => {
    if (!serialNumber.trim()) return toast.error('Enter the Shop/Supplier Serial Number.');
    const validRows = rows.filter((r) => r.itemName.trim());
    if (!validRows.length) return toast.error('Add at least one row.');
    if (validRows.length > MAX_ROWS) return toast.error(`One invoice holds at most ${MAX_ROWS} rows.`);
    const seen = new Map();
    for (const [index, r] of rows.entries()) {
      if (!r.itemName.trim()) continue;
      const at = `Row ${index + 1} (${r.itemName.trim()})`;
      if (!Number(r.quantity) || Number(r.quantity) <= 0) return toast.error(`${at}: enter a valid quantity.`);
      if (r.cost === '' || Number(r.cost) < 0) return toast.error(`${at}: enter a valid cost.`);
      if (stockMode && !editing) {
        if (!Number.isInteger(Number(r.quantity))) return toast.error(`${at}: the quantity must be a whole number to go into stock.`);
        if (r.sellingPrice === '' || Number(r.sellingPrice) < 0) return toast.error(`${at}: enter the selling price.`);
        const same = `${normalName(r.itemName)}|${r.expiryDate}`;
        if (seen.has(same)) return toast.error(`Rows ${seen.get(same)} and ${index + 1} are both "${r.itemName.trim()}" with the same expiry. Put the whole quantity on one row.`);
        seen.set(same, index + 1);
      }
    }
    if (discount !== '' && (!Number.isFinite(discountNum) || discountNum < 0)) return toast.error('Enter a valid discount.');
    if (discountNum > subtotal) return toast.error('The discount cannot be more than the invoice total.');
    const body = {
      serialNumber: serialNumber.trim(),
      discount: discountNum,
      supplierId: supplier?.id || null,
      rows: validRows.map((r) => ({
        itemName: r.itemName.trim(),
        quantity: Number(r.quantity),
        cost: Number(r.cost),
        ...(stockMode && !editing ? { sellingPrice: Number(r.sellingPrice), expiryDate: r.expiryDate || null } : {}),
        // Received into stock: the selling price can be corrected too.
        ...(editing && received && r.sellingPrice !== '' ? { sellingPrice: Number(r.sellingPrice) } : {}),
      })),
      notes,
      ...(stockMode && !editing ? { addToStock: true } : {}),
    };
    setSaving(true);
    try {
      if (editing) {
        const res = await client.put(`/supplier-invoice-archives/${archive.id}`, body);
        toast.success(res.data.data.purchaseNumber ? `Serial ${body.serialNumber} updated — ${res.data.data.purchaseNumber} updated too.` : `Serial ${body.serialNumber} updated.`);
      } else {
        const res = await client.post('/supplier-invoice-archives', body);
        const d = res.data.data;
        const parts = [`${d.archiveNumber} saved`];
        if (d.stockSerial) parts.push(`${body.rows.length} item(s) added to stock (${d.stockSerial})`);
        if (d.purchaseNumber) parts.push(`added to Purchase Invoices as ${d.purchaseNumber} (${formatCurrency(d.grandTotal)} owed)`);
        toast.success(`${parts.join(' — ')}.`);
        try {
          localStorage.removeItem(draftKey());
        } catch {
          // nothing kept to remove
        }
      }
      onSaved();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save this invoice.');
    } finally {
      setSaving(false);
    }
  };

  const cell = 'no-spinner w-full rounded-md border border-neutral-200 px-2 py-1.5 text-sm tabular-nums focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-200 disabled:bg-neutral-50 disabled:text-neutral-500';
  const head = 'px-2 py-2 text-xs font-medium uppercase tracking-wide text-neutral-500';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit Invoice — ${archive.archiveNumber}` : 'Manual Entry Invoice'}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            <Save className="h-4 w-4" /> {editing ? 'Save Changes' : stockMode ? 'Save & Add to Stock' : 'Save Archive'}
          </Button>
        </>
      }
    >
      <div className="space-y-4" onKeyDown={saveOnEnter}>
        <p className="text-sm text-neutral-500">
          Enter exactly what the supplier's paper invoice shows. With a supplier chosen, it is also added to Purchase Invoices (serial number and grand total, owed) — no need to enter it twice.
        </p>
        {editing ? (
          received && (
            <p className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
              <Boxes className="h-4 w-4 shrink-0" /> Received into stock ({archive.stockSerial}). Quantities and supplier stay as they are (correct a quantity with Stock Adjustment). Item names, costs, selling prices and the discount can be corrected: a corrected name moves those units to the right item; what is owed, the stock's value and the profit follow.
            </p>
          )
        ) : canStock ? (
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 px-3 py-2.5 hover:border-brand-300">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" checked={addToStock} onChange={(e) => setAddToStock(e.target.checked)} />
            <span className="text-sm">
              <span className="font-semibold text-neutral-800">Add to stock</span>
              <span className="block text-neutral-500">
                Each item goes into stock now: an item already in stock gets the quantity added and its average cost recalculated; a new name becomes a new item. Enter the selling price (and expiry) for each row.
              </span>
            </span>
          </label>
        ) : null}
        {restored && (
          <p className="flex items-center justify-between gap-3 rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
            Your unsaved invoice was kept and is back.
            <button type="button" onClick={startOver} className="font-semibold text-brand-600 hover:underline">
              Start over
            </button>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier (optional)">
            {received ? (
              <Input value={supplier?.name || '(none)'} disabled />
            ) : (
              <div data-enter-save="off">
                <SupplierPicker active={supplier} onSelect={setSupplier} onClear={() => setSupplier(null)} />
              </div>
            )}
          </FormField>
          <FormField label="Shop/Supplier Serial Number" required>
            <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
          </FormField>
        </div>

        <div className="max-h-[420px] overflow-auto rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-neutral-50">
              <tr>
                <th className={`${head} min-w-48 text-left`}>Item Name</th>
                <th className={`${head} w-20 text-center`}>Qty</th>
                <th className={`${head} w-24 text-right`}>Cost</th>
                {stockMode && <th className={`${head} w-24 text-right`}>Selling</th>}
                {stockMode && <th className={`${head} w-36 text-left`}>Expiry</th>}
                <th className={`${head} w-24 text-right`}>Total</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 bg-white">
              {rows.map((row, i) => {
                const match = stockMode && !editing ? known?.get(normalName(row.itemName)) : null;
                const preview =
                  match && row.quantity && row.cost !== ''
                    ? previewWeightedAverageCost({ currentQuantity: match.quantity, currentAverageCost: match.costPrice, incomingQuantity: row.quantity, incomingUnitCost: (Number(row.cost) || 0) * costFactor })
                    : null;
                const lastInput = stockMode ? 'expiryDate' : 'cost';
                return (
                  <Fragment key={i}>
                    <tr>
                      <td className="px-2 py-1.5">
                        <ItemNameCell
                          row={row}
                          match={match}
                          known={known}
                          onPaste={(e) => pasteRows(i, e)}
                          lookup={stockMode}
                          disabled={false}
                          inputRef={(el) => {
                            nameRefs.current[i] = el;
                          }}
                          onChange={(changes) => patchRow(i, changes)}
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <input type="number" min="0" step="1" disabled={received} value={row.quantity} onChange={(e) => patchRow(i, { quantity: e.target.value })} className={`${cell} text-center`} />
                      </td>
                      <td className="px-1 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          disabled={false}
                          value={row.cost}
                          onChange={(e) => patchRow(i, { cost: e.target.value })}
                          onKeyDown={(e) => lastInput === 'cost' && handleLastCellKeyDown(i, e)}
                          className={`${cell} text-right`}
                        />
                      </td>
                      {stockMode && (
                        <td className="px-1 py-1.5">
                          <input type="number" min="0" step="0.01" disabled={editing && !received} value={row.sellingPrice} onChange={(e) => patchRow(i, { sellingPrice: e.target.value })} className={`${cell} text-right`} />
                        </td>
                      )}
                      {stockMode && (
                        <td className="px-1 py-1.5">
                          <input
                            type="date"
                            disabled={editing}
                            value={row.expiryDate}
                            onChange={(e) => patchRow(i, { expiryDate: e.target.value })}
                            onKeyDown={(e) => handleLastCellKeyDown(i, e)}
                            className={cell}
                          />
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-right text-sm font-semibold tabular-nums text-neutral-900">{formatCurrency((Number(row.quantity) || 0) * (Number(row.cost) || 0))}</td>
                      <td className="px-1 py-1.5 text-center">
                        {!received && (
                          <button type="button" tabIndex={-1} onClick={() => removeRow(i)} className="rounded-md p-1.5 text-neutral-300 hover:bg-brand-50 hover:text-brand-600">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                    {stockMode && !editing && known && row.itemName.trim() && (
                      <tr className="bg-brand-50/60">
                        <td colSpan={7} className="px-3 pb-2 pt-1 text-xs text-brand-700">
                          {preview ? (
                            <>
                              {match.name}: {preview.currentQuantity} in stock → {preview.projectedQuantity}. Average cost {formatCurrency(preview.currentAverageCost)} →{' '}
                              <strong>{formatCurrency(preview.projectedAverageCost)}</strong>.
                            </>
                          ) : match ? (
                            <>
                              {match.name}: {match.quantity} in stock, average cost {formatCurrency(match.costPrice)}.
                            </>
                          ) : (
                            <>New item — “{row.itemName.trim()}” is created on save.</>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between">
          {!received ? (
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => addRow()} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50">
                <Plus className="h-3.5 w-3.5" /> Add Row
              </button>
              <span className="text-xs text-neutral-400">
                {rows.filter((r) => r.itemName.trim()).length.toLocaleString()} rows · no limit · paste from Excel into an item name
              </span>
            </div>
          ) : (
            <span />
          )}
          <div className="space-y-1 text-right">
            <div className="flex items-center justify-end gap-3 text-sm text-neutral-600">
              <span>Total</span>
              <span className="w-28 tabular-nums">{formatCurrency(subtotal)}</span>
            </div>
            <label className="flex items-center justify-end gap-3 text-sm text-neutral-600">
              <span>Discount</span>
              <input
                type="text"
                inputMode="decimal"
                value={discount}
                disabled={false}
                onFocus={(e) => e.target.select()}
                onChange={(e) => {
                  const v = e.target.value.replace(',', '.');
                  if (/^\d*\.?\d{0,2}$/.test(v)) setDiscount(v);
                }}
                placeholder="0.00"
                className="w-28 rounded-md border border-neutral-200 px-2 py-1 text-right tabular-nums focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-200 disabled:bg-neutral-50"
              />
            </label>
            <p className="text-xs uppercase text-neutral-400">Grand Total{discountNum > 0 ? ' (we owe the supplier)' : ''}</p>
            <p className="text-lg font-bold text-neutral-900">{formatCurrency(grandTotal)}</p>
          </div>
        </div>

        <FormField label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Optional" />
        </FormField>
      </div>
    </Modal>
  );
}
