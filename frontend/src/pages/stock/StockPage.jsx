import { useEffect, useRef, useState } from 'react';
import { useListKeys } from '../../hooks/useListKeys.js';

import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import client from '../../api/client.js';

import Button from '../../components/ui/Button.jsx';

import { useToast } from '../../context/ToastContext.jsx';

import { BUSINESS } from '../../constants/business.js';

import SharePdfButton from '../../components/SharePdfButton.jsx';
import ClearAllButton from '../../components/ClearAllButton.jsx';
import { readSheetFile, stockColumns } from '../../utils/readSheetFile.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { showBulkTools } from '../../constants/permissions.js';
import DocHeader, { DocInfo, DocSummary, DOC_TH, DOC_THEAD_ROW, docRow } from '../../components/docs/DocHeader.jsx';

import { printPage } from '../../utils/print.js';

import { formatCurrency, formatDateTime } from '../../utils/format.js';

import { previewWeightedAverageCost } from '../../utils/wac.js';

const blank = () => ({ key: crypto.randomUUID(), name: '', itemId: '', quantity: '', costPrice: '', sellingPrice: '', expiryDate: '' });

// There is no limit on how many rows can be entered: they are sent in parts
// of PART rows, and one Stock Serial holds up to ENTRY_ROWS rows (the server's
// MAX_ENTRY_ROWS) -- a longer list simply gets the next serial.
const PART = 1000;
const ENTRY_ROWS = 40000;

// Only the rows in view are drawn (each row is ROW_H tall), so a list of a
// hundred thousand rows scrolls as easily as ten.
const ROW_H = 74;
const VIEW_H = 600;

const normalName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

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

const isUsed = r => r.name || r.quantity || r.costPrice !== '' || r.sellingPrice !== '' || r.expiryDate;

// The server's checks, done first so a long list is never half saved
// because of a typing mistake further down. Only the name is needed: a list
// of names just adds the items. What is typed must still be valid.
function rowProblem(r) {
  if (!r.itemId && !String(r.name || '').trim()) return 'select or name an item';
  if (r.quantity !== '' && !Number.isSafeInteger(Number(r.quantity))) return 'quantity must be a whole number (minus is allowed, e.g. -10)';
  if (r.costPrice !== '' && (!Number.isFinite(Number(r.costPrice)) || Number(r.costPrice) < 0)) return 'enter a valid cost';
  if (r.sellingPrice !== '' && (!Number.isFinite(Number(r.sellingPrice)) || Number(r.sellingPrice) < 0)) return 'enter a valid selling price';
  return '';
}

// The rows being typed are kept in this browser until they are saved, so a
// refresh, an expired sign-in or a failed save never loses them.
const draftKey = () => `stock_draft:${localStorage.getItem('pos_branch') || ''}`;

function readDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey())) || null; } catch { return null; }
}

function writeDraft(draft) {
  try {
    if (draft.rows.some(isUsed) || draft.externalSerialNumber || draft.supplierId) localStorage.setItem(draftKey(), JSON.stringify(draft));
    else localStorage.removeItem(draftKey());
  } catch {
    // Storage full or blocked: the rows stay on screen, just not kept.
  }
}

function SupplierInput({ supplierId, supplierName, onChange }) {

  const [query, setQuery] = useState(supplierName || '');

  const [matches, setMatches] = useState([]);

  const [active, setActive] = useState(false);

  useEffect(() => { setQuery(supplierName || ''); }, [supplierName]);

  useEffect(() => {

    let alive = true;

    const timer = setTimeout(() => { if (query && query !== supplierName) client.get('/suppliers/search', { params: { q: query } }).then(r => { if (alive) setMatches(r.data.data); }).catch(() => { if (alive) setMatches([]); }); }, 180);

    return () => { alive = false; clearTimeout(timer); };

  }, [query, supplierName]);

  const choose = s => { onChange(s.id, s.name); setQuery(s.name); setActive(false); };
  const kb = useListKeys();

  return <div className="relative max-w-sm">

    <label className="mb-1 block text-sm font-medium text-neutral-700">Supplier (optional)</label>

    <input className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition-colors hover:border-neutral-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100" placeholder="Search supplier..." value={query} onKeyDown={kb.onKeyDown} onFocus={() => setActive(true)} onBlur={() => setActive(false)} onChange={e => { setQuery(e.target.value); if (supplierId) onChange('', ''); }} />

    {active && query && query !== supplierName && <div ref={kb.listRef} className="absolute z-20 max-h-56 w-full overflow-auto rounded-xl border border-neutral-200 bg-white shadow-xl">{matches.map(s => <button type="button" key={s.id} className="block w-full p-2 text-left hover:bg-brand-50" onMouseDown={e => { e.preventDefault(); choose(s); }}>{s.name}{s.phone ? <small className="block text-neutral-500">{s.phone}</small> : null}</button>)}{!matches.length && <p className="p-2 text-sm text-neutral-400">No matching suppliers</p>}</div>}

    <p className="mt-1 text-xs text-neutral-500">Links this stock entry to a supplier so a Supplier Invoice can be generated from it.</p>

  </div>;

}

function ItemInput({ row, update, inputRef, onPaste, taken }) {
  const kb = useListKeys();

  const [matches, setMatches] = useState([]);

  const [active, setActive] = useState(false);

  useEffect(() => {

    let alive = true;

    // Only the row being typed in searches (a pasted list does not).
    const timer = setTimeout(() => { if (active && row.name && !row.itemId) client.get('/inventory/search', { params: { q: row.name } }).then(r => { if (alive) setMatches(r.data.data); }).catch(() => { if (alive) setMatches([]); }); }, 180);

    return () => { alive = false; clearTimeout(timer); };

  }, [row.name, row.itemId, active]);

  const choose = item => { update({ itemId: item.id, name: item.name, costPrice: item.costPrice, sellingPrice: item.sellingPrice, currentQuantity: item.quantity, currentAvgCost: item.costPrice }); setActive(false); };

  return <div className="relative min-w-60"><input ref={inputRef} className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition-colors hover:border-neutral-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100" aria-label="Item name" placeholder="Search item..." value={row.name} onPaste={onPaste} onFocus={() => setActive(true)} onBlur={() => setActive(false)} onChange={e => { update({ name: e.target.value, itemId: '' }); setActive(true); }} onKeyDown={kb.onKeyDown} />

    {active && row.name && !row.itemId && <div ref={kb.listRef} className="absolute z-20 max-h-56 w-full overflow-auto rounded-xl border border-neutral-200 bg-white shadow-xl">{matches.map(item => <button type="button" key={item.id} className="block w-full p-2 text-left hover:bg-brand-50" onMouseDown={e => { e.preventDefault(); choose(item); }}>{item.name}<small className="block text-neutral-500">{item.itemCode} · {item.availableQuantity} available</small></button>)}{!taken && <button type="button" className="w-full p-2 text-left text-brand-700" onMouseDown={e => { e.preventDefault(); setActive(false); }}>+ Create “{row.name}” on save</button>}</div>}

  </div>;

}

export default function StockPage() {

  const toast = useToast();
  const [params] = useSearchParams();

  const [draft] = useState(readDraft);

  const [rows, setRows] = useState(() => (draft?.rows?.length ? draft.rows : [blank()]));

  const [externalSerialNumber, setExternalSerialNumber] = useState(draft?.externalSerialNumber || '');

  const [supplierId, setSupplierId] = useState(draft?.supplierId || '');

  const [supplierName, setSupplierName] = useState(draft?.supplierName || '');

  useEffect(() => {

    const timer = setTimeout(() => writeDraft({ rows, externalSerialNumber, supplierId, supplierName }), rows.length > 2000 ? 2000 : 400);

    return () => clearTimeout(timer);

  }, [rows, externalSerialNumber, supplierId, supplierName]);

  useEffect(() => { if (draft?.rows?.some(isUsed)) toast.success(`Restored ${draft.rows.filter(isUsed).length} unsaved stock row(s).`); }, []);

  const [saving, setSaving] = useState(false);

  const [progress, setProgress] = useState(null);

  const [query, setQuery] = useState(params.get('q') || '');

  const [entries, setEntries] = useState([]);

  const [selected, setSelected] = useState(null);

  const loadTicket = useRef(0);

  const [total, setTotal] = useState(0);

  const refs = useRef({});

  const grid = useRef(null);

  const [scrollTop, setScrollTop] = useState(0);

  // Every item in stock, read once: whether a typed or pasted name is already
  // in stock (and its average cost) shows without a search per row.
  const [known, setKnown] = useState(() => new Map());

  const loadNames = () => client.get('/inventory/names').then(r => setKnown(new Map(r.data.data.map(i => [normalName(i.name), i])))).catch(() => {});

  useEffect(() => { loadNames(); }, []);

  // The rows the last save refused because their name is already saved or
  // repeated, so a long pasted list can be cleaned with one click.
  const [refused, setRefused] = useState([]);

  const removeRefused = () => { const drop = new Set(refused); setRows(previous => { const left = previous.filter(r => !drop.has(r.key)); return left.length ? left : [blank()]; }); setRefused([]); };

  // Shows row `index` (scrolling to it if it is out of view) and focuses it.
  const focusRow = index => {
    const el = grid.current;
    if (el && (index * ROW_H < el.scrollTop || (index + 1) * ROW_H > el.scrollTop + el.clientHeight - 40)) el.scrollTop = Math.max(0, index * ROW_H - el.clientHeight / 2);
    setTimeout(() => setRows(current => { refs.current[current[index]?.key]?.focus(); return current; }), 60);
  };

  // Rows copied from Excel (Item, Qty, Cost, Selling, Expiry) pasted into an
  // item box fill that row and as many new rows as were copied.
  const pasteRows = (index, e) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    pasteText(index, text);
  };
  const pasteText = (index, text) => {
    // 1.1499999999999999 (how Excel stores 1.15) -> 1.15
    const num = v => { const t = String(v || '').replace(/[^0-9.-]/g, ''); return t !== '' && Number.isFinite(Number(t)) ? String(parseFloat(Number(t).toPrecision(12))) : t; };
    const isNumber = t => /^[-$]?[\d,]*\.?\d+$/.test(t);
    const isDate = t => !!pastedDate(t);
    // A line from Excel has tabs between the columns. Copied from somewhere
    // else the columns may only be spaces: then the numbers (and a date) at
    // the end of the line are Qty, Cost, Selling (Expiry), the rest is the name.
    const cellsOf = line => {
      if (line.includes('\t')) return line.split('\t').map(c => c.trim());
      const words = line.trim().split(/\s+/);
      let expiry = '';
      if (words.length > 1 && isDate(words[words.length - 1])) expiry = words.pop();
      const nums = [];
      while (words.length > 1 && nums.length < 3 && isNumber(words[words.length - 1])) nums.unshift(words.pop());
      return [words.join(' '), ...nums, ...Array(3 - nums.length).fill(''), expiry];
    };
    const pasted = text.replace(/\r/g, '').split('\n').filter(l => l.trim()).map(cellsOf)
      .filter(([name]) => name && !/^item(\s+qty\b.*)?$/i.test(name)) // the header row, if copied
      .map(([name = '', quantity = '', costPrice = '', sellingPrice = '', expiry = '']) => ({ ...blank(), name, quantity: num(quantity), costPrice: num(costPrice), sellingPrice: num(sellingPrice), expiryDate: pastedDate(expiry) }));
    if (!pasted.length) return toast.error('Nothing to paste: copy the rows in Excel first (Ctrl+C).');
    setRows(previous => [...previous.slice(0, index), ...pasted, ...previous.slice(index + 1)]);
    toast.success(`${pasted.length.toLocaleString()} rows pasted.`);
  };
  // Where a paste from outside the table goes: the first empty row.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const firstEmpty = () => { const i = rowsRef.current.findIndex(r => !isUsed(r)); return i === -1 ? rowsRef.current.length : i; };
  // Ctrl+V anywhere on the page (not in another box) pastes the Excel rows.
  const pasteAnywhere = useRef(null);
  pasteAnywhere.current = (e) => {
    const t = e.target;
    if (t && (t.closest?.('input, textarea, select, [contenteditable="true"]'))) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    pasteText(firstEmpty(), text);
  };
  useEffect(() => {
    const onPaste = (e) => pasteAnywhere.current?.(e);
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);
  // The "Paste from Excel" box: a plain text box the rows are pasted into
  // with Ctrl+V -- works in every browser, however the rows were copied.
  const [pasteBox, setPasteBox] = useState(false);
  // "Import Excel file": the rows are read straight from the .xlsx / .csv
  // file (Item, Qty, Cost, Selling, Expiry) -- no copying needed.
  const fileInput = useRef(null);
  const { user: me } = useAuth();
  const canImport = showBulkTools(me); // Super Admin, once switched on in Settings
  // Rows from an imported Excel file are opening stock (owned before the
  // system): their quantities go in, counted as Opening stock in equity.
  const [opening, setOpening] = useState(false);
  const importFile = async (file) => {
    if (!file) return;
    try {
      const sheet = stockColumns(await readSheetFile(file));
      if (!sheet.some(r => String(r[0] || '').trim())) return toast.error(`No item names found in ${file.name}. The sheet needs a column of item names (titled Item or Name), with Qty, Cost, Selling and Expiry beside it.`);
      pasteText(firstEmpty(), sheet.map(r => r.join('\t')).join('\n'));
      setOpening(true);
    } catch (err) {
      toast.error(err.message || 'Could not read this file.');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  // Opened from "Import Excel file" on the Inventory page: read that file.
  const location = useLocation();
  const goTo = useNavigate();
  useEffect(() => {
    const file = location.state?.importFile;
    if (!file) return;
    goTo(location.pathname + location.search, { replace: true, state: null });
    if (canImport) importFile(file);
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const pasteFromBox = (value) => {
    if (!value.trim()) return;
    pasteText(firstEmpty(), value);
    setPasteBox(false);
  };

  // Every stock entry on one long page (newest first), read 50 at a time.
  const load = async () => { const ticket = ++loadTicket.current; try { let all = []; for (let p = 1; ; p += 1) { const r = await client.get('/stock', { params: { q: query, page: p } }); if (ticket !== loadTicket.current) return; all = all.concat(r.data.data); setEntries(all); setTotal(r.data.total); if (all.length >= r.data.total || !r.data.data.length) break; } if (query) { const exact = all.find(e => e.stockSerial === query || e.externalSerialNumber === query); if (exact) setSelected(exact); } } catch (e) { toast.error(e.friendlyMessage || 'Could not load stock.'); } };

  useEffect(() => { const timer = setTimeout(load, 200); return () => clearTimeout(timer); }, [query]);

  const update = (key, changes) => setRows(previous => previous.map(r => r.key === key ? { ...r, ...changes } : r));

  const add = () => { const row = blank(); setRows(previous => [...previous, row]); setTimeout(() => { if (grid.current) grid.current.scrollTop = grid.current.scrollHeight; setTimeout(() => refs.current[row.key]?.focus(), 60); }, 0); };

  const clearRows = () => setRows([blank()]);
  // Empties the whole form: every typed or pasted row, the serial and the supplier.
  const clearForm = () => { setRows([blank()]); setExternalSerialNumber(''); setSupplierId(''); setSupplierName(''); try { localStorage.removeItem(draftKey()); } catch { /* blocked */ } };

  async function save() {

    const used = rows.filter(isUsed);

    if (!used.length) return toast.error('Enter at least one stock row.');

    const bad = used.find(rowProblem);

    const rowNo = new Map(rows.map((r, i) => [r, i + 1]));

    if (bad) return toast.error(`Row ${rowNo.get(bad)}${bad.name ? ` (${bad.name})` : ''}: ${rowProblem(bad)}.`);

    // A typed name is a new item: it cannot be one already saved, or be on the
    // list twice. Picking the item from the search still receives more of it.
    const typedNames = new Set();
    const nameClashes = [];

    for (const r of used) {

      if (r.itemId) continue;

      const key = normalName(r.name);

      if (known.has(key) || typedNames.has(key)) nameClashes.push(r);

      typedNames.add(key);

    }

    setRefused(nameClashes.map(r => r.key));

    if (nameClashes.length) {

      const shown = nameClashes.slice(0, 5).map(r => `${r.name} (row ${rowNo.get(r)})`).join(', ');

      return toast.error(`${nameClashes.length.toLocaleString()} name${nameClashes.length === 1 ? ' is' : 's are'} already saved or on the list twice: ${shown}${nameClashes.length > 5 ? ', ...' : ''}. A name can only be saved once. To receive more of an item, pick it from the search.`);

    }

    // The same item twice (same expiry) would be received twice; a second
    // expiry date is a separate batch and is fine.
    const seen = new Map();

    for (const r of used) {

      if (!(Number(r.quantity) > 0)) continue; // names only: nothing is received, so a repeat does no harm

      const id = `${r.itemId || String(r.name).trim().toLowerCase().replace(/\s+/g, ' ')}|${r.expiryDate || ''}`;

      if (seen.has(id)) return toast.error(`Row ${rowNo.get(seen.get(id))} and row ${rowNo.get(r)} are both ${r.name}${r.expiryDate ? ` (expiry ${r.expiryDate})` : ''}. Put the whole quantity on one row and remove the other.`);

      seen.set(id, r);

    }

    setSaving(true);

    setProgress({ done: 0, total: used.length });

    let entryId = null, entryRows = 0, saved = 0, last = null;

    const serials = [];

    try {

      for (let i = 0; i < used.length; i += PART) {

        const part = used.slice(i, i + PART);

        if (entryRows + part.length > ENTRY_ROWS) { entryId = null; entryRows = 0; }

        // No quantities: stock comes in only on a Supplier Invoice (items and
        // prices here) -- except opening stock imported from Excel.
        const result = await client.post('/stock', { rows: opening ? part : part.map((r) => ({ ...r, quantity: '' })), ...(opening ? { opening: true } : {}), externalSerialNumber, supplierId: supplierId || undefined, appendTo: entryId || undefined });

        last = result.data.data;

        if (!entryId) serials.push(last.stockSerial);

        entryId = last._id; entryRows += part.length; saved += part.length;

        // Saved rows leave the grid at once, so a failure later on leaves
        // exactly the rows still to save.
        const done = new Set(part.map(r => r.key));

        setRows(previous => { const left = previous.filter(r => !done.has(r.key)); return left.length ? left : [blank()]; });

        setProgress({ done: saved, total: used.length });

      }

      setSelected(last); try { localStorage.removeItem(draftKey()); } catch { /* blocked */ } setRows([blank()]); setExternalSerialNumber(''); setSupplierId(''); setSupplierName(''); loadNames(); await load();

      toast.success(serials.length === 1 ? `Stock entry ${serials[0]} created (${saved} rows).` : `${saved} rows saved as ${serials.join(', ')}.`);

    }

    catch (e) {

      toast.error(`${saved ? `${saved} of ${used.length} rows were saved (${serials.join(', ')}); the rest are still here -- press Create Stock again. ` : ''}${e.friendlyMessage || 'Could not create stock.'}`);

      loadNames();

      if (saved) { setSelected(last); load(); }

    } finally { setSaving(false); setProgress(null); }

  }

  return <div className="space-y-5">

    <section className="no-print space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">Stock</p><h1 className="mt-1 text-[26px] font-extrabold leading-tight tracking-tight text-neutral-950" style={{ fontFamily: 'var(--font-display)' }}>Receive stock</h1><p className="mt-1 text-sm text-neutral-500">Add items and their prices. Stock itself is added from <Link to="/supplier-invoices" className="font-semibold text-brand-700 underline">Supplier Invoices → Manual Entry Invoice</Link>, which also records what is owed to the supplier.</p>{opening && <p className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-800">Opening stock from Excel: these quantities are stock the company already had. Their value is counted as <b>Opening stock</b> in the Balance Sheet's equity, so it stays balanced.</p>}</div><ClearAllButton onStart={clearForm} url="/inventory/clear" describe={(d) => `Deleted ${d.items || 0} item(s) and ${d.stockEntries || 0} stock receipt(s).`} onDone={() => { setSelected(null); load(); loadNames(); }} /></div>

      <div className="flex flex-wrap gap-4">
        <div className="max-w-sm"><label className="mb-1 block text-sm font-medium text-neutral-700">Shop / Supplier Serial Number</label><input aria-label="Shop / Supplier Serial Number" className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition-colors hover:border-neutral-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100" placeholder="e.g. ABC-INV-93822 (the shop's own invoice/serial)" value={externalSerialNumber} onChange={e => setExternalSerialNumber(e.target.value)} /><p className="mt-1 text-xs text-neutral-500">The supplier's own receipt/invoice number. Separate from our internal Stock Serial, which is generated on save.</p></div>
        <SupplierInput supplierId={supplierId} supplierName={supplierName} onChange={(id, name) => { setSupplierId(id); setSupplierName(name); }} />
      </div>

      {(() => {
        const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
        const last = Math.min(rows.length, first + Math.ceil(VIEW_H / ROW_H) + 20);
        return <div ref={grid} onPaste={e => { if (e.defaultPrevented) return; const tr = e.target.closest?.('tr[data-row]'); if (tr) pasteRows(Number(tr.dataset.row), e); }} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ maxHeight: VIEW_H }} className="overflow-auto rounded-2xl border border-neutral-200/80 bg-white px-2 pb-2"><table className="w-full text-sm"><thead className="sticky top-0 z-10 bg-white"><tr>{['#', 'Item', 'Qty', 'Cost', 'Selling', 'Expiry', ''].map((h, i) => <th key={i} className="px-2 pb-1 pt-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500">{h}</th>)}</tr></thead><tbody>
          {first > 0 && <tr style={{ height: first * ROW_H }} />}
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const found = row.itemId ? { name: row.name, quantity: row.currentQuantity, costPrice: row.currentAvgCost } : known.get(normalName(row.name));
            const preview = found && row.quantity && row.costPrice !== '' ? previewWeightedAverageCost({ currentQuantity: found.quantity, currentAverageCost: found.costPrice, incomingQuantity: row.quantity, incomingUnitCost: row.costPrice }) : null;
            return <tr key={row.key} data-row={index} style={{ height: ROW_H }} className="align-top">
              <td className="w-10 px-1 pt-4 text-right text-xs tabular-nums text-neutral-400">{index + 1}</td>
              <td className="px-2 pt-2"><ItemInput row={row} taken={!row.itemId && !!found} update={changes => update(row.key, changes)} onPaste={e => pasteRows(index, e)} inputRef={el => { refs.current[row.key] = el; }} /><p className="mt-0.5 h-4 truncate px-1 text-[11px] text-brand-700">{!row.itemId && found ? <span className="text-red-600">Already saved: pick it from the search</span> : preview ? <>{found.name}: {preview.currentQuantity} → {preview.projectedQuantity} · avg {formatCurrency(preview.currentAverageCost)} → <strong>{formatCurrency(preview.projectedAverageCost)}</strong></> : found ? `${found.name}: ${found.quantity} in stock` : row.name ? <span className="text-neutral-400">New item</span> : ''}</p></td>
              {['quantity', 'costPrice', 'sellingPrice', 'expiryDate'].map(field => <td key={field} className="px-2 pt-2"><input aria-label={`Row ${index + 1} ${field}`} type={field === 'expiryDate' ? 'date' : 'number'} min={field === 'quantity' ? undefined : 0} step={field === 'quantity' ? 1 : '0.01'} className="w-full min-w-24 rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition-colors hover:border-neutral-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100" value={field === 'quantity' && !opening ? '' : row[field]} disabled={field === 'quantity' && !opening} placeholder={field === 'quantity' && !opening ? 'Supplier Invoices' : undefined} title={field === 'quantity' && !opening ? 'Stock is added from Supplier Invoices → Manual Entry Invoice' : undefined} onChange={e => update(row.key, { [field]: e.target.value })} onKeyDown={e => { if (field === 'expiryDate' && e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); if (index === rows.length - 1) add(); else focusRow(index + 1); } }} /></td>)}
              <td className="px-1 pt-3"><button className="rounded-lg px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-brand-600" aria-label={`Remove row ${index + 1}`} onClick={() => setRows(previous => previous.length === 1 ? [blank()] : previous.filter(r => r.key !== row.key))}>×</button></td>
            </tr>;
          })}
          {last < rows.length && <tr style={{ height: (rows.length - last) * ROW_H }} />}
        </tbody></table></div>;
      })()}

      <p className="text-xs text-neutral-500">{rows.filter(isUsed).length.toLocaleString()} rows · no limit. Copy rows in Excel (Item, Qty, Cost, Selling, Expiry), then press Ctrl+V in any box of the table, or press Paste from Excel. Press Tab after Expiry to continue to the next row. Stock Serial: automatically generated on save.</p><div className="flex gap-3">{refused.length > 0 && <Button variant="secondary" onClick={removeRefused} disabled={saving}>Remove {refused.length.toLocaleString()} repeated</Button>}{canImport && <><input ref={fileInput} type="file" accept=".xlsx,.csv,.txt" className="hidden" onChange={e => importFile(e.target.files?.[0])} /><Button onClick={() => fileInput.current?.click()} disabled={saving}>Import Excel file</Button></>}<Button variant="secondary" onClick={() => setPasteBox(v => !v)} disabled={saving}>Paste from Excel</Button><Button variant="secondary" onClick={add}>+ Add Row</Button>{rows.length > 1 && <Button variant="secondary" onClick={clearRows} disabled={saving}>Clear rows</Button>}<Button onClick={save} loading={saving}>{progress && progress.total > PART ? `Saving ${progress.done} / ${progress.total}…` : 'Create Stock'}</Button></div>

      {pasteBox && (
        <div className="rounded-2xl border-2 border-dashed border-brand-300 bg-brand-50 p-3">
          <p className="mb-2 text-sm font-semibold text-brand-800">Click in the box below and press Ctrl+V. The rows go into the table straight away.</p>
          <textarea autoFocus rows={4} className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100" placeholder="Ctrl+V here" onChange={e => pasteFromBox(e.target.value)} />
        </div>
      )}

      <h2 className="pt-2 text-lg font-bold text-neutral-950" style={{ fontFamily: 'var(--font-display)' }}>Stock history</h2><input aria-label="Search stock" className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition-colors hover:border-neutral-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100" placeholder="Search product name, stock serial, or shop/supplier serial" value={query} onChange={e => setQuery(e.target.value)} />

      <div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-200/80 bg-white">{entries.map(entry => <button key={entry._id} onClick={() => setSelected(entry)} className="block w-full px-4 py-3 text-left transition-colors hover:bg-neutral-50"><strong className="text-neutral-950">{entry.stockSerial}</strong>{entry.externalSerialNumber && <span className="ml-2 text-neutral-500">· Shop Serial: {entry.externalSerialNumber}</span>} · {formatDateTime(entry.createdAt)}<span className="block text-sm text-neutral-500">{entry.rows.map(r => `${r.itemName} (${r.quantity} received, ${r.batch?.remainingQuantity ?? r.quantity} remaining)`).join(' · ')}</span></button>)}{!entries.length && <p className="p-3">No stock entries found.</p>}</div><p className="text-sm text-neutral-500">{entries.length} of {total} entries</p>

    </section>

    {selected && <>
      <div className="no-print flex gap-2">
        <SharePdfButton fileName={`Stock-Entry-${selected.stockSerial}`} message={`${BUSINESS.name} — stock entry ${selected.stockSerial}`} />
        <Button onClick={() => printPage('A4')}>Print Stock Entry</Button>
      </div>
      <section id="print-area" className="mt-3 rounded-2xl border border-neutral-200/80 bg-white p-6 text-neutral-900 sm:p-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <DocHeader title="Stock Entry" meta={<span className="font-semibold">{selected.stockSerial}</span>} />
        <DocInfo
          left={['Supplier', selected.supplier?.name || '—', selected.externalSerialNumber && `Shop/Supplier serial: ${selected.externalSerialNumber}`]}
          right={['Date', formatDateTime(selected.createdAt)]}
        />
        <table className="mt-4 w-full border-collapse text-xs">
          <thead>
            <tr className={DOC_THEAD_ROW + ' text-left'}>
              {['#', 'Item', 'Qty', 'Cost', 'Selling', 'Expiry'].map((h, i) => <th key={h} className={DOC_TH + (i >= 2 && i <= 4 ? ' text-right' : '')}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {selected.rows.map((r, i) => (
              <tr key={i} className={docRow(i)}>
                <td className="px-2 py-2 text-neutral-500">{i + 1}</td>
                <td className="px-2 py-2 font-medium"><Link to={`/inventory/${r.item}/print`}>{r.itemName}</Link></td>
                <td className="px-2 py-2 text-right">{r.quantity}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(r.costPriceCents / 100)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(r.sellingPriceCents / 100)}</td>
                <td className="px-2 py-2">{r.expiryDate?.slice(0, 10) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <DocSummary grand={['Total cost', formatCurrency(selected.rows.reduce((s, r) => s + r.quantity * r.costPriceCents, 0) / 100)]} />
      </section>
    </>}

  </div>;

}

