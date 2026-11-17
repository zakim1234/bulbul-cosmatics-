import { Fragment, useEffect, useState } from 'react';
import { useListKeys } from '../../hooks/useListKeys.js';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, ChevronRight, ChevronDown, Printer, X, ArrowLeft } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useDebounce } from '../../hooks/useDebounce.js';
import { formatCurrency, formatDate, formatDateTime } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { PageSpinner } from '../../components/ui/Spinner.jsx';
import { Input } from '../../components/ui/Field.jsx';
import Button from '../../components/ui/Button.jsx';

const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-3 py-2 text-sm text-neutral-800';
const NUM = 'px-3 py-2 text-right text-sm tabular-nums text-neutral-800';

// Item Report: pick an item (e.g. Zinc) and see every unit that came in --
// from which supplier invoice -- every customer who took some and how many,
// and each day's in / out.
export default function ItemReportPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const itemId = params.get('item') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const set = (patch) => setParams((p) => {
    const next = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    return next;
  });

  const [query, setQuery] = useState('');
  const q = useDebounce(query, 250);
  const [matches, setMatches] = useState([]);
  const kb = useListKeys();
  useEffect(() => {
    if (!q.trim()) return setMatches([]);
    client.get('/inventory/search', { params: { q: q.trim() } }).then((r) => setMatches(r.data.data.slice(0, 8))).catch(() => setMatches([]));
  }, [q]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!itemId) return setData(null);
    setLoading(true);
    client
      .get(`/inventory/${itemId}/report`, { params: { from: from || undefined, to: to || undefined } })
      .then((r) => setData(r.data.data))
      .catch((err) => toast.error(err.friendlyMessage || 'Could not load the item report.'))
      .finally(() => setLoading(false));
  }, [itemId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const [open, setOpen] = useState(null); // customer whose invoices are shown
  // Close the chosen item: back to an empty search.
  const closeItem = () => {
    set({ item: '' });
    setData(null);
    setQuery('');
    setOpen(null);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Item Report" subtitle="What came in, from which supplier, who took it, and each day's in / out." />

      <div className="flex flex-col gap-3 rounded-2xl border border-neutral-200/80 bg-white p-4 no-print sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <label className="mb-1 block text-xs font-medium text-neutral-500">Item</label>
          <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-neutral-400" />
          <Input className={`pl-9 ${itemId ? 'pr-9' : ''}`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={kb.onKeyDown} placeholder={data ? data.item.name : 'Search an item, e.g. Zinc…'} />
          {itemId && (
            <button type="button" onClick={closeItem} title="Close this item" aria-label="Close this item" className="absolute bottom-2 right-2 rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700">
              <X className="h-4 w-4" />
            </button>
          )}
          {matches.length > 0 && (
            <div ref={kb.listRef} className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-neutral-200 bg-white shadow-xl">
              {matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    set({ item: m.id });
                    setQuery('');
                    setMatches([]);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-brand-50"
                >
                  <span className="font-medium text-neutral-900">{m.name}</span>
                  <span className="text-xs text-neutral-500">{m.quantity} in stock</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-500">From</label>
          <Input type="date" value={from} onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-500">To</label>
          <Input type="date" value={to} onChange={(e) => set({ to: e.target.value })} />
        </div>
        {data && (
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        )}
      </div>

      {!itemId ? (
        <div className="rounded-xl border border-dashed border-neutral-200/80 bg-white py-14 text-center text-sm text-neutral-400">Search an item above to see its report.</div>
      ) : loading || !data ? (
        <PageSpinner />
      ) : (
        <>
          <button type="button" onClick={closeItem} className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800 no-print">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="rounded-2xl border border-neutral-200/80 bg-white p-4">
            <p className="text-lg font-bold text-neutral-900">
              {data.item.name} <span className="text-sm font-normal text-neutral-400">{data.item.itemCode}</span>
            </p>
            <p className="text-sm text-neutral-500">
              {formatDate(data.from)} – {formatDate(data.to)} · now {data.item.quantity} {data.item.unit} in stock · average cost {formatCurrency(data.item.averageCost)}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ['Opening', data.summary.opening],
                ['Came in', data.summary.totalIn],
                ['Went out', data.summary.totalOut],
                ['Taken by customers', data.summary.soldToCustomers],
                ['Closing', data.summary.closing],
              ].map(([label, v]) => (
                <div key={label} className="rounded-xl bg-neutral-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
                  <p className="text-xl font-bold tabular-nums text-neutral-900">{v}</p>
                </div>
              ))}
            </div>
          </div>

          <Section title={`Came in from suppliers (${data.receipts.length})`}>
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className={TH}>Date</th>
                  <th className={TH}>Supplier</th>
                  <th className={TH}>Supplier invoice</th>
                  <th className={TH}>Stock No.</th>
                  <th className={`${TH} text-right`}>Qty</th>
                  <th className={`${TH} text-right`}>Cost</th>
                  <th className={`${TH} text-right`}>Still in stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data.receipts.length === 0 ? (
                  <Empty cols={7} />
                ) : (
                  data.receipts.map((r, i) => (
                    <tr key={i}>
                      <td className={TD}>{formatDate(r.at)}</td>
                      <td className={`${TD} font-medium`}>{r.supplier || <span className="text-neutral-400">No supplier chosen</span>}</td>
                      <td className={TD}>{r.supplierInvoice || '—'}</td>
                      <td className={TD}>{r.stockSerial || '—'}</td>
                      <td className={NUM}>{r.quantity}</td>
                      <td className={NUM}>{formatCurrency(r.unitCost)}</td>
                      <td className={NUM}>{r.stillInStock}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Section>

          <Section title={`Taken by customers (${data.customers.length})`}>
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className={TH}>Customer</th>
                  <th className={`${TH} text-right`}>Invoices</th>
                  <th className={`${TH} text-right`}>Qty taken</th>
                  <th className={`${TH} text-right`}>Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data.customers.length === 0 ? (
                  <Empty cols={4} />
                ) : (
                  data.customers.map((c, i) => (
                    <Fragment key={i}>
                      <tr className="cursor-pointer hover:bg-neutral-50" onClick={() => setOpen(open === i ? null : i)}>
                        <td className={TD}>
                          <span className="inline-flex items-center gap-1 font-medium">
                            {open === i ? <ChevronDown className="h-4 w-4 text-neutral-400" /> : <ChevronRight className="h-4 w-4 text-neutral-400" />}
                            {c.customer ? (
                              <Link to={`/customers/${c.customer}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline">
                                {c.name}
                              </Link>
                            ) : (
                              c.name
                            )}
                          </span>
                        </td>
                        <td className={NUM}>{c.invoices.length}</td>
                        <td className={`${NUM} font-semibold`}>{c.quantity}</td>
                        <td className={NUM}>{formatCurrency(c.amount)}</td>
                      </tr>
                      {open === i &&
                        c.invoices.map((inv) => (
                          <tr key={inv.id} className="bg-neutral-50/60">
                            <td className={`${TD} pl-10`}>
                              <Link to={`/receipt/${inv.id}`} className="text-brand-700 hover:underline">
                                {inv.receiptNumber}
                              </Link>{' '}
                              <span className="text-xs text-neutral-400">{formatDateTime(inv.at)}</span>
                            </td>
                            <td />
                            <td className={NUM}>{inv.quantity}</td>
                            <td />
                          </tr>
                        ))}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </Section>

          <Section title="Each day">
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className={TH}>Day</th>
                  <th className={`${TH} text-right`}>Came in</th>
                  <th className={`${TH} text-right`}>Went out</th>
                  <th className={`${TH} text-right`}>Left at day end</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data.days.length === 0 ? (
                  <Empty cols={4} />
                ) : (
                  data.days.map((d) => (
                    <tr key={d.day}>
                      <td className={TD}>{formatDate(d.day)}</td>
                      <td className={`${NUM} text-brand-700`}>{d.in ? `+${d.in}` : '—'}</td>
                      <td className={NUM}>{d.out ? `−${d.out}` : '—'}</td>
                      <td className={`${NUM} font-semibold`}>{d.closing}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Section>

          <Section title={`Every movement (${data.movements.length})`}>
            <table className="w-full">
              <thead className="bg-neutral-50">
                <tr>
                  <th className={TH}>When</th>
                  <th className={TH}>What</th>
                  <th className={TH}>Reference</th>
                  <th className={`${TH} text-right`}>In</th>
                  <th className={`${TH} text-right`}>Out</th>
                  <th className={`${TH} text-right`}>Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data.movements.length === 0 ? (
                  <Empty cols={6} />
                ) : (
                  data.movements.map((m, i) => (
                    <tr key={i}>
                      <td className={TD}>{formatDateTime(m.at)}</td>
                      <td className={TD}>
                        {m.kind}
                        {m.supplier && <span className="block text-xs text-neutral-500">from {m.supplier}{m.supplierInvoice ? ` · invoice ${m.supplierInvoice}` : ''}</span>}
                      </td>
                      <td className={TD}>{m.reference || '—'}</td>
                      <td className={`${NUM} text-brand-700`}>{m.in || ''}</td>
                      <td className={NUM}>{m.out || ''}</td>
                      <td className={`${NUM} font-semibold`}>{m.balance}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200/80 bg-white">
      <p className="border-b border-neutral-100 px-4 py-3 text-sm font-bold text-neutral-900">{title}</p>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Empty({ cols }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-sm text-neutral-400">
        Nothing in this period.
      </td>
    </tr>
  );
}
