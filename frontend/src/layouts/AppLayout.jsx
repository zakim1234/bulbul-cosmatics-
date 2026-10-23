import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Boxes,
  Tag,
  ShoppingCart,
  Users,
  Building2,
  BarChart3,
  BadgePercent,
  PackageCheck,
  Wallet,
  FileText,
  Receipt,
  HandCoins,
  Handshake,
  Archive,
  Percent,
  LogOut,
  Menu,
  X,
  UserCog,
  CalendarCheck,
  SlidersHorizontal,
  Banknote,
  Globe2,
  Store,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { hasPermission } from '../constants/permissions.js';
import { BUSINESS } from '../constants/business.js';
import logo from '../images/logo.svg';
import BranchSwitcher from '../components/BranchSwitcher.jsx';
import { getSelectedBranch } from '../api/client.js';

// The Super Admin outside any branch sees only the company-wide pages; a
// branch's own pages appear once they open a branch.
const OVERVIEW_PATHS = ['/super-dashboard', '/all-branches', '/reports', '/items-sold', '/users', '/branches'];
const inOverviewPath = (path) => OVERVIEW_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
const inOverview = (user) => !!user?.isSuperAdmin && !getSelectedBranch();

// `module: null` means always visible to any authenticated user (no
// standalone permission gate) -- Dashboard only, per the deliberate choice
// to leave it ungated ("if appropriate").
const navItems = [
  { to: '/super-dashboard', label: 'Dashboard', icon: LayoutDashboard, module: null, superAdmin: true },
  { to: '/all-branches', label: 'All Branches', icon: Globe2, module: null, superAdmin: true },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, module: null },
  { to: '/stock', label: 'Stock', icon: Boxes, module: 'stock' },
  { to: '/stock-adjustments', label: 'Stock Adjustment', icon: SlidersHorizontal, module: 'stock' },
  { to: '/inventory', label: 'Inventory', icon: Boxes, module: 'inventory' },
  { to: '/categories', label: 'Categories', icon: Tag, module: 'categories' },
  { to: '/pos', label: 'Seller / POS', icon: ShoppingCart, module: 'pos' },
  { to: '/daily-closing', label: 'Daily Closing', icon: CalendarCheck, module: 'pos' },
  { to: '/quotations', label: 'Quotation', icon: FileText, module: 'quotations' },
  { to: '/purchases', label: 'Purchase Invoices', icon: FileText, module: 'purchases' },
  { to: '/accounts', label: 'Accounts', icon: Wallet, module: 'accounts' },
  { to: '/partners', label: 'Partners / Investors', icon: Handshake, module: 'partners' },
  { to: '/fixed-assets', label: 'Fixed Assets', icon: Archive, module: 'fixedAssets' },
  { to: '/zakat', label: 'Zakat', icon: Percent, module: 'zakat' },
  { to: '/customers', label: 'Customers', icon: Users, module: 'customers' },
  { to: '/suppliers', label: 'Suppliers', icon: Building2, module: 'suppliers' },
  { to: '/supplier-invoices', label: 'Supplier Invoices', icon: Receipt, module: 'supplierInvoices' },
  { to: '/expenses', label: 'Expenses', icon: HandCoins, module: 'expenses' },
  { to: '/salaries', label: 'Salaries', icon: Banknote, module: null, roles: ['admin', 'manager'] },
  { to: '/commissions', label: 'Commissions', icon: BadgePercent, module: null, roles: ['admin', 'manager'] },
  { to: '/reports', label: 'Reports', icon: BarChart3, module: 'reports' },
  { to: '/items-sold', label: 'Items Sold', icon: PackageCheck, module: 'reports' },
];

function SidebarContent({ onNavigate }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="bg-bulbul flex h-full flex-col text-white">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <img src={logo} alt={BUSINESS.name} className="h-12 w-12 shrink-0 drop-shadow-[0_4px_12px_rgba(224,72,137,0.45)]" />
        <div className="min-w-0">
          <p className="font-display truncate text-lg font-semibold leading-tight text-white">Bulbul</p>
          <p className="text-gold-shine truncate text-[11px] font-medium uppercase leading-tight tracking-[0.32em]">Cosmetics</p>
        </div>
      </div>
      <div className="mx-5 mb-4 h-px bg-gradient-to-r from-transparent via-gold-400/50 to-transparent" />

      <BranchSwitcher />
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3 pt-1">
        {navItems
          .filter(({ module, roles, superAdmin }) => (superAdmin ? !!user?.isSuperAdmin : roles ? roles.includes(user?.role) : module === null || hasPermission(user, module)))
          .concat(user?.role === 'admin' ? [{ to: '/users', label: 'Users', icon: UserCog, module: null }] : [])
          .concat(user?.isSuperAdmin ? [{ to: '/branches', label: 'Branches', icon: Store, module: null }] : [])
          .filter(({ to }) => (inOverview(user) ? OVERVIEW_PATHS.includes(to) : !['/all-branches', '/super-dashboard'].includes(to)))
          .map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-brand-500/90 to-brand-700/80 font-medium text-white shadow-lg shadow-brand-950/40'
                  : 'font-normal text-white/65 hover:bg-white/[0.07] hover:text-white'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className={`absolute -left-3 h-6 w-1 rounded-r-full ${isActive ? 'bg-gold-300' : 'bg-transparent'}`} />
                <Icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? 'text-gold-200' : 'text-white/45 group-hover:text-gold-200'}`} />
                <span className="truncate">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <div className="mb-1.5 flex items-center gap-3 rounded-xl bg-white/[0.06] px-3 py-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gold-200 to-gold-500 text-xs font-semibold text-brand-950">
            {user?.name?.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{user?.name}</p>
            <p className="truncate text-xs font-normal capitalize text-white/50">{user?.role}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-normal text-white/60 transition-colors hover:bg-white/[0.07] hover:text-brand-200"
        >
          <LogOut className="h-[18px] w-[18px]" />
          Logout
        </button>
      </div>
    </div>
  );
}

export default function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (inOverview(user) && !inOverviewPath(location.pathname)) navigate('/super-dashboard', { replace: true });
  }, [user, location.pathname, navigate]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop / tablet sidebar */}
      <aside className="hidden w-64 shrink-0 no-print md:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden no-print">
          <div
            className="absolute inset-0 bg-brand-950/50 backdrop-blur-sm transition-opacity"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-72 shadow-2xl transition-transform duration-200">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-2.5 top-2.5 z-10 rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="bg-bulbul flex items-center gap-3 px-4 py-3 md:hidden no-print">
          <button onClick={() => setMobileOpen(true)} className="rounded-lg p-1.5 text-white/80 hover:bg-white/10">
            <Menu className="h-5 w-5" />
          </button>
          <img src={logo} alt={BUSINESS.name} className="h-8 w-8" />
          <p className="font-display text-base font-semibold text-white">
            Bulbul <span className="text-gold-shine">Cosmetics</span>
          </p>
        </header>

        <header className="hidden items-center justify-between border-b border-brand-100/70 bg-white/70 px-6 py-3 backdrop-blur md:flex no-print">
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Sparkles className="h-4 w-4 text-gold-400" />
            <span className="font-display italic text-brand-800">Beauty that sells itself</span>
          </p>
          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-400">
              {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
            <span className="flex items-center gap-2 rounded-full bg-brand-50 py-1 pl-1 pr-3 text-xs font-medium text-brand-800 ring-1 ring-brand-100">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-800 text-[10px] font-semibold text-white">
                {user?.name?.slice(0, 2).toUpperCase()}
              </span>
              {user?.name}
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
