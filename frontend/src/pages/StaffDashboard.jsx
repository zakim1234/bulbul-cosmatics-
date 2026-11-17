import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CalendarClock,
  Clock,
  FileText,
  Package,
  PackagePlus,
  PackageX,
  Receipt,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  Users,
} from 'lucide-react';
import client from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { hasPermission } from '../constants/permissions.js';
import { formatCurrency } from '../utils/format.js';
import { PageSpinner } from '../components/ui/Spinner.jsx';

// The home page for everyone who is not an admin: their own day at a glance,
// the work they are allowed to start, and the stock that needs attention.
// The full breakdown of their money stays on My Report.

const DISPLAY = { fontFamily: 'var(--font-display)' };
const ROLE_LABEL = { manager: 'Manager', cashier: 'Cashier', custom: 'Staff' };

const ACTIONS = [
  { to: '/pos/new', label: 'New Sale', hint: 'Sell to a customer', icon: ShoppingCart, module: 'pos', primary: true },
  { to: '/stock', label: 'Add Stock', hint: 'Receive new goods', icon: PackagePlus, module: 'stock' },
  { to: '/stock-adjustments', label: 'Stock Adjustment', hint: 'Fix or count stock', icon: SlidersHorizontal, module: 'stockAdjustments' },
  { to: '/inventory', label: 'Inventory', hint: 'Items and prices', icon: Boxes, module: 'inventory' },
  { to: '/customers', label: 'Customers', hint: 'Accounts and debts', icon: Users, module: 'customers' },
  { to: '/quotations/new', label: 'Quotation', hint: 'Price offer', icon: FileText, module: 'quotations' },
  { to: '/purchases', label: 'Purchases', hint: 'Supplier invoices', icon: Truck, module: 'purchases' },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const time = (d) => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function StaffDashboard() {
  const { user } = useAuth();
  const [day, setDay] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState('');
  const canSell = hasPermission(user, 'pos');
  const seesStock = hasPermission(user, 'stock') || hasPermission(user, 'inventory');

  useEffect(() => {
    client
      .get('/sales/my-day')
      .then((r) => setDay(r.data.data))
      .catch((err) => setError(err.friendlyMessage || 'Could not load your dashboard.'));
    if (seesStock) {
      client
        .get('/inventory/alerts/summary')
        .then((r) => setAlerts(r.data.data))
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="rounded-xl bg-brand-50 p-4 text-sm text-brand-700">{error}</div>;
  if (!day) return <PageSpinner />;

  const t = day.totals;
  const actions = ACTIONS.filter((a) => hasPermission(user, a.module));
  const firstName = (user?.name || '').split(' ')[0];
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="mx-auto max-w-[1200px] space-y-6">
      {/* Greeting */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{today}</p>
          <h1 className="mt-1 text-[30px] font-extrabold leading-tight tracking-tight text-neutral-950" style={DISPLAY}>
            {greeting()}
            {firstName ? `, ${firstName}` : ''}.
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-neutral-500">
            <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">{ROLE_LABEL[user?.role] || 'Staff'}</span>
            Here is your day so far.
          </p>
        </div>
        <Link to="/my-report" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:text-brand-800">
          Open My Report <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {/* Your day */}
      <section className="relative overflow-hidden rounded-3xl surface-blue p-6 sm:p-7">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="relative grid gap-6 md:grid-cols-[1.2fr_1fr_1fr_1fr] md:items-end">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-neutral-500">You sold</p>
            <p className="figure mt-2 text-4xl font-extrabold sm:text-[42px]">{formatCurrency(t.sales)}</p>
            <p className="mt-1 text-sm text-neutral-500">
              {t.invoices} invoice{t.invoices === 1 ? '' : 's'}
              {day.since ? ` since the last Close Day (${time(day.since)})` : ''}
            </p>
          </div>
          <DayFigure label="Money taken" value={formatCurrency(t.received)} />
          <DayFigure label="On credit" value={formatCurrency(t.credit)} />
          <DayFigure label="From wallets" value={formatCurrency(t.fromWallet)} />
        </div>
      </section>

      {/* What I can do */}
      {actions.length > 0 && (
        <section>
          <p className="eyebrow mb-3">Start work</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {actions.map(({ to, label, hint, icon: Icon, primary }) => (
              <Link
                key={to}
                to={to}
                className={`group flex items-center gap-3 rounded-2xl p-4 transition ${
                  primary ? 'bg-primary text-white hover:bg-primary-hover' : 'border border-neutral-200/80 bg-white hover:border-brand-300 hover:bg-brand-50'
                }`}
              >
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${primary ? 'bg-white/20 text-white' : 'bg-brand-50 text-brand-600'}`}>
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className={`block truncate font-semibold ${primary ? 'text-white' : 'text-neutral-900'}`}>{label}</span>
                  <span className={`block truncate text-xs ${primary ? 'text-white/80' : 'text-neutral-500'}`}>{hint}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Stock health */}
      {seesStock && alerts && (
        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-neutral-200/80 bg-neutral-200/80 lg:grid-cols-4">
          <HealthTile label="Low stock" value={alerts.lowStock.length} hint="at or below minimum" icon={AlertTriangle} />
          <HealthTile label="Out of stock" value={alerts.outOfStockCount} hint="nothing left" icon={PackageX} />
          <HealthTile label="Expired" value={alerts.expired.length} hint="remove from shelves" icon={Package} />
          <HealthTile label="Expiring soon" value={alerts.nearExpiry.length} hint="within a month" icon={CalendarClock} />
        </section>
      )}

      {/* My latest sales / items */}
      {canSell && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="My latest invoices" icon={Receipt}>
            {day.invoices.length === 0 ? (
              <Empty text="No sales yet today." />
            ) : (
              <ul className="divide-y divide-neutral-100">
                {day.invoices.slice(0, 6).map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-neutral-900">{s.customerName}</span>
                      <span className="flex items-center gap-1 text-xs text-neutral-500">
                        <Clock className="h-3 w-3" /> {time(s.time)} · {s.receiptNumber}
                      </span>
                    </span>
                    <span className="figure font-semibold text-neutral-900">{formatCurrency(s.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="What I sold" icon={ShoppingCart}>
            {day.items.length === 0 ? (
              <Empty text="Nothing sold yet." />
            ) : (
              <ul className="divide-y divide-neutral-100">
                {day.items.slice(0, 6).map((it) => (
                  <li key={it.name} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-neutral-900">{it.name}</span>
                    <span className="shrink-0 text-neutral-500">
                      ×{it.quantity} · <span className="figure font-semibold text-neutral-900">{formatCurrency(it.total)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function DayFigure({ label, value }) {
  return (
    <div className="border-t border-white/40 pt-3 md:border-l md:border-t-0 md:pl-5 md:pt-0">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-neutral-500">{label}</p>
      <p className="figure mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

function HealthTile({ label, value, hint, icon: Icon }) {
  const alert = value > 0;
  return (
    <Link to="/inventory" className="flex items-center gap-4 bg-white p-5 transition-colors hover:bg-neutral-50">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${alert ? 'bg-primary text-white' : 'bg-neutral-100 text-neutral-500'}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="eyebrow block truncate">{label}</span>
        <span className={`figure block text-2xl font-extrabold leading-tight ${alert ? 'text-brand-700' : 'text-neutral-950'}`}>{value}</span>
        <span className="block truncate text-[11px] text-neutral-400">{hint}</span>
      </span>
    </Link>
  );
}

function Panel({ title, icon: Icon, children }) {
  return (
    <section className="flex flex-col rounded-3xl border border-neutral-200/80 bg-white">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-6 py-4">
        <Icon className="h-4 w-4 text-brand-600" />
        <h2 className="text-base font-bold text-neutral-950" style={DISPLAY}>
          {title}
        </h2>
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

function Empty({ text }) {
  return <p className="px-6 py-10 text-center text-sm text-neutral-400">{text}</p>;
}
