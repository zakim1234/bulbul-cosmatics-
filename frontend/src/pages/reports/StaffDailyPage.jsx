import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Printer, Search, Trash2, Users, X } from 'lucide-react';
import client, { isAllBranchesView } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasPermission } from '../../constants/permissions.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import { PageSpinner } from '../../components/ui/Spinner.jsx';
import CancelInvoiceDialog from '../customers/CancelInvoiceDialog.jsx';
import CancelCustomerPaymentDialog from '../customers/CancelCustomerPaymentDialog.jsx';
import { useDebounce } from '../../hooks/useDebounce.js';

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDay = (k) => {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, m - 1, d || 1);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// "cali — Admin · Mogadishu": who the person is and where they work.
const personLabel = (u) => {
  const role = u.isSuperAdmin ? 'Super Admin' : String(u.role || '').replace(/^./, (c) => c.toUpperCase());
  return `${u.name} — ${[role, u.branchName].filter(Boolean).join(' · ')}`;
};
const dayTitle = (key) => new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// The span shown: one day, a week (Saturday to Friday) or a month.
const VIEWS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'custom', label: 'Dates' },
];
function periodOf(view, anchor) {
  if (view === 'day') return { from: anchor, to: anchor };
  if (view === 'week') {
    const from = addDays(anchor, -((anchor.getDay() + 1) % 7));
    return { from, to: addDays(from, 6) };
  }
  return { from: new Date(anchor.getFullYear(), anchor.getMonth(), 1), to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0) };
}
const shiftPeriod = (view, anchor, by) =>
  view === 'day' ? addDays(anchor, by) : view === 'week' ? addDays(anchor, 7 * by) : new Date(anchor.getFullYear(), anchor.getMonth() + by, 1);
function periodTitle(view, { from, to }) {
  if (view === 'day') return dayTitle(dayKey(from));
  if (view === 'week') return `${from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${to.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const Accounts = ({ list }) =>
  list.length ? (
    <span className="flex flex-wrap gap-1">
      {list.map((a) => (
        <span key={a.accountName} className="rounded-md bg-brand-100 px-1.5 py-0.5 text-[11px] font-semibold text-brand-800">
          {a.accountName} {formatCurrency(a.amount)}
        </span>
      ))}
    </span>
  ) : (
    <span className="text-neutral-300">—</span>
  );

// Where the page was scrolled to when an invoice was opened from it.
const SCROLL_KEY = 'staffDaily.scroll';
const rememberScroll = () => {
  try {
    sessionStorage.setItem(SCROLL_KEY, String(document.querySelector('main')?.scrollTop || 0));
  } catch {
    // storage unavailable: Back just starts at the top
  }
};

const clock = (d) => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const Avatar = ({ name }) => (
  <span className="surface-blue grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold">
    {String(name || '?').trim().charAt(0).toUpperCase()}
  </span>
);

const zeroDim = (cents) => (cents ? '' : 'text-neutral-300');

// Every invoice and debt payment behind a person's figures for the day.
// Fixed column widths so every day's table lines up the same way.
function Entries({ entries, onDelete }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-200/70">
      <table className="w-full min-w-[820px] table-fixed text-xs">
        <colgroup>
          <col className="w-[72px]" />
          <col className="w-[150px]" />
          <col className="w-[130px]" />
          <col />
          <col className="w-[96px]" />
          <col className="w-[96px]" />
          <col className="w-[90px]" />
          <col className="w-[90px]" />
          <col className="w-[120px]" />
          {onDelete && <col className="no-print w-[44px]" />}
        </colgroup>
        <thead className="bg-neutral-50">
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Number</th>
            <th className="px-3 py-2">Customer</th>
            <th className="px-3 py-2">Items</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-right">Paid</th>
            <th className="px-3 py-2 text-right">Wallet</th>
            <th className="px-3 py-2 text-right">On credit</th>
            <th className="px-3 py-2">Account</th>
            {onDelete && <th className="no-print px-1 py-2" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {entries.map((e) => (
            <tr key={`${e.kind}-${e.id}`} className="align-top hover:bg-brand-50/40">
              <td className="whitespace-nowrap px-3 py-2 text-neutral-500">{clock(e.time)}</td>
              <td className="px-3 py-2">
                <Link
                  to={e.kind === 'invoice' ? `/receipt/${e.id}` : `/payment-receipt/${e.id}`}
                  state={{ backLabel: 'Staff Daily' }}
                  onClick={rememberScroll}
                  className="block truncate font-semibold text-brand-700 hover:underline"
                >
                  {e.number}
                </Link>
                <span
                  className={`mt-0.5 inline-block rounded px-1.5 py-px text-[10px] font-semibold ${
                    e.kind === 'invoice' ? 'bg-neutral-100 text-neutral-600' : 'bg-brand-50 text-brand-700'
                  }`}
                >
                  {e.kind === 'invoice' ? 'Invoice' : 'Debt payment'}
                </span>
              </td>
              <td className="truncate px-3 py-2 font-medium text-neutral-800" title={e.customer || ''}>{e.customer || '—'}</td>
              <td className="truncate px-3 py-2 text-neutral-500" title={e.items.join(', ')}>{e.items.join(', ') || '—'}</td>
              <td className="figure whitespace-nowrap px-3 py-2 text-right font-semibold text-neutral-900">{e.kind === 'invoice' ? formatCurrency(e.total) : '—'}</td>
              <td className={`figure whitespace-nowrap px-3 py-2 text-right font-semibold ${e.paid ? 'text-emerald-600' : 'text-neutral-300'}`}>{formatCurrency(e.paid)}</td>
              <td className="figure whitespace-nowrap px-3 py-2 text-right text-neutral-600">{e.wallet > 0 ? formatCurrency(e.wallet) : <span className="text-neutral-300">—</span>}</td>
              <td className="figure whitespace-nowrap px-3 py-2 text-right text-neutral-600">{e.credit > 0 ? formatCurrency(e.credit) : <span className="text-neutral-300">—</span>}</td>
              <td className="truncate px-3 py-2 text-neutral-600" title={e.account || ''}>{e.account || <span className="text-neutral-300">—</span>}</td>
              {onDelete && <td className="no-print px-1 py-1.5"><DeleteButton e={e} onDelete={onDelete} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Delete = cancel: stock comes back and the debt, payments and accounts are
// put right (the cancel dialog asks where any money paid goes back to).
const DeleteButton = ({ e, onDelete }) => (
  <button
    type="button"
    onClick={() => onDelete(e)}
    title={e.kind === 'invoice' ? 'Delete (cancel) this invoice' : 'Delete (cancel) this payment'}
    className="grid h-7 w-7 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
  >
    <Trash2 className="h-3.5 w-3.5" />
  </button>
);

const Stat = ({ label, value, cents, tone = 'text-neutral-900' }) => (
  <div className="min-w-0 rounded-lg bg-neutral-50 px-3 py-2">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</p>
    <p className={`figure mt-0.5 text-sm font-bold ${cents ? tone : 'text-neutral-300'}`}>{value}</p>
  </div>
);

// One person's day: their figures on top, then every invoice behind them.
function PersonDay({ r, onDelete }) {
  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex min-w-[9rem] items-center gap-2.5">
          <Avatar name={r.userName} />
          <div>
            <p className="font-semibold text-neutral-900">{r.userName}</p>
            <p className="text-xs text-neutral-400">
              {r.invoices} invoice{r.invoices === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-5 lg:w-auto lg:flex-1">
          <Stat label="Sold" value={formatCurrency(r.sales)} cents={r.sales} />
          <Stat label="Paid at sale" value={formatCurrency(r.paidAtSale)} cents={r.paidAtSale} />
          <Stat label="Debt collected" value={formatCurrency(r.debtCollected)} cents={r.debtCollected} />
          <Stat label="Money taken" value={formatCurrency(r.received)} cents={r.received} tone="text-emerald-600" />
          <Stat label="On credit" value={formatCurrency(r.credit)} cents={r.credit} tone="text-brand-700" />
        </div>
      </div>
      {r.byAccount?.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-neutral-500">Into accounts:</span>
          <Accounts list={r.byAccount} />
        </div>
      )}
      {r.entries?.length > 0 && <Entries entries={r.entries} onDelete={onDelete} />}
    </div>
  );
}

// The whole period, one line per person. Fixed widths keep the columns tidy.
function MonthTable({ rows, totals }) {
  const num = 'figure whitespace-nowrap px-4 py-3 text-right';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] table-fixed text-sm">
        <colgroup>
          <col className="w-[17%]" />
          <col className="w-[8%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col className="w-[21%]" />
        </colgroup>
        <thead className="bg-neutral-50">
          <tr className="text-left text-[10.5px] font-semibold uppercase tracking-wider text-neutral-500">
            <th className="px-4 py-2.5">Person</th>
            <th className="px-4 py-2.5 text-right">Invoices</th>
            <th className="px-4 py-2.5 text-right">Sold</th>
            <th className="px-4 py-2.5 text-right">Paid at sale</th>
            <th className="px-4 py-2.5 text-right">Debt collected</th>
            <th className="px-4 py-2.5 text-right">Money taken</th>
            <th className="px-4 py-2.5 text-right">On credit</th>
            <th className="px-4 py-2.5">Into accounts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <tr key={r.user} className="hover:bg-brand-50/40">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <Avatar name={r.userName} />
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-neutral-900">{r.userName}</p>
                    {r.days != null && <p className="text-xs text-neutral-400">{r.days} day{r.days === 1 ? '' : 's'}</p>}
                  </div>
                </div>
              </td>
              <td className={`${num} text-neutral-700`}>{r.invoices}</td>
              <td className={`${num} font-bold text-neutral-950`}>{formatCurrency(r.sales)}</td>
              <td className={`${num} text-neutral-700 ${zeroDim(r.paidAtSale)}`}>{formatCurrency(r.paidAtSale)}</td>
              <td className={`${num} text-neutral-700 ${zeroDim(r.debtCollected)}`}>{formatCurrency(r.debtCollected)}</td>
              <td className={`${num} font-bold text-emerald-600 ${zeroDim(r.received)}`}>{formatCurrency(r.received)}</td>
              <td className={`${num} text-brand-700 ${zeroDim(r.credit)}`}>{formatCurrency(r.credit)}</td>
              <td className="px-4 py-3"><Accounts list={r.byAccount} /></td>
            </tr>
          ))}
        </tbody>
        {totals && rows.length > 1 && (
          <tfoot className="border-t-2 border-neutral-200 bg-brand-50/50 font-bold">
            <tr>
              <td className="px-4 py-3 text-neutral-900">Total</td>
              <td className={num}>{totals.invoices}</td>
              <td className={num}>{formatCurrency(totals.sales)}</td>
              <td className={num}>{formatCurrency(totals.paidAtSale)}</td>
              <td className={num}>{formatCurrency(totals.debtCollected)}</td>
              <td className={`${num} text-emerald-700`}>{formatCurrency(totals.received)}</td>
              <td className={`${num} text-brand-700`}>{formatCurrency(totals.credit)}</td>
              <td className="px-4 py-3"><Accounts list={totals.byAccount} /></td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

const shortDay = (key) => new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

// One customer in one report for the period: every invoice and debt payment,
// who served them, and the totals.
function CustomerReport({ name, entries, onDelete }) {
  const invoices = entries.filter((e) => e.kind === 'invoice');
  const sum = (list, k) => list.reduce((t, e) => t + (e[k] || 0), 0);
  const bought = sum(invoices, 'total');
  const paid = sum(entries, 'paid');
  const wallet = sum(entries, 'wallet');
  const credit = sum(invoices, 'credit');
  const debtPaid = sum(entries.filter((e) => e.kind !== 'invoice'), 'paid');
  const staff = [...new Set(entries.map((e) => e.staff))];
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200/70 bg-white">
      <div className="surface-blue flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-white/70 text-sm font-bold">{name.charAt(0).toUpperCase()}</span>
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-neutral-600">Customer</p>
            <p className="text-base font-bold">{name}</p>
          </div>
        </div>
        <p className="text-xs text-neutral-700">
          {invoices.length} invoice{invoices.length === 1 ? '' : 's'} · {entries.length - invoices.length} debt payment{entries.length - invoices.length === 1 ? '' : 's'} · Served by {staff.join(', ')}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 px-5 py-4 sm:grid-cols-5">
        <Stat label="Bought" value={formatCurrency(bought)} cents={bought} />
        <Stat label="Paid" value={formatCurrency(paid)} cents={paid} tone="text-emerald-600" />
        <Stat label="Debt paid" value={formatCurrency(debtPaid)} cents={debtPaid} />
        <Stat label="From wallet" value={formatCurrency(wallet)} cents={wallet} />
        <Stat label="On credit" value={formatCurrency(credit)} cents={credit} tone="text-brand-700" />
      </div>
      <div className="px-5 pb-5">
        <div className="overflow-x-auto rounded-xl border border-neutral-200/70">
          <table className="w-full min-w-[900px] table-fixed text-xs">
            <colgroup>
              <col className="w-[110px]" />
              <col className="w-[150px]" />
              <col className="w-[110px]" />
              <col />
              <col className="w-[96px]" />
              <col className="w-[96px]" />
              <col className="w-[90px]" />
              <col className="w-[90px]" />
              <col className="w-[120px]" />
              {onDelete && <col className="no-print w-[44px]" />}
            </colgroup>
            <thead className="bg-neutral-50">
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">Served by</th>
                <th className="px-3 py-2">Items</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Wallet</th>
                <th className="px-3 py-2 text-right">On credit</th>
                <th className="px-3 py-2">Account</th>
                {onDelete && <th className="no-print px-1 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {entries.map((e) => (
                <tr key={`${e.kind}-${e.id}`} className="align-top hover:bg-brand-50/40">
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-600">
                    {shortDay(e.day)}
                    <span className="block text-[10px] text-neutral-400">{clock(e.time)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to={e.kind === 'invoice' ? `/receipt/${e.id}` : `/payment-receipt/${e.id}`}
                      state={{ backLabel: 'Staff Daily' }}
                      onClick={rememberScroll}
                      className="block truncate font-semibold text-brand-700 hover:underline"
                    >
                      {e.number}
                    </Link>
                    <span className={`mt-0.5 inline-block rounded px-1.5 py-px text-[10px] font-semibold ${e.kind === 'invoice' ? 'bg-neutral-100 text-neutral-600' : 'bg-brand-50 text-brand-700'}`}>
                      {e.kind === 'invoice' ? 'Invoice' : 'Debt payment'}
                    </span>
                  </td>
                  <td className="truncate px-3 py-2 font-medium text-neutral-800">{e.staff}</td>
                  <td className="truncate px-3 py-2 text-neutral-500" title={e.items.join(', ')}>{e.items.join(', ') || '—'}</td>
                  <td className="figure whitespace-nowrap px-3 py-2 text-right font-semibold text-neutral-900">{e.kind === 'invoice' ? formatCurrency(e.total) : '—'}</td>
                  <td className={`figure whitespace-nowrap px-3 py-2 text-right font-semibold ${e.paid ? 'text-emerald-600' : 'text-neutral-300'}`}>{formatCurrency(e.paid)}</td>
                  <td className="figure whitespace-nowrap px-3 py-2 text-right text-neutral-600">{e.wallet > 0 ? formatCurrency(e.wallet) : <span className="text-neutral-300">—</span>}</td>
                  <td className="figure whitespace-nowrap px-3 py-2 text-right text-neutral-600">{e.credit > 0 ? formatCurrency(e.credit) : <span className="text-neutral-300">—</span>}</td>
                  <td className="truncate px-3 py-2 text-neutral-600" title={e.account || ''}>{e.account || <span className="text-neutral-300">—</span>}</td>
                  {onDelete && <td className="no-print px-1 py-1.5"><DeleteButton e={e} onDelete={onDelete} /></td>}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-neutral-200 bg-brand-50/50 text-xs font-bold">
              <tr>
                <td className="px-3 py-2.5 text-neutral-900" colSpan={4}>Total</td>
                <td className="figure whitespace-nowrap px-3 py-2.5 text-right">{formatCurrency(bought)}</td>
                <td className="figure whitespace-nowrap px-3 py-2.5 text-right text-emerald-700">{formatCurrency(paid)}</td>
                <td className="figure whitespace-nowrap px-3 py-2.5 text-right">{formatCurrency(wallet)}</td>
                <td className="figure whitespace-nowrap px-3 py-2.5 text-right text-brand-700">{formatCurrency(credit)}</td>
                <td />
                {onDelete && <td className="no-print" />}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>
  );
}

function CustomerReports({ groups, search, month, onDelete }) {
  if (!groups.length) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-neutral-200/70 bg-white py-14 text-sm text-neutral-500">
        <Search className="h-8 w-8 text-neutral-300" />
        {search} did not buy anything in {month}.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {groups.length > 1 && <p className="text-xs text-neutral-500">{groups.length} customers match “{search}”.</p>}
      {groups.map((g) => (
        <CustomerReport key={g.name} name={g.name} entries={g.entries} onDelete={onDelete} />
      ))}
    </div>
  );
}

// Admin only: one month, day by day -- what each person sold and the money
// they took in (paid at the sale and debt payments), by account.
export default function StaffDailyPage() {
  const toast = useToast();
  const { user } = useAuth();
  const allBranches = isAllBranchesView(user);
  // Delete buttons: the Super Admin, and an admin they allowed.
  const canDelete = hasPermission(user, 'staffDailyDelete');
  // Period, person and customer live in the address, so Back from an invoice
  // keeps them.
  const [params, setParams] = useSearchParams();
  const view = VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'month';
  const legacyMonth = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? `${params.get('month')}-01` : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : legacyMonth || dayKey(new Date());
  const person = params.get('person') || ''; // one person, or '' for everyone
  const customer = params.get('customer') || ''; // one customer, or '' for all
  // Dates typed by hand (the "Dates" view).
  const okDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  const cFrom = okDay(params.get('from')) || date;
  const cTo = okDay(params.get('to')) || date;
  // A customer looked up by name: their whole history (or just this period).
  const cid = params.get('cid') || '';
  const cname = params.get('cname') || '';
  const cAll = params.get('cperiod') !== '1';
  const go = (next) => {
    const all = { view, date, person, customer, from: view === 'custom' ? cFrom : '', to: view === 'custom' ? cTo : '', cid, cname, cperiod: cAll ? '' : '1', ...next };
    setParams(Object.fromEntries(Object.entries(all).filter(([, v]) => v)), { replace: true });
  };
  const period = view === 'custom' ? { from: parseDay(cFrom <= cTo ? cFrom : cTo), to: parseDay(cFrom <= cTo ? cTo : cFrom) } : periodOf(view, parseDay(date));
  const from = dayKey(period.from);
  const to = dayKey(period.to);
  const title = view === 'custom' ? (from === to ? dayTitle(from) : `${period.from.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} – ${period.to.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`) : periodTitle(view, period);
  const setView = (v) => go({ view: v });
  const shift = (by) => go({ date: dayKey(shiftPeriod(view, parseDay(date), by)) });
  const setPerson = (p) => go({ person: p });
  const setCustomer = (c) => go({ customer: c });
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [reload, setReload] = useState(0);
  // Delete (cancel) an invoice or a debt payment straight from the report.
  const [cancelSale, setCancelSale] = useState(null);
  const [cancelPayment, setCancelPayment] = useState(null);
  const onDelete = async (e) => {
    if (e.kind === 'invoice') {
      try {
        setCancelSale((await client.get(`/sales/${e.id}`)).data.data);
      } catch (err) {
        toast.error(err.friendlyMessage || 'Could not open this invoice.');
      }
    } else {
      setCancelPayment({ customerId: e.customerId, payment: { id: e.id, receiptNumber: e.number, amount: e.paid, paymentAccountName: e.account, allocations: e.allocations || [] } });
    }
  };
  const afterDelete = () => {
    setCancelSale(null);
    setCancelPayment(null);
    setReload((n) => n + 1);
  };
  // Customer look-up box.
  const [cq, setCq] = useState('');
  const [cResults, setCResults] = useState([]);
  const cqDebounced = useDebounce(cq, 250);
  useEffect(() => {
    if (!cqDebounced.trim()) return setCResults([]);
    client
      .get('/customers/search', { params: { q: cqDebounced.trim() } })
      .then((r) => setCResults(r.data.data.slice(0, 30)))
      .catch(() => setCResults([]));
  }, [cqDebounced]);
  const pickCustomer = (c) => {
    setCq('');
    setCResults([]);
    go({ cid: c ? String(c.id) : '', cname: c ? c.name : '', customer: '' });
  };

  // Coming back from an invoice: scroll to where the user was.
  useEffect(() => {
    if (!data) return;
    let saved = null;
    try {
      saved = sessionStorage.getItem(SCROLL_KEY);
      sessionStorage.removeItem(SCROLL_KEY);
    } catch {
      // storage unavailable: stay at the top
    }
    if (saved) requestAnimationFrame(() => document.querySelector('main')?.scrollTo({ top: Number(saved) }));
  }, [data]);

  useEffect(() => {
    client
      .get('/reports/users')
      .then((r) => setPeople(r.data.data))
      .catch(() => setPeople([]));
  }, []);

  useEffect(() => {
    setData(null);
    client
      .get('/reports/staff-daily', { params: cid && cAll ? { customerId: cid, all: '1', userId: person || undefined } : { from, to, userId: person || undefined, customerId: cid || undefined } })
      .then((r) => setData(r.data.data))
      .catch((err) => {
        toast.error(err.friendlyMessage || 'Could not load the report.');
        setData({ days: [], people: [], totals: null });
      });
  }, [from, to, person, cid, cAll, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const reachesToday = to >= dayKey(new Date());

  // Every invoice and payment of the period, with the day and who did it.
  const allEntries = useMemo(
    () => (data?.days || []).flatMap((d) => d.rows.flatMap((r) => (r.entries || []).map((e) => ({ ...e, day: d.day, staff: r.userName })))),
    [data]
  );
  const customerNames = useMemo(() => [...new Set(allEntries.map((e) => e.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [allEntries]);
  // The chosen customer's report: everything they had in the period.
  const customerGroups = useMemo(() => {
    if (cid) {
      const entries = allEntries.slice().sort((a, b) => new Date(a.time) - new Date(b.time));
      return entries.length ? [{ name: cname || entries[0].customer, entries }] : [];
    }
    if (!customer) return [];
    const entries = allEntries.filter((e) => e.customer === customer).sort((a, b) => new Date(a.time) - new Date(b.time));
    return entries.length ? [{ name: customer, entries }] : [];
  }, [allEntries, customer, cid, cname]);

  return (
    <div id="print-area">
      <PageHeader
        title="Staff Daily"
        subtitle={`What each person sold and the money they took in, day by day.${allBranches ? ' All branches together.' : ''}`}
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        }
      />

      <div className="no-print mb-4 inline-flex flex-wrap items-center gap-1 rounded-2xl border border-neutral-200/70 bg-white p-2">
        <div className="inline-flex rounded-lg bg-neutral-100 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`rounded-md px-3 py-1 text-xs font-semibold ${view === v.id ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-800'}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <span className="mx-1 h-6 w-px bg-neutral-200" />
        <button
          onClick={() => shift(-1)}
          className="inline-flex items-center gap-0.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50"
        >
          <ChevronLeft className="h-4 w-4" /> Previous
        </button>
        <span className="min-w-[12rem] px-3 text-center text-sm font-bold text-neutral-900">{title}</span>
        <button
          onClick={() => shift(1)}
          disabled={reachesToday}
          className="inline-flex items-center gap-0.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
        {/* Type or pick the date by hand. */}
        {view === 'custom' ? (
          <span className="flex items-center gap-1.5 px-1 text-xs font-semibold text-neutral-500">
            From
            <input type="date" value={cFrom} max={dayKey(new Date())} onChange={(e) => e.target.value && go({ from: e.target.value, date: e.target.value })} className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm font-semibold text-neutral-900" />
            To
            <input type="date" value={cTo} max={dayKey(new Date())} onChange={(e) => e.target.value && go({ to: e.target.value })} className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm font-semibold text-neutral-900" />
          </span>
        ) : (
          <label className="flex items-center gap-1.5 px-1 text-xs font-semibold text-neutral-500">
            Date
            <input type="date" value={date} max={dayKey(new Date())} onChange={(e) => e.target.value && go({ date: e.target.value })} className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm font-semibold text-neutral-900" />
          </label>
        )}
        <span className="mx-1 h-6 w-px bg-neutral-200" />
        <label className="flex items-center gap-2 px-1 text-xs font-semibold text-neutral-500">
          Person
          <select
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            className="max-w-[16rem] rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-neutral-900"
          >
            <option value="">Everyone</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {personLabel(u)}
              </option>
            ))}
          </select>
        </label>
        <span className="mx-1 h-6 w-px bg-neutral-200" />
        <label className="flex items-center gap-2 px-1 text-xs font-semibold text-neutral-500">
          Customer
          {/* Only the customers who bought in the period shown. */}
          <select
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            className="max-w-[14rem] rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-neutral-900"
          >
            <option value="">All customers ({customerNames.length})</option>
            {customer && !customerNames.includes(customer) && <option value={customer}>{customer}</option>}
            {customerNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="mx-1 h-6 w-px bg-neutral-200" />
        {/* Any customer, even one who bought nothing in this period. */}
        {cid ? (
          <span className="flex items-center gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-sm font-semibold text-brand-800 ring-1 ring-brand-200">
            <Search className="h-3.5 w-3.5" /> {cname}
            <select value={cAll ? 'all' : 'period'} onChange={(e) => go({ cperiod: e.target.value === 'period' ? '1' : '' })} className="rounded-md border border-brand-200 bg-white px-1.5 py-0.5 text-xs font-semibold text-neutral-800">
              <option value="all">All time</option>
              <option value="period">This period only</option>
            </select>
            <button type="button" onClick={() => pickCustomer(null)} title="Close" className="rounded p-0.5 text-brand-700 hover:bg-white">
              <X className="h-4 w-4" />
            </button>
          </span>
        ) : (
          <div className="relative">
            <label className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5">
              <Search className="h-4 w-4 text-neutral-400" />
              <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder="Search any customer…" className="w-48 border-0 bg-transparent p-0 text-sm text-neutral-900 outline-none placeholder:text-neutral-400" />
            </label>
            {cResults.length > 0 && (
              <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
                {cResults.map((c) => (
                  <button key={c.id} type="button" onClick={() => pickCustomer(c)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-brand-50">
                    <span className="truncate font-semibold text-neutral-900">{c.name}</span>
                    {c.phone && <span className="shrink-0 text-xs text-neutral-400">{c.phone}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {!data ? (
        <PageSpinner />
      ) : cid || customer ? (
        <CustomerReports groups={customerGroups} search={cid ? cname : customer} month={cid && cAll ? 'any day so far' : title} onDelete={canDelete ? onDelete : null} />
      ) : data.days.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-neutral-200/70 bg-white py-14 text-sm text-neutral-500">
          <Users className="h-8 w-8 text-neutral-300" />
          No sales in {title}.
        </div>
      ) : (
        <div className="space-y-4">
          {view !== 'day' && (
            <section className="overflow-hidden rounded-2xl border border-neutral-200/70 bg-white">
              <div className="surface-blue px-5 py-3">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-neutral-600">Whole {view}</p>
                <p className="text-base font-bold">{title} — each person</p>
              </div>
              <MonthTable rows={data.people} totals={data.totals} />
            </section>
          )}

          {data.days.map((d) => (
            <section key={d.day} className="overflow-hidden rounded-2xl border border-neutral-200/70 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200/70 bg-brand-50/60 px-5 py-3">
                <p className="text-sm font-bold text-neutral-900">{dayTitle(d.day)}</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-white px-3 py-1 text-neutral-500 ring-1 ring-neutral-200">
                    Sold <span className="figure font-bold text-neutral-900">{formatCurrency(d.totals.sales)}</span>
                  </span>
                  <span className="rounded-full bg-white px-3 py-1 text-neutral-500 ring-1 ring-neutral-200">
                    Taken <span className="figure font-bold text-emerald-600">{formatCurrency(d.totals.received)}</span>
                  </span>
                  {d.totals.credit > 0 && (
                    <span className="rounded-full bg-white px-3 py-1 text-neutral-500 ring-1 ring-neutral-200">
                      On credit <span className="figure font-bold text-brand-700">{formatCurrency(d.totals.credit)}</span>
                    </span>
                  )}
                </div>
              </div>
              <div className="divide-y divide-neutral-100">
                {d.rows.map((r) => (
                  <PersonDay key={`${r.user}-${d.day}`} r={r} onDelete={canDelete ? onDelete : null} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <CancelInvoiceDialog sale={cancelSale} onClose={() => setCancelSale(null)} onCancelled={afterDelete} />
      <CancelCustomerPaymentDialog customerId={cancelPayment?.customerId} payment={cancelPayment?.payment || null} onClose={() => setCancelPayment(null)} onCancelled={afterDelete} />
    </div>
  );
}
