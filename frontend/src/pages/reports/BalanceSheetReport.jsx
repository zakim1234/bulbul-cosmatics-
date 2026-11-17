import { useCallback, useEffect, useState } from 'react';
import { Download, Printer, RefreshCw, CheckCircle2, AlertTriangle, Wallet, Scale, Pencil } from 'lucide-react';
import Modal from '../../components/ui/Modal.jsx';
import { FormField } from '../../components/ui/Field.jsx';
import client, { isAllBranchesView } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { printReport } from '../../utils/printReport.js';
import { formatMoney } from '../../utils/format.js';
import Button from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Field.jsx';
import SharePdfButton from '../../components/SharePdfButton.jsx';
import { PageSpinner } from '../../components/ui/Spinner.jsx';
import { BUSINESS } from '../../constants/business.js';
import BusinessContacts from '../../components/docs/BusinessContacts.jsx';
import { useBranchNames } from '../../hooks/useBranchNames.js';
import logo from '../../images/logo.png';
import BalanceGapPanel from './BalanceGapPanel.jsx';

const pad = (n) => String(n).padStart(2, '0');
const todayString = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function longDay(s) {
  return new Date(`${s}T12:00:00`).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function Amount({ value }) {
  const negative = value < 0;
  // A minus figure (a loss, money owed) shows in red -- green read as a gain.
  return <span className={negative ? 'text-red-600' : ''}>{negative ? `-${formatMoney(-value)}` : formatMoney(value)}</span>;
}

// Opening balances: the profit the company already had when it moved to this
// system, typed in from the old books (QuickBooks Profit & Loss / Balance
// Sheet). Super Admin only.
function OpeningEquityModal({ open, onClose, onSaved, difference }) {
  const toast = useToast();
  const [ni, setNi] = useState('');
  const [re, setRe] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    client.get('/reports/opening-equity').then((res) => {
      const d = res.data.data;
      setNi(d.openingNetIncome ? String(d.openingNetIncome) : '');
      setRe(d.openingRetainedEarnings ? String(d.openingRetainedEarnings) : '');
      setNote(d.note || '');
    }).catch(() => {});
  }, [open]);
  const save = async () => {
    setSaving(true);
    try {
      await client.put('/reports/opening-equity', { openingNetIncome: Number(ni) || 0, openingRetainedEarnings: Number(re) || 0, note });
      toast.success('Opening balances saved.');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Opening balances (from the old system)" footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">Type the figures exactly as they are in the old books (e.g. QuickBooks). Minus for a loss.</p>
        <FormField label={`Net income ${new Date().getFullYear()} (this year, before the move)`}>
          <Input type="number" step="0.01" value={ni} onChange={(e) => setNi(e.target.value)} placeholder="0.00" />
          <p className="mt-1 text-xs text-neutral-500">From the old Profit &amp; Loss: this year's Net Income up to the day you moved.</p>
        </FormField>
        <FormField label="Retained earnings (all earlier years)">
          <Input type="number" step="0.01" value={re} onChange={(e) => setRe(e.target.value)} placeholder="0.00" />
          <p className="mt-1 text-xs text-neutral-500">From the old Balance Sheet: Retained Earnings.</p>
        </FormField>
        {difference !== 0 && (
          <button type="button" onClick={() => setRe(String(Math.round(((Number(re) || 0) + difference) * 100) / 100))} className="w-full rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2 text-left text-xs text-brand-800 hover:bg-brand-100">
            The Balance Sheet is out by <b>{formatMoney(Math.abs(difference))}</b>. Click to add it to Retained earnings so it balances.
          </button>
        )}
        <FormField label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. From QuickBooks, 10 Nov 2026" /></FormField>
      </div>
    </Modal>
  );
}

function SummaryCard({ label, value, tone }) {
  const styles = tone === 'red' ? 'bg-primary text-white' : tone === 'black' ? 'surface-blue text-white' : 'border border-neutral-300 bg-white';
  return (
    <div className={`rounded-xl px-4 py-3 text-center ${styles}`}>
      <p className={`text-[10px] uppercase tracking-wider ${tone ? 'text-white/70' : 'text-neutral-500'}`}>{label}</p>
      <p className="mt-1 text-xl font-bold figure">{value < 0 ? `-${formatMoney(-value)}` : formatMoney(value)}</p>
    </div>
  );
}

function Side({ title, icon: Icon, children }) {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 print:break-inside-avoid">
      <h2 className="flex items-center gap-2 surface-blue px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-white">
        <Icon className="h-4 w-4 text-brand-400" /> {title}
      </h2>
      <div className="p-2">{children}</div>
    </section>
  );
}

function Group({ label, children }) {
  return (
    <div className="mb-2">
      <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</p>
      {children}
    </div>
  );
}

function Line({ label, hint, value }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-50">
      <span className="text-neutral-700">
        {label}
        {hint && <span className="ml-1.5 text-[11px] text-neutral-400">{hint}</span>}
      </span>
      <span className="tabular-nums">
        <Amount value={value} />
      </span>
    </div>
  );
}

function Subtotal({ label, value }) {
  return (
    <div className="mx-2 mt-1 flex items-center justify-between border-t border-neutral-300 pt-1.5 text-sm font-bold">
      <span>{label}</span>
      <span className="tabular-nums">
        <Amount value={value} />
      </span>
    </div>
  );
}

function Grand({ label, value }) {
  return (
    <div className="mt-2 flex items-center justify-between rounded-lg bg-neutral-100 px-3 py-2.5 text-sm font-extrabold uppercase tracking-wide">
      <span>{label}</span>
      <span className="text-base tabular-nums">
        <Amount value={value} />
      </span>
    </div>
  );
}


export default function BalanceSheetReport() {
  const { user: me } = useAuth();
  const allBranches = isAllBranchesView(me);
  const isSuperAdmin = !!me?.isSuperAdmin;
  const [openingOpen, setOpeningOpen] = useState(false);
  const branchName = useBranchNames(allBranches);
  const toast = useToast();
  const [date, setDate] = useState(todayString());
  const [report, setReport] = useState(null);
  const [gapOpen, setGapOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    client
      .get('/reports/balance-sheet', { params: { date } })
      .then((res) => setReport(res.data.data))
      .catch((err) => {
        setReport(null);
        toast.error(err.friendlyMessage || 'Failed to load the Balance Sheet.');
      })
      .finally(() => setLoading(false));
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const exportExcel = async () => {
    setExporting(true);
    try {
      const res = await client.get('/reports/balance-sheet/export', { params: { date }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `balance-sheet_${date}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not export to Excel.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3 rounded-xl border border-neutral-200/80 bg-white p-4 no-print">
        <label className="text-sm font-medium text-neutral-700">
          As of
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-48" />
        </label>
        <div className="flex gap-2">
          <SharePdfButton fileName={`Balance-Sheet_${date}`} message={`Balance Sheet — ${date}`} />
          <Button variant="secondary" onClick={() => printReport('portrait')}>
            <Printer className="h-4 w-4" /> Print
          </Button>
          <Button variant="secondary" onClick={exportExcel} loading={exporting}>
            <Download className="h-4 w-4" /> Excel
          </Button>
          <Button variant="secondary" onClick={load} loading={loading}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {loading && !report ? (
        <PageSpinner />
      ) : !report ? (
        <p className="py-10 text-center text-sm text-neutral-400">The report could not be loaded. Adjust the date or press Refresh.</p>
      ) : (
        <div
          id="print-area"
          className={`mx-auto max-w-5xl rounded-2xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-sm sm:p-8 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none ${loading ? 'opacity-60' : ''}`}
          style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}
        >
          <div className="flex flex-col items-center text-center">
            <img src={logo} alt={BUSINESS.name} className="h-24 w-auto object-contain" />
            <BusinessContacts className="mt-2" />
          </div>

          <div className="mt-4 h-1 bg-gradient-to-r from-brand-500 to-emerald-500" />
          <div className="flex flex-wrap items-center justify-between gap-2 surface-blue px-4 py-2 text-white">
            <p className="text-sm font-bold uppercase tracking-[0.25em]">
              Balance Sheet{allBranches && <span className="ml-2 tracking-wider text-brand-300">· All branches</span>}
            </p>
            <p className="text-[11px]">
              As of <span className="font-semibold">{longDay(report.asOf)}</span>
            </p>
          </div>

          {report.asOfNote && <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700 no-print">{report.asOfNote}</p>}

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3 print:grid-cols-3">
            <SummaryCard label="Total assets" value={report.assets.totalAssets} />
            <SummaryCard label="Total liabilities" value={report.liabilities.totalLiabilities} tone="red" />
            <SummaryCard label="Total equity" value={report.equity.totalEquity} tone="black" />
          </div>

          <div
            role={report.isBalanced ? undefined : 'button'}
            title={report.isBalanced ? undefined : 'Click to see where the difference comes from'}
            // Opening "where from?" also works the sheet out again, so the
            // figure here and the one in the panel are from the same moment.
            onClick={report.isBalanced ? undefined : () => { if (!gapOpen) load(); setGapOpen(!gapOpen); }}
            className={`mt-3 flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${
              report.isBalanced ? 'bg-neutral-100 text-neutral-700' : 'cursor-pointer bg-brand-50 text-brand-700 hover:bg-brand-100'
            }`}
          >
            {report.isBalanced ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {report.isBalanced
              ? 'Balanced — Assets = Liabilities + Equity'
              : `Out of balance by ${formatMoney(Math.abs(report.difference))} (Assets ${formatMoney(report.assets.totalAssets)} vs Liabilities + Equity ${formatMoney(report.totalLiabilitiesAndEquity)})`}
            {!report.isBalanced && <span className="no-print text-xs font-normal underline">Where from?</span>}
          </div>
          {!report.isBalanced && gapOpen && <BalanceGapPanel key={report.difference} date={date} onClose={() => setGapOpen(false)} />}

          <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 print:grid-cols-2">
            <Side title="Assets" icon={Wallet}>
              <Group label="Current assets">
                <Line label="Cash & bank (accounts)" value={report.assets.cash} />
                {!!report.assets.companyWallet && <Line label="Taken to company wallet" hint="By the Super Admin" value={report.assets.companyWallet} />}
                <Line label="Accounts receivable" hint="Customer debt" value={report.assets.receivable} />
                <Line label="Inventory" hint="Stock at cost" value={report.assets.inventory} />
                <Subtotal label="Total current assets" value={report.assets.totalCurrentAssets} />
              </Group>
              <Group label="Fixed assets">
                <Line label="Fixed assets" value={report.assets.fixedAssets} />
              </Group>
              <Grand label="Total assets" value={report.assets.totalAssets} />
            </Side>

            <Side title="Liabilities & Equity" icon={Scale}>
              <Group label="Liabilities">
                <Line label="Accounts payable" hint="Supplier debt" value={report.liabilities.payable} />
                <Line label="Customer deposits" hint="Money in customers' wallets" value={report.liabilities.customerDeposits ?? 0} />
                {!!report.liabilities.fixedAssetDebt && <Line label="Fixed asset debt" hint="Computers and building, bought with money that is not the company's -- less what was paid back" value={report.liabilities.fixedAssetDebt} />}
                {/* From the Liabilities page (sidebar). */}
                {!!report.liabilities.unpaidExpenses && <Line label="Unpaid expenses" hint="Liabilities -- charged, not paid yet" value={report.liabilities.unpaidExpenses} />}
                {!!report.liabilities.openingLiabilities && <Line label="Opening liabilities" hint="Debts from the old system" value={report.liabilities.openingLiabilities} />}
                <Subtotal label="Total liabilities" value={report.liabilities.totalLiabilities} />
              </Group>
              <Group label="Equity">
                <Line label="Partners' capital" value={report.equity.partnersCapital} />
                {/* All branches: each partner line names the branch the money is in,
                    and one person's lines sit together. */}
                {(allBranches
                  ? [...(report.equity.partners || [])].sort((a, b) => a.name.localeCompare(b.name) || branchName(a.branch).localeCompare(branchName(b.branch)))
                  : report.equity.partners || []
                ).map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 py-0.5 pl-6 pr-2 text-xs text-neutral-500">
                    <span>
                      {p.name}
                      {allBranches && <span className="ml-2 rounded bg-brand-100 px-1.5 py-px text-[10.5px] font-semibold text-brand-800">{branchName(p.branch)}</span>}
                    </span>
                    <span className="tabular-nums">
                      <Amount value={p.capital} />
                    </span>
                  </div>
                ))}
                <Line label="Retained earnings" hint={report.equity.openingRetainedEarnings ? `incl. ${formatMoney(report.equity.openingRetainedEarnings)} opening` : undefined} value={report.equity.retainedEarnings} />
                <Line label="Net income" hint={[report.equity.openingNetIncome ? `This fiscal year · incl. ${formatMoney(report.equity.openingNetIncome)} opening` : 'This fiscal year', report.equity.setAsideThisYear ? `less ${formatMoney(report.equity.setAsideThisYear)} set aside for the equipment` : ''].filter(Boolean).join(' · ')} value={report.equity.netIncome} />
                {!!report.equity.fixedAssetReserve && <Line label="Fixed asset reserve" hint="Profit set aside to pay the equipment debt back" value={report.equity.fixedAssetReserve} />}
                {!!report.equity.openingStock && <Line label="Opening stock" hint="Stock the company owned before the system (imported from Excel)" value={report.equity.openingStock} />}
                {isSuperAdmin && (
                  <button type="button" onClick={() => setOpeningOpen(true)} className="no-print ml-2 mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50">
                    <Pencil className="h-3.5 w-3.5" /> Opening balances (old system)
                  </button>
                )}
                <Subtotal label="Total equity" value={report.equity.totalEquity} />
              </Group>
              <Grand label="Total liabilities & equity" value={report.totalLiabilitiesAndEquity} />
            </Side>
          </div>

          <p className="mt-6 border-t border-neutral-200 pt-3 text-[11px] leading-relaxed text-neutral-400">
            Partners' Capital is the sum of every partner's current equity (Partners / Investors). Net Income is this fiscal year's profit to date;
            Retained Earnings is everything before that. Cash, Receivables, Inventory, Payables, Partners' Capital and Fixed Assets are today's figures —
            no historical snapshot is kept for a past date.
          </p>
          <p className="mt-2 text-center text-[10px] text-neutral-400">Printed {new Date().toLocaleString()}</p>
          <OpeningEquityModal open={openingOpen} onClose={() => setOpeningOpen(false)} onSaved={load} difference={report.difference || 0} />        </div>
      )}
    </div>
  );
}
