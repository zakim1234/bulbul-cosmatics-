import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Printer, ArrowLeft, User } from 'lucide-react';
import client from '../../api/client.js';
import { formatCurrency, formatDate } from '../../utils/format.js';
import { printA5 } from '../../utils/printA5.js';
import { PageSpinner } from '../../components/ui/Spinner.jsx';
import Button from '../../components/ui/Button.jsx';
import { Select } from '../../components/ui/Field.jsx';
import DocHeader, { DocInfo, DocFooter, DOC_TH, DOC_THEAD_ROW, docRow } from '../../components/docs/DocHeader.jsx';

const key = (s) => String(s || '').trim().toLowerCase();

// The offset statement: everyone, or one person (as customer and/or
// supplier) -- how many times and how much was set off with them.
export default function OffsetStatementPage() {
  const [params, setParams] = useSearchParams();
  const person = params.get('person') || '';
  const [all, setAll] = useState(null);
  const [now, setNow] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    client.get('/offsets').then((r) => setAll(r.data.data)).catch((err) => setError(err.friendlyMessage || 'Could not load the statement.'));
  }, []);

  // Everyone who took part in an offset, by name.
  const people = useMemo(() => {
    const m = new Map();
    for (const o of all || []) for (const n of [o.customerName, o.supplierName]) if (n && !m.has(key(n))) m.set(key(n), n);
    return [...m.values()].sort((a, b) => a.localeCompare(b));
  }, [all]);

  const rows = useMemo(() => (all || []).filter((o) => !person || key(o.customerName) === key(person) || key(o.supplierName) === key(person)), [all, person]);

  // What this person owes us / we owe them right now.
  useEffect(() => {
    setNow(null);
    if (!person || !all) return;
    const c = all.find((o) => key(o.customerName) === key(person));
    const s = all.find((o) => key(o.supplierName) === key(person));
    client
      .get('/offsets/preview', { params: { customerId: c?.customerId || '', supplierId: s?.supplierId || '' } })
      .then((r) => setNow({ ...r.data.data, isCustomer: !!c, isSupplier: !!s }))
      .catch(() => setNow(null));
  }, [person, all]);

  if (error) return <div className="rounded-lg bg-brand-50 p-4 text-sm text-brand-700">{error}</div>;
  if (!all) return <PageSpinner />;

  const active = rows.filter((o) => o.status !== 'CANCELLED');
  const total = active.reduce((s, o) => s + o.amount, 0);
  const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
  const cards = [
    ['Times set off', String(active.length)],
    ['Total set off', formatCurrency(total)],
    ...(person && now?.isCustomer ? [[`${person} owes us now`, formatCurrency(now.customerOwes)]] : []),
    ...(person && now?.isSupplier ? [[`We owe ${person} now`, formatCurrency(now.supplierOwed)]] : []),
  ];

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to="/offsets" className="flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-700"><ArrowLeft className="h-4 w-4" /> Back to Offsets</Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-neutral-700"><User className="h-4 w-4 text-neutral-400" /> Person</span>
          <div className="w-64">
            <Select value={person} onChange={(e) => setParams(e.target.value ? { person: e.target.value } : {})}>
              <option value="">Everyone</option>
              {people.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </div>
          <Button onClick={printA5}><Printer className="h-4 w-4" /> Print</Button>
        </div>
      </div>
      <div id="print-area" className="mx-auto max-w-[148mm] rounded-2xl border border-neutral-200/80 bg-white p-6 text-[13px] text-neutral-900 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <DocHeader compact title="Offset Statement" meta={<span className="font-semibold">{active.length} offset{active.length === 1 ? '' : 's'}</span>} />
        <DocInfo left={['Statement for', person || 'Everyone']} right={['Printed', formatDate(new Date())]} />
        <div className={`mt-4 grid gap-2 ${cards.length > 2 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2'}`} style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
          {cards.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</p>
              <p className="text-base font-extrabold tabular-nums text-neutral-950">{value}</p>
            </div>
          ))}
        </div>
        <table className="mt-4 w-full">
          <thead>
            <tr className={DOC_THEAD_ROW}>
              <th className={`${DOC_TH} text-left`}>#</th>
              <th className={`${DOC_TH} text-left`}>Date</th>
              <th className={`${DOC_TH} text-left`}>Voucher</th>
              <th className={`${DOC_TH} text-left`}>Customer ↔ Supplier</th>
              <th className={`${DOC_TH} text-right`}>Set off</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-neutral-500">No offsets yet.</td></tr>
            )}
            {sorted.map((o, i) => (
              <tr key={o.id} className={docRow(i)}>
                <td className="px-2 py-2 text-neutral-500">{i + 1}</td>
                <td className="px-2 py-2">{formatDate(o.date)}</td>
                <td className="px-2 py-2 font-semibold">
                  <Link to={`/offsets/${o.id}`} className="hover:underline print:no-underline">{o.number}</Link>
                  {o.status === 'CANCELLED' && <span className="ml-1 text-[11px] font-semibold text-red-600">(cancelled)</span>}
                </td>
                <td className="px-2 py-2">{o.customerName} ↔ {o.supplierName}{o.note ? <span className="block text-[11px] text-neutral-500">{o.note}</span> : null}</td>
                <td className={`px-2 py-2 text-right font-semibold tabular-nums ${o.status === 'CANCELLED' ? 'text-neutral-400 line-through' : ''}`}>{formatCurrency(o.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ml-auto mt-4 flex max-w-xs justify-between surface-blue px-3 py-2 text-sm font-bold text-white" style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
          <span>Total set off</span>
          <span className="tabular-nums">{formatCurrency(total)}</span>
        </div>
        <DocFooter>Offset statement · {person || 'Everyone'}</DocFooter>
      </div>
    </div>
  );
}
