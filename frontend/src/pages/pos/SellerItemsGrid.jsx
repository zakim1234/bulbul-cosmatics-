import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Trash2, Plus } from 'lucide-react';
import client from '../../api/client.js';
import { useDebounce } from '../../hooks/useDebounce.js';
import { formatCurrency } from '../../utils/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasPermission } from '../../constants/permissions.js';
import QuickCreateItemModal from './QuickCreateItemModal.jsx';

// Selling more than is in stock is allowed: the item goes below zero and the
// next stock received makes it up. This only tells the cashier.
export const stockShortMessage = (available, quantity) => `⚠️ ${Math.max(0, available)} in stock — stock goes to ${available - quantity}.`;

const INITIAL_BLANK_ROWS = 3;
let blankSeq = 0;
const newBlankId = () => ++blankSeq;

// The item cell of an empty row: a live search over Stock/Inventory (name,
// item ID, serial number, barcode, generic name). Items with nothing left to
// sell are listed but flagged and cannot be picked. When nothing matches, a user
// who may create items (admin or "Can create items") gets a quick-create shortcut;
// everyone else is told only Stock items can be sold.
//
// The dropdown is rendered in a portal with fixed positioning so the grid's
// own scroll container can never clip it.
function ItemSearchCell({ onSelect, onCreateNew, canCreate, placeholder, inputRef }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [pos, setPos] = useState(null);
  const debounced = useDebounce(query, 200);
  const wrapRef = useRef(null);
  const dropRef = useRef(null);

  useEffect(() => {
    if (!debounced.trim()) {
      setResults([]);
      setSearched(false);
      return undefined;
    }
    let active = true;
    client
      .get('/inventory/search', { params: { q: debounced } })
      .then((res) => {
        if (!active) return;
        // In-stock matches first, out-of-stock ones (flagged) after them.
        const sorted = [...res.data.data].sort((a, b) => Number(b.availableQuantity > 0) - Number(a.availableQuantity > 0));
        setResults(sorted);
        setHighlighted(0);
        setSearched(true);
      })
      .catch(() => {
        if (active) {
          setResults([]);
          setSearched(true);
        }
      });
    return () => {
      active = false;
    };
  }, [debounced]);

  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < 280 && r.top > spaceBelow;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - 348)),
      width: Math.max(r.width, 340),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (wrapRef.current?.contains(e.target) || dropRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const choose = (item) => {
    if (!item) return;
    onSelect(item);
    setQuery('');
    setResults([]);
    setSearched(false);
    setOpen(false);
    setHighlighted(0);
  };

  const handleKeyDown = (e) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
      // Tab commits the highlighted match (like Enter) so the cashier can work
      // the grid from the keyboard; it only does so while a real, sellable
      // match is highlighted, otherwise Tab moves on as usual.
      const item = results[highlighted];
      if (item) {
        e.preventDefault();
        choose(item);
      } else if (e.key === 'Enter') {
        e.preventDefault();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault(); // closes the list only, not the page (Esc = Back)
      setOpen(false);
    }
  };

  const showDropdown = open && query.trim() && pos;

  return (
    <div ref={wrapRef} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlighted(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-md border border-transparent bg-transparent py-1.5 pl-7 pr-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-brand-300 focus:bg-white focus:ring-1 focus:ring-brand-200"
      />

      {showDropdown &&
        createPortal(
          <div
            ref={dropRef}
            style={{ position: 'fixed', zIndex: 60, left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            className="max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-neutral-200/80 bg-white shadow-lg"
          >
            {results.length === 0 ? (
              <div className="px-3 py-3 text-xs text-neutral-500">
                {!searched ? (
                  'Searching...'
                ) : canCreate ? (
                  <>
                    <p>No matching item in Stock.</p>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onCreateNew(query.trim());
                        setOpen(false);
                      }}
                      className="mt-2 flex w-full items-center gap-1.5 rounded-md bg-brand-50 px-2.5 py-2 text-left text-sm font-medium text-brand-700 hover:bg-brand-100"
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate">Create new item "{query.trim()}" and add to sale</span>
                    </button>
                  </>
                ) : (
                  'No matching item in Stock. Only items already in Stock can be sold — ask an admin to add it.'
                )}
              </div>
            ) : (
              <ul className="max-h-64 overflow-y-auto py-1">
                {results.map((r, i) => {
                  const out = r.availableQuantity <= 0;
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          choose(r);
                        }}
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${
                          i === highlighted ? 'bg-brand-50' : 'hover:bg-neutral-50'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-neutral-800">{r.name}</p>
                          <p className={`truncate text-xs ${out ? 'font-medium text-brand-600' : 'text-neutral-400'}`}>
                            {r.itemCode}
                            {r.serialNumber ? ` · SN: ${r.serialNumber}` : ''} · Stock: {r.availableQuantity} {r.unit}
                            {out ? ' · not in stock, can still be sold' : ''}
                          </p>
                        </div>
                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${out ? 'text-neutral-400' : 'text-neutral-700'}`}>
                          {formatCurrency(r.sellingPrice)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

function RemoveButton({ onClick, disabled }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-neutral-300 transition-colors hover:bg-brand-50 hover:text-brand-600 disabled:opacity-40"
      title="Remove row"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

// The box keeps what is typed, so it can be cleared completely (empty, not a
// 0 that comes back) and a new price typed in; an empty box counts as 0.
// Clicking in selects the price, so typing replaces it.
function PriceInput({ value, onChange, disabled, className = '' }) {
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => {
    // A price changed from outside (another row, a draft loaded) shows here.
    setText((t) => ((Number(t) || 0) === (Number(value) || 0) ? t : String(value ?? '')));
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const next = e.target.value.replace(',', '.');
        if (!/^\d*\.?\d{0,2}$/.test(next)) return;
        setText(next);
        onChange(Number(next) || 0);
      }}
      className={`no-spinner w-full rounded-md border border-neutral-200 px-2 py-1.5 text-right text-sm tabular-nums focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-200 ${className}`}
    />
  );
}

function QtyInput({ line, disabled, onChange, inputRef, className = '' }) {
  const over = line.quantity > line.available;
  return (
    <input
      ref={inputRef}
      // type="text" (not "number") is deliberate: Chrome silently ignores
      // .select() on type="number" inputs, so a re-focus could never
      // actually select the existing value for overtyping -- clicking into
      // "10" and typing "200" would land mid-string and produce something
      // like "12000" instead of replacing it with "200". A digits-only text
      // field with inputMode="numeric" (still a numeric keypad on mobile)
      // supports real selection, so onFocus's select() below works.
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      // A new row starts empty rather than "1" -- the cashier types the
      // quantity they actually want. Shown blank whenever the value is 0 so
      // typing the first digit doesn't land after an invisible "0".
      value={line.quantity || ''}
      disabled={disabled}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '');
        // Written back onto the element itself, synchronously: if the
        // sanitized digits equal the previous quantity (e.g. every character
        // just typed was non-numeric and got stripped to nothing new),
        // React sees an unchanged value and skips reassigning the DOM's
        // `value`, leaving the browser's own unsanitized text (like "12a")
        // sitting there for the next keystroke to build on. Setting it here
        // keeps the field's real content sanitized on every keystroke.
        e.target.value = digits;
        onChange(digits === '' ? 0 : Number(digits));
      }}
      // Selects the existing value on focus so typing a new number replaces
      // it instead of appending to it (e.g. editing "10" -> typing "5"
      // becomes "5", not "105").
      onFocus={(e) => e.target.select()}
      className={`no-spinner w-full rounded-md border px-2 py-1.5 text-center text-sm tabular-nums focus:outline-none focus:ring-1 ${
        over ? 'border-brand-400 focus:ring-brand-200' : 'border-neutral-200 focus:border-brand-400 focus:ring-brand-200'
      } ${className}`}
    />
  );
}

function LineNote({ line }) {
  return (
    <>
      <p className="truncate text-xs font-normal text-neutral-400">
        {line.itemCode}
        {line.serialNumber ? ` · SN: ${line.serialNumber}` : ''} · Stock: {line.available}
      </p>
      {(Number(line.discount) || 0) > 0 && (
        <p className="truncate text-xs font-normal text-brand-600">Line discount −{formatCurrency(line.discount)} (kept from the original invoice/quotation)</p>
      )}
    </>
  );
}

// The two trees (table for sm+, stacked cards below) each need their own refs:
// sharing one would let the hidden tree's node win the callback and swallow
// every focus() call.
function focusFirstVisible(...els) {
  for (const el of els) {
    if (el && el.offsetParent !== null) {
      el.focus();
      return el;
    }
  }
  return null;
}

const HEAD = 'px-3 py-2 text-xs font-medium uppercase tracking-wide text-neutral-500';

// Spreadsheet-style sale entry, laid out like the Supplier Invoice manual
// entry: ITEM NAME / QTY / PRICE / TOTAL, a trash icon per row, "+ Add Row" and
// a GRAND TOTAL. Empty rows hold a stock search; picking an item turns the row
// into a real line (price auto-filled from its selling price, cursor jumps to
// Qty). There is always at least one empty row at the bottom, so Tab from the
// last Price cell lands in a fresh row's item search.
export default function SellerItemsGrid({ lines, grandTotal, onAddLine, onLineChange, onRemoveLine, disabled, focusTrigger }) {
  const { user } = useAuth();
  const canCreate = hasPermission(user, 'createItems');
  const [quick, setQuick] = useState(null); // { name, blankId } while the quick-create modal is open
  const [blanks, setBlanks] = useState(() => Array.from({ length: INITIAL_BLANK_ROWS }, newBlankId));
  const qtyRefsDesktop = useRef({});
  const qtyRefsMobile = useRef({});
  const blankRefsDesktop = useRef({});
  const blankRefsMobile = useRef({});
  const lastAddedIdRef = useRef(null);
  const focusBlankRef = useRef(null);

  useEffect(() => {
    if (lastAddedIdRef.current) {
      const id = lastAddedIdRef.current;
      const el = focusFirstVisible(qtyRefsDesktop.current[id], qtyRefsMobile.current[id]);
      el?.select();
      lastAddedIdRef.current = null;
    }
  }, [lines]);

  useEffect(() => {
    if (focusBlankRef.current != null) {
      const id = focusBlankRef.current;
      focusFirstVisible(blankRefsDesktop.current[id], blankRefsMobile.current[id]);
      focusBlankRef.current = null;
    }
  }, [blanks]);

  useEffect(() => {
    if (focusTrigger) focusFirstVisible(blankRefsDesktop.current[blanks[0]], blankRefsMobile.current[blanks[0]]);
  }, [focusTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelect = (blankId) => (item) => {
    lastAddedIdRef.current = item.id;
    onAddLine(item);
    setBlanks((prev) => {
      const next = prev.filter((id) => id !== blankId);
      return next.length ? next : [newBlankId()];
    });
  };

  const addBlankRow = () => {
    const id = newBlankId();
    focusBlankRef.current = id;
    setBlanks((prev) => [...prev, id]);
  };

  const removeBlank = (id) => setBlanks((prev) => (prev.length > 1 ? prev.filter((b) => b !== id) : prev));

  const lineTotal = (line) => Math.max(0, line.quantity * line.unitPrice - (line.discount || 0));

  return (
    <div>
      <QuickCreateItemModal
        open={!!quick}
        initialName={quick?.name || ''}
        onClose={() => setQuick(null)}
        onCreated={(item) => {
          handleSelect(quick.blankId)(item);
          setQuick(null);
        }}
      />

      {/* Desktop / tablet. No internal height cap/scroll: the table grows
          with every row added, and the page itself scrolls -- a cashier
          never has to scroll a small box inside the page to see the rest of
          the invoice. */}
      <div className="hidden rounded-lg border border-neutral-200 sm:block">
        <table className="w-full text-sm">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[16%]" />
            <col className="no-print w-[11%]" />
            <col className="w-[15%]" />
            <col className="w-[19%]" />
            <col className="w-[5%]" />
          </colgroup>
          <thead className="bg-neutral-50">
            <tr>
              <th className={`${HEAD} text-left`}>Item Name</th>
              <th className={`${HEAD} text-center`}>Qty</th>
              <th className={`no-print ${HEAD} text-right`}>Cost</th>
              <th className={`${HEAD} text-right`}>Price</th>
              <th className={`${HEAD} text-right`}>Total</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 bg-white">
            {lines.map((line) => (
              <tr key={line.itemId} className={line.quantity > line.available ? 'bg-brand-50/40' : ''}>
                <td className="px-3 py-2">
                  <p className="truncate text-sm font-medium text-neutral-800">{line.name}</p>
                  <LineNote line={line} />
                </td>
                <td className="px-1 py-2 align-top">
                  <QtyInput
                    line={line}
                    disabled={disabled}
                    onChange={(v) => onLineChange(line.itemId, 'quantity', v)}
                    inputRef={(el) => {
                      qtyRefsDesktop.current[line.itemId] = el;
                    }}
                  />
                  {line.quantity > line.available && (
                    <p className="mt-1 text-center text-[11px] font-normal text-brand-600">{stockShortMessage(line.available, line.quantity)}</p>
                  )}
                </td>
                <td className="no-print px-3 py-2 text-right align-top text-sm tabular-nums text-neutral-500">
                  <span className="inline-block pt-1.5">{line.costPrice != null ? formatCurrency(line.costPrice) : '—'}</span>
                </td>
                <td className="px-1 py-2 align-top">
                  <PriceInput value={line.unitPrice} disabled={disabled} onChange={(v) => onLineChange(line.itemId, 'unitPrice', v)} />
                </td>
                <td className="px-3 py-2 text-right align-top text-sm font-semibold tabular-nums text-neutral-900">
                  <span className="inline-block pt-1.5">{formatCurrency(lineTotal(line))}</span>
                </td>
                <td className="px-1 py-2 text-center align-top">
                  <RemoveButton disabled={disabled} onClick={() => onRemoveLine(line.itemId)} />
                </td>
              </tr>
            ))}
            {blanks.map((id) => (
              <tr key={`blank-${id}`}>
                <td className="px-2 py-1.5">
                  <ItemSearchCell
                    onSelect={handleSelect(id)}
                    onCreateNew={(name) => setQuick({ name, blankId: id })}
                    canCreate={canCreate}
                    placeholder="Search item..."
                    inputRef={(el) => {
                      blankRefsDesktop.current[id] = el;
                    }}
                  />
                </td>
                <td className="px-2 py-1.5 text-center text-sm text-neutral-300">—</td>
                <td className="no-print px-3 py-1.5 text-right text-sm text-neutral-300">—</td>
                <td className="px-2 py-1.5 text-right text-sm text-neutral-300">—</td>
                <td className="px-3 py-1.5 text-right text-sm text-neutral-300">{formatCurrency(0)}</td>
                <td className="px-1 py-1.5 text-center">
                  <RemoveButton disabled={disabled || blanks.length <= 1} onClick={() => removeBlank(id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per row */}
      <div className="space-y-2 sm:hidden">
        {lines.map((line) => (
          <div key={line.itemId} className={`rounded-lg border p-3 ${line.quantity > line.available ? 'border-brand-300 bg-brand-50/40' : 'border-neutral-200 bg-white'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-800">{line.name}</p>
                <LineNote line={line} />
              </div>
              <RemoveButton disabled={disabled} onClick={() => onRemoveLine(line.itemId)} />
            </div>
            <div className="mt-2.5 grid grid-cols-3 gap-2 text-sm">
              <div>
                <p className="text-xs text-neutral-400">Qty</p>
                <QtyInput
                  line={line}
                  disabled={disabled}
                  className="mt-0.5"
                  onChange={(v) => onLineChange(line.itemId, 'quantity', v)}
                  inputRef={(el) => {
                    qtyRefsMobile.current[line.itemId] = el;
                  }}
                />
              </div>
              <div>
                <p className="text-xs text-neutral-400">Price</p>
                <PriceInput className="mt-0.5" value={line.unitPrice} disabled={disabled} onChange={(v) => onLineChange(line.itemId, 'unitPrice', v)} />
              </div>
              <div className="text-right">
                <p className="text-xs text-neutral-400">Total</p>
                <p className="mt-2 font-semibold tabular-nums text-neutral-900">{formatCurrency(lineTotal(line))}</p>
              </div>
            </div>
            {line.quantity > line.available && <p className="mt-1.5 text-xs font-normal text-brand-600">{stockShortMessage(line.available, line.quantity)}</p>}
          </div>
        ))}
        {blanks.map((id) => (
          <div key={`blank-m-${id}`} className="flex items-center gap-1 rounded-lg border border-neutral-200/80 bg-white px-1 py-1">
            <div className="min-w-0 flex-1">
              <ItemSearchCell
                onSelect={handleSelect(id)}
                    onCreateNew={(name) => setQuick({ name, blankId: id })}
                    canCreate={canCreate}
                placeholder="Search item..."
                inputRef={(el) => {
                  blankRefsMobile.current[id] = el;
                }}
              />
            </div>
            <RemoveButton disabled={disabled || blanks.length <= 1} onClick={() => removeBlank(id)} />
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          disabled={disabled}
          onClick={addBlankRow}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> Add Row
        </button>
        <div className="text-right">
          <p className="text-xs uppercase text-neutral-400">Grand Total</p>
          <p className="text-lg font-bold tabular-nums text-neutral-900">{formatCurrency(grandTotal)}</p>
        </div>
      </div>
    </div>
  );
}
