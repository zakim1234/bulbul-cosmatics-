import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ClipboardPaste, FileSpreadsheet, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { readSheetFile } from '../utils/readSheetFile.js';
import client from '../api/client.js';
import Button from './ui/Button.jsx';
import { PageSpinner } from './ui/Spinner.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { showBulkTools } from '../constants/permissions.js';

// A sheet for seeing and changing many records at once (customers, supplier
// opening balances). Everything already saved is loaded into it; any row can
// be corrected, new rows typed or pasted from Excel, and one Save All sends
// only what is new or changed. Unsaved work is kept in this browser, checked
// before anything is sent, and sent in parts; each new row carries its own
// key so a part sent twice is never saved twice.
//
// columns: [{ key, label, type: 'text' | 'money', required, lockExisting, readOnly, negative }]
// A readOnly column only shows a value from the server (e.g. what is owed now).
// loadUrl returns saved rows ({ id, ...column values }).
// problem(row) -> '' or what is wrong; sameAs(row) -> text that must not repeat.
// canDelete: the X on a saved row marks it to be deleted on Save All (sent as
// { id, delete: true }); press it again to keep the row. Without it, X only
// takes a saved row off the sheet.

const PART = 200;
const editable = (columns) => columns.filter((c) => !c.readOnly);
const blankRow = (columns) => ({ key: crypto.randomUUID(), ...Object.fromEntries(editable(columns).map((c) => [c.key, ''])) });
const asText = (v) => (v == null ? '' : String(v));

// One value per line (copied from a web page, PDF or a printed list rather
// than from Excel): each text line starts a row, the numbers after it belong
// to it. A whole number just before the next name is that row's number in
// the list, not a value, so it is left out. Returns tab-separated lines
// (name, then phone-like numbers, then amounts) or null if it does not fit.
const NUM = /^[-$]?\s*[\d,]+(\.\d+)?$/;

// A cell as a number: "1,234.50", "$12", "(50.00)" (minus) -> "1234.50" ...
const moneyText = (v) => {
  let t = String(v ?? '').trim();
  const neg = /^\(.*\)$/.test(t);
  t = t.replace(/[^0-9.-]/g, '');
  if (t === '' || !Number.isFinite(Number(t))) return '';
  // 1.1499999999999999 (how Excel stores 1.15) -> 1.15
  t = String(parseFloat(Number(t).toPrecision(12)));
  return neg && !t.startsWith('-') ? `-${t}` : t;
};

// Rows read from an Excel / CSV file -> sheet values. A header row (Name,
// Phone, Balance ...) says which column is which; without one the columns
// are taken in the sheet's order. Total rows and rows with no name are
// left out.
function mapSheetRows(sheet, inputs) {
  const lower = (s) => String(s ?? '').trim().toLowerCase();
  const words = (c) => [c.label, ...(c.aliases || [])].map(lower);
  const isNumCell = (v) => moneyText(v) !== '' && /\d/.test(String(v));
  let headerAt = -1;
  let colOf = {};
  for (let i = 0; i < Math.min(10, sheet.length); i += 1) {
    const row = sheet[i] || [];
    if (row.some(isNumCell)) continue;
    const found = {};
    row.forEach((cell, j) => {
      const t = lower(cell);
      if (!t) return;
      inputs.forEach((c) => {
        if (found[c.key] === undefined && words(c).some((w) => t === w || t.includes(w))) found[c.key] = j;
      });
    });
    if (Object.keys(found).length) { headerAt = i; colOf = found; break; }
  }
  const nameCol = inputs[0];
  const out = [];
  for (const raw of sheet.slice(headerAt + 1)) {
    const row = raw || [];
    let values = {};
    if (headerAt >= 0) {
      inputs.forEach((c) => { values[c.key] = colOf[c.key] === undefined ? '' : String(row[colOf[c.key]] ?? '').trim(); });
      if (!values[nameCol.key]) values[nameCol.key] = String(row.find((v) => String(v).trim() && !isNumCell(v)) ?? '').trim();
    } else {
      const cells = row.map((v) => String(v ?? '').trim());
      while (cells.length && !cells[0]) cells.shift();
      inputs.forEach((c, k) => { values[c.key] = cells[k] ?? ''; });
      // A plain amount in a text column (e.g. Phone) is the balance, not a
      // phone number: only something that looks like a phone stays there.
      inputs.slice(1).filter((c) => c.type !== 'money').forEach((c) => {
        const v = values[c.key];
        if (v && isNumCell(v) && (String(v).includes('.') || String(v).replace(/\D/g, '').length < 7)) values[c.key] = '';
      });
    }
    // An amount column that came out empty or not a number: the last number in the row.
    inputs.filter((c) => c.type === 'money').forEach((c) => {
      let v = moneyText(values[c.key]);
      if (v === '') {
        const nums = row.filter(isNumCell);
        v = nums.length ? moneyText(nums[nums.length - 1]) : '';
      }
      values[c.key] = v;
    });
    const name = values[nameCol.key];
    // Not a name: empty, a Total row, a number, or a report date ("Nov 10, 26").
    if (!name || /^total:?$/i.test(name) || NUM.test(name) || /^[a-z]{3,9}\.? \d{1,2}, \d{2,4}$/i.test(name)) continue;
    out.push(values);
  }
  return out;
}
function regroupLines(lines, textCols, moneyCols) {
  const isNum = (l) => NUM.test(l.trim());
  if (!lines.some(isNum) || !lines.some((l) => !isNum(l))) return null;
  const records = [];
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!isNum(t)) {
      cur = { name: t, phones: [], amounts: [] };
      records.push(cur);
      return;
    }
    const next = lines[i + 1];
    if (/^\d+$/.test(t) && (next === undefined || !isNum(next)) && t.length < 7) return; // list number
    if (!cur) return;
    const digits = t.replace(/[^\d]/g, '');
    if (!t.includes('.') && digits.length >= 7) cur.phones.push(t);
    else cur.amounts.push(t.replace(/[^0-9.-]/g, ''));
  });
  if (!records.length) return null;
  return records.map((r) => [r.name, ...Array.from({ length: textCols }, (_, k) => r.phones[k] || ''), ...Array.from({ length: moneyCols }, (_, k) => r.amounts[k] || '')].join('\t'));
}

function readDraft(draftKey) {
  try { return JSON.parse(localStorage.getItem(draftKey)) || null; } catch { return null; }
}

// One sheet row. Memoised: typing in a row redraws only that row, not all
// of them -- with hundreds of rows that is what keeps the sheet quick.
const SheetRow = memo(function SheetRow({ row, ri, columns, canDelete, changed, fresh, deleting, api }) {
  return (
    <tr className={deleting ? 'bg-red-50 line-through decoration-red-400' : changed || fresh ? 'bg-brand-50/70' : ''}>
      <td className="px-2 text-xs">
        <span className="text-neutral-400">{ri + 1}</span>
        {changed && <span className="ml-1 rounded bg-brand-100 px-1 text-[10px] font-semibold text-brand-700">edited</span>}
        {fresh && <span className="ml-1 rounded bg-brand-100 px-1 text-[10px] font-semibold text-brand-700">new</span>}
        {deleting && <span className="ml-1 inline-block rounded bg-red-100 px-1 text-[10px] font-semibold text-red-700 no-underline">delete</span>}
      </td>
      {columns.map((c, ci) => c.readOnly ? (
        <td key={c.key} className={`px-3 text-sm text-neutral-500 ${c.type === 'money' ? 'text-right tabular-nums' : ''}`}>
          {row.id && row.extra?.[c.key] != null ? (c.type === 'money' ? Number(row.extra[c.key]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : row.extra[c.key]) : ''}
        </td>
      ) : (
        <td key={c.key} className="p-1.5">
          <input
            ref={(el) => api.setCell(ri, ci, el)}
            aria-label={`Row ${ri + 1} ${c.label}`}
            type={c.type === 'money' ? 'number' : 'text'}
            min={c.type === 'money' && !c.negative ? 0 : undefined}
            step={c.type === 'money' ? '0.01' : undefined}
            readOnly={api.locked(row, c)}
            title={deleting ? 'Will be deleted when you press Save All' : api.locked(row, c) ? 'Saved -- change this on its own page' : undefined}
            className={`w-full min-w-28 rounded-xl border px-3 py-2 text-sm outline-none transition-colors focus:border-brand-400 focus:ring-2 focus:ring-brand-100 ${c.type === 'money' ? 'text-right tabular-nums' : ''} ${api.locked(row, c) ? 'border-transparent bg-transparent font-medium text-neutral-800' : 'border-neutral-200 bg-white hover:border-neutral-300'} ${deleting ? 'line-through !text-red-500' : ''}`}
            value={row[c.key]}
            onChange={(e) => api.update(row.key, c.key, e.target.value)}
            onPaste={(e) => api.paste(ri, ci)(e)}
            onKeyDown={(e) => api.keyDown(ri, ci)(e)}
          />
        </td>
      ))}
      <td className="px-1">
        <button
          type="button"
          className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-brand-600"
          aria-label={`Remove row ${ri + 1}`}
          title={row.id && canDelete ? (deleting ? 'Keep this row (do not delete)' : 'Delete this row when you press Save All') : row.id ? 'Take off this sheet (it is not deleted)' : 'Remove row'}
          onClick={() => api.remove(row.key)}
        >
          {deleting ? <RotateCcw className="h-4 w-4" /> : row.id && canDelete ? <Trash2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
        </button>
      </td>
    </tr>
  );
});

export default function BulkSheet({ title, subtitle, backTo, backLabel, columns, draftKey, loadUrl, endpoint, toPayload, problem, sameAs, describeDone, canAdd = true, canDelete = false, clearUrl = null, describeCleared = null, blankRows = 10 }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);
  const cells = useRef({});
  const [clearing, setClearing] = useState(false);
  const location = useLocation();
  const { user } = useAuth();
  const canImport = showBulkTools(user); // Super Admin, once switched on in Settings
  const navigate = useNavigate();
  const fileInput = useRef(null);
  // Stable handlers for SheetRow: they call the newest version of each
  // handler, so rows that did not change are not redrawn.
  const handlers = useRef({});
  const api = useMemo(() => ({
    update: (...a) => handlers.current.update(...a),
    remove: (...a) => handlers.current.remove(...a),
    paste: (...a) => handlers.current.paste(...a),
    keyDown: (...a) => handlers.current.keyDown(...a),
    locked: (...a) => handlers.current.locked(...a),
    setCell: (ri, ci, el) => { cells.current[`${ri}:${ci}`] = el; },
  }), []);

  const inputs = editable(columns);
  const isNew = (r) => !r.id && inputs.some((c) => asText(r[c.key]).trim() !== '');
  const isDeleted = (r) => !!r.id && !!r.del;
  const isChanged = (r) => !!r.id && !r.del && inputs.some((c) => asText(r[c.key]) !== asText(r.orig[c.key]));
  const isWork = (r) => isNew(r) || isChanged(r) || isDeleted(r);
  // Pasted one-value-per-line lists fill the sheet in column order: name,
  // the other text columns (phone), then the money columns.
  const regroup = (lines) => {
    const textCols = inputs.slice(1).filter((c) => c.type !== 'money').length;
    const moneyCols = inputs.filter((c) => c.type === 'money').length;
    const ordered = [inputs[0], ...inputs.slice(1).filter((c) => c.type !== 'money'), ...inputs.filter((c) => c.type === 'money')];
    const sameOrder = ordered.every((c, i) => c === inputs[i]);
    return sameOrder ? regroupLines(lines, textCols, moneyCols) : null;
  };

  // Saved rows from the server, with any unsaved work from this browser
  // laid back over them (edits by id, new rows after).
  async function load(useDraft) {
    const res = await client.get(loadUrl);
    const saved = res.data.data.map((item) => {
      const values = Object.fromEntries(inputs.map((c) => [c.key, asText(item[c.key])]));
      return { key: `id-${item.id}`, id: String(item.id), ...values, orig: values, extra: item };
    });
    const draft = useDraft ? readDraft(draftKey) : null;
    let restored = 0;
    if (draft) {
      const edits = new Map(draft.filter((r) => r.id).map((r) => [r.id, r]));
      for (const row of saved) {
        const d = edits.get(row.id);
        if (d && canDelete && d.del) {
          row.del = true;
          restored += 1;
        } else if (d && inputs.some((c) => asText(d[c.key]) !== asText(row[c.key]))) {
          inputs.forEach((c) => { row[c.key] = asText(d[c.key]); });
          restored += 1;
        }
      }
    }
    const fresh = (draft || []).filter((r) => !r.id && inputs.some((c) => asText(r[c.key]).trim() !== ''));
    restored += fresh.length;
    setRows([...saved, ...fresh, ...Array.from({ length: canAdd ? blankRows : 0 }, () => blankRow(columns))]);
    if (restored) toast.success(`Restored ${restored} unsaved change(s).`);
  }

  useEffect(() => {
    load(true).catch((err) => toast.error(err.friendlyMessage || 'Could not load the saved rows.'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rows from an Excel / CSV file: a saved row with the same name gets the
  // file's values, every other name becomes a new row.
  const importFromFile = async (file) => {
    if (!file) return;
    try {
      const records = mapSheetRows(await readSheetFile(file), inputs);
      if (!records.length) return toast.error('No rows found in this file.');
      let updated = 0;
      setRows((prev) => {
        const byName = new Map(prev.filter((r) => r.id).map((r) => [sameAs(r), r.key]));
        const changes = new Map();
        const added = [];
        for (const values of records) {
          const key = byName.get(sameAs(values));
          if (key) { changes.set(key, values); updated += 1; } else added.push({ key: crypto.randomUUID(), ...Object.fromEntries(inputs.map((c) => [c.key, values[c.key] ?? ''])) });
        }
        const kept = prev.map((r) => (changes.has(r.key) ? { ...r, ...Object.fromEntries(inputs.filter((c) => !(r.id && c.lockExisting)).map((c) => [c.key, changes.get(r.key)[c.key] ?? r[c.key]])), del: false } : r)).filter((r) => r.id || isNew(r));
        return [...kept, ...added, ...Array.from({ length: canAdd ? blankRows : 0 }, () => blankRow(columns))];
      });
      toast.success(`${records.length.toLocaleString()} row(s) read from ${file.name}. Check them, then press Save All.`);
    } catch (err) {
      toast.error(err.message || 'Could not read this file.');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  // Opened from an "Import Excel file" button on another page.
  const pendingFile = location.state?.importFile;
  useEffect(() => {
    if (!rows || !pendingFile) return;
    if (!canImport) { navigate(location.pathname, { replace: true, state: null }); return; }
    navigate(location.pathname, { replace: true, state: null });
    importFromFile(pendingFile);
  }, [rows === null, pendingFile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rows) return undefined;
    const timer = setTimeout(() => {
      try {
        const work = rows.filter(isWork).map(({ orig, extra, ...r }) => r);
        if (work.length) localStorage.setItem(draftKey, JSON.stringify(work));
        else localStorage.removeItem(draftKey);
      } catch {
        // Storage full or blocked: the rows stay on screen, just not kept.
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <PageSpinner />;

  const update = (key, field, value) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const addRows = (n = 1) => setRows((prev) => [...prev, ...Array.from({ length: n }, () => blankRow(columns))]);
  // A saved row with canDelete is marked (or unmarked) to be deleted on Save
  // All; anything else just leaves the sheet.
  const remove = (key) => setRows((prev) => {
    const row = prev.find((r) => r.key === key);
    if (row?.id && canDelete) {
      return prev.map((r) => {
        if (r.key !== key) return r;
        // Unmarking brings back the saved values.
        return r.del ? { ...r, del: false } : { ...r, ...r.orig, del: true };
      });
    }
    return prev.filter((r) => r.key !== key);
  });
  // Clear the sheet: every unsaved row and change goes (new rows, edits,
  // delete marks); saved rows go back to what is saved. Nothing is deleted
  // from the system.
  // With clearUrl, the Super Admin's Clear All also deletes everything that
  // is saved (e.g. every customer), then the sheet reloads empty.
  const clearSheet = async () => {
    if (clearUrl && canImport) {
      setClearing(true);
      try {
        const res = await client.post(clearUrl, { confirm: 'DELETE' });
        const data = res.data.data || {};
        if (data.failed) toast.error(`${data.failed} could not be deleted: ${data.failures?.[0]?.message || ''}`);
        try { localStorage.removeItem(draftKey); } catch { /* blocked */ }
        setQuery('');
        await load(false);
        toast.success(describeCleared ? describeCleared(data) : 'Everything deleted.');
      } catch (err) {
        toast.error(err.friendlyMessage || 'Could not clear.');
      } finally {
        setClearing(false);
      }
      return;
    }
    setRows((prev) => [
      ...prev.filter((r) => r.id).map((r) => ({ ...r, ...r.orig, del: false })),
      ...Array.from({ length: canAdd ? blankRows : 0 }, () => blankRow(columns)),
    ]);
    setQuery('');
    try { localStorage.removeItem(draftKey); } catch { /* blocked */ }
    toast.success('Sheet cleared.');
  };
  const focus = (rowIndex, colIndex) => setTimeout(() => cells.current[`${rowIndex}:${colIndex}`]?.focus(), 0);
  const locked = (row, col) => (!!row.id && col.lockExisting) || !!row.del;

  // Pasting several lines (or tab-separated columns) from Excel fills the
  // sheet from this cell down and to the right, adding rows as needed.
  const paste = (rowIndex, startCol) => (e) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    let colIndex = startCol;
    let lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
    // Copied from a web page or PDF instead of Excel: every value is on its
    // own line (1 / NAME / 246 / 246.00 / 2 / NEXT NAME ...). Put each name
    // back on one row with its own numbers.
    const grouped = !text.includes('\t') && regroup(lines);
    if (grouped) {
      lines = grouped;
      colIndex = columns.indexOf(inputs[0]);
    }
    setRows((prev) => {
      const next = [...prev];
      while (next.length < rowIndex + lines.length) next.push(blankRow(columns));
      lines.forEach((line, i) => {
        const row = { ...next[rowIndex + i] };
        line.split('\t').forEach((v, j) => {
          const col = inputs[inputs.indexOf(columns[colIndex]) + j];
          if (col && !locked(row, col)) row[col.key] = col.type === 'money' ? v.replace(/[^0-9.-]/g, '') : v.trim();
        });
        next[rowIndex + i] = row;
      });
      return next;
    });
    toast.success(`Pasted ${lines.length} row(s).`);
  };

  const keyDown = (rowIndex, colIndex) => (e) => {
    const last = columns.slice(colIndex + 1).every((c) => c.readOnly);
    if ((e.key === 'Tab' && !e.shiftKey && last) || e.key === 'Enter') {
      e.preventDefault();
      if (rowIndex === rows.length - 1) addRows(1);
      focus(rowIndex + 1, e.key === 'Enter' ? colIndex : 0);
    }
  };

  handlers.current = { update, remove, paste, keyDown, locked };

  async function save() {
    const work = rows.filter(isWork);
    if (!work.length) return toast.error('Nothing new or changed to save.');
    for (const r of work) {
      if (isDeleted(r)) continue;
      const p = problem(r);
      if (p) return toast.error(`Row ${rows.indexOf(r) + 1}: ${p}.`);
    }
    const identityChanges = rows.filter((r) => !r.del && (isNew(r) || (r.id && sameAs(r) !== sameAs(r.orig))));
    const changingKeys = new Set(identityChanges.map((r) => r.key));
    const unchangedNames = new Map();
    for (const r of rows) {
      if (r.del || (!r.id && !isNew(r))) continue; // being deleted, or an empty row
      if (!changingKeys.has(r.key) && !unchangedNames.has(sameAs(r))) unchangedNames.set(sameAs(r), r);
    }
    const seen = new Map();
    for (const r of identityChanges) {
      const id = sameAs(r);
      const existing = unchangedNames.get(id);
      if (existing) return toast.error(`Rows ${rows.indexOf(existing) + 1} and ${rows.indexOf(r) + 1} are the same (${id}). Keep one.`);
      if (seen.has(id)) return toast.error(`Rows ${rows.indexOf(seen.get(id)) + 1} and ${rows.indexOf(r) + 1} are the same (${id}). Keep one.`);
      seen.set(id, r);
    }
    setSaving(true);
    setProgress({ done: 0, total: work.length });
    let saved = 0;
    const totals = {};
    try {
      for (let i = 0; i < work.length; i += PART) {
        const part = work.slice(i, i + PART);
        const res = await client.post(endpoint, { rows: part.map((r) => (isDeleted(r) ? { key: r.key, id: r.id, delete: true } : { key: r.key, ...(r.id ? { id: r.id } : {}), ...toPayload(r) })) });
        for (const [k, v] of Object.entries(res.data.data || {})) if (typeof v === 'number') totals[k] = (totals[k] || 0) + v;
        saved += part.length;
        // Saved new rows leave the sheet and saved edits become the new
        // "saved" values, so a failure later on leaves exactly what is left.
        const done = new Set(part.map((r) => r.key));
        setRows((prev) => prev.filter((r) => !(done.has(r.key) && (!r.id || r.del))).map((r) => (done.has(r.key) ? { ...r, orig: Object.fromEntries(inputs.map((c) => [c.key, r[c.key]])) } : r)));
        setProgress({ done: saved, total: work.length });
      }
      try { localStorage.removeItem(draftKey); } catch { /* blocked */ }
      toast.success(describeDone(totals));
      setQuery('');
      await load(false);
    } catch (err) {
      toast.error(`${saved ? `${saved} of ${work.length} rows were saved; the rest are still here -- fix and press Save All again. ` : ''}${err.friendlyMessage || 'Could not save.'}`);
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  const q = query.trim().toLowerCase();
  const shown = rows.map((r, i) => [r, i]).filter(([r]) => !q || (!r.id && !isNew(r)) || inputs.some((c, k) => (k === 0 ? asText(r[c.key]).trim().toLowerCase().startsWith(q) : asText(r[c.key]).toLowerCase().includes(q))));
  const savedCount = rows.filter((r) => r.id).length;
  const newCount = rows.filter(isNew).length;
  const changedCount = rows.filter(isChanged).length;
  const deletedCount = rows.filter(isDeleted).length;
  const money = inputs.find((c) => c.type === 'money');
  const moneyTotal = money ? rows.filter((r) => (r.id && !r.del) || isNew(r)).reduce((s, r) => s + (Number(r[money.key]) || 0), 0) : 0;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div>
        <Link to={backTo} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-600 hover:text-neutral-900">
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Link>
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-neutral-950" style={{ fontFamily: 'var(--font-display)' }}>
          {title}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        <ClipboardPaste className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          The {savedCount} saved row{savedCount === 1 ? ' is' : 's are'} listed first -- change any of them in place. Type new rows below, or copy rows from Excel and paste
          them into a cell (columns fill in order: {inputs.map((c) => c.label).join(', ')}).{canDelete ? ' Press the bin on a row to delete it (press again to keep it).' : ''} Save All saves only what is new, changed{canDelete ? ' or marked to delete' : ''}.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full max-w-2xl items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            className="w-full rounded-xl border border-neutral-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none hover:border-neutral-300 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            placeholder="Find a row..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {canImport && (
          <Button variant="secondary" className="shrink-0 !text-red-600 hover:!bg-red-50" onClick={clearSheet} disabled={saving || clearing}>
            <Trash2 className="h-4 w-4" /> Clear All
          </Button>
        )}
        {canImport && (
          <>
            <input ref={fileInput} type="file" accept=".xlsx,.csv,.txt" className="hidden" onChange={(e) => importFromFile(e.target.files?.[0])} />
            <Button className="shrink-0" onClick={() => fileInput.current?.click()} disabled={saving}>
              <FileSpreadsheet className="h-4 w-4" /> Import Excel file
            </Button>
          </>
        )}
        </div>
        <p className="text-sm text-neutral-500">
          <span className="font-semibold text-neutral-900">{savedCount}</span> saved · <span className="font-semibold text-brand-700">{newCount}</span> new ·{' '}
          <span className="font-semibold text-brand-700">{changedCount}</span> changed
          {canDelete && (
            <>
              {' '}· <span className="font-semibold text-red-600">{deletedCount}</span> to delete
            </>
          )}
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200/80 bg-white p-2">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="w-12 px-2 pb-1 pt-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500">#</th>
              {columns.map((c) => (
                <th key={c.key} className={`px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500 ${c.type === 'money' ? 'text-right' : 'text-left'}`}>
                  {c.label}
                  {c.required && <span className="text-brand-600"> *</span>}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {shown.map(([row, ri]) => (
              <SheetRow key={row.key} row={row} ri={ri} columns={columns} canDelete={canDelete} changed={isChanged(row)} fresh={isNew(row)} deleting={isDeleted(row)} api={api} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {canImport && (
            <Button variant="secondary" className="!text-red-600 hover:!bg-red-50" onClick={clearSheet} disabled={saving || clearing}>
              <Trash2 className="h-4 w-4" /> Clear All
            </Button>
          )}
          {canAdd && (
            <>
              <Button variant="secondary" onClick={() => addRows(1)}>
                <Plus className="h-4 w-4" /> Add Row
              </Button>
              <Button variant="secondary" onClick={() => addRows(10)}>
                <Plus className="h-4 w-4" /> 10 Rows
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-4">
          {money && (
            <p className="text-sm text-neutral-500">
              {money.label} total{' '}
              <span className="figure font-semibold text-neutral-900">${moneyTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </p>
          )}
          <Button onClick={save} loading={saving}>
            {progress && progress.total > PART ? `Saving ${progress.done} / ${progress.total}…` : `Save All${newCount + changedCount + deletedCount ? ` (${newCount + changedCount + deletedCount})` : ''}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
