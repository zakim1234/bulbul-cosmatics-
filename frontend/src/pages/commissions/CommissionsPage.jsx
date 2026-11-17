import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BadgePercent, FileText, XCircle, Plus, Trash2 } from 'lucide-react';
import client, { isAllBranchesView } from '../../api/client.js';
import { useBranchNames } from '../../hooks/useBranchNames.js';
import PageBranchPicker from '../../components/PageBranchPicker.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import Badge from '../../components/ui/Badge.jsx';
import Modal from '../../components/ui/Modal.jsx';
import { FormField, Input, Select, Textarea } from '../../components/ui/Field.jsx';
import AccountSelect from '../../components/AccountSelect.jsx';
import CommissionAccountCard from './CommissionAccountCard.jsx';
import { PageSpinner } from '../../components/ui/Spinner.jsx';

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const DEFAULT_KEY = { month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`, year: String(now.getFullYear()) };
const round2 = (n) => Math.round(n * 100) / 100;
// The part of the year's net income shared out to the staff.
const STAFF_SHARE = 30;

export function periodLabel(type, key) {
  if (type === 'year') return String(key);
  const [y, m] = String(key).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// Commission: for one month or one year, each person gets the percentage
// typed in for them, of that period's profit before commission. Paid as a
// "Commission" expense, so the partners later share what is left.
export default function CommissionsPage() {
  return (
    <PageBranchPicker>
      <CommissionsForBranch />
    </PageBranchPicker>
  );
}

function CommissionsForBranch() {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') === 'year' ? 'year' : 'month';
  const key = params.get('key') || DEFAULT_KEY[type];
  // Two kinds: staff commission (paid by the branch admin) and admin
  // commission (branch admins, paid only by the Super Admin).
  const kind = params.get('kind') === 'admin' ? 'ADMIN' : 'STAFF';
  const overview = isAllBranchesView(user);
  const branchName = useBranchNames(overview);
  const isAdmin = !overview && !!user?.isSuperAdmin;
  const go = (next) => setParams({ kind: kind === 'ADMIN' ? 'admin' : 'staff', type, key, ...next });
  const [preview, setPreview] = useState(null);
  const [percents, setPercents] = useState({});
  const [others, setOthers] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const loadPreview = () => {
    setPreview(null);
    client
      .get('/commissions/preview', { params: { type, key } })
      .then((r) => {
        setPreview(r.data.data);
        setPercents({});
        setOthers([]);
      })
      .catch((err) => toast.error(err.friendlyMessage || 'Could not load the period profit.'));
  };
  const loadHistory = () =>
    client
      .get('/commissions')
      .then((r) => setHistory(r.data.data))
      .catch(() => setHistory([]));

  useEffect(() => {
    loadPreview();
  }, [type, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadHistory();
  }, []);
  // The branch's commission account (the staff's 30% is kept there).
  const [commissionData, setCommissionData] = useState(null);
  const loadCommissionAccount = () => {
    if (overview) return;
    client
      .get('/commissions/account')
      .then((r) => {
        setCommissionData(r.data.data);
        if (r.data.data.account) setAccountId(String(r.data.data.account.id));
      })
      .catch(() => setCommissionData(null));
  };
  useEffect(() => {
    loadCommissionAccount();
  }, [overview]); // eslint-disable-line react-hooks/exhaustive-deps
  const commissionAccount = commissionData?.account || null;

  const base = preview?.baseProfit || 0;
  const paidIds = new Set((preview?.earlier || []).flatMap((c) => c.lines.map((l) => String(l.user || l.worker || ''))).filter(Boolean));
  const eligible = (s) => (kind === 'ADMIN' ? s.role === 'admin' && !s.isSuperAdmin && !s.isWorker : s.role !== 'admin');
  const staffLines = (preview?.staff || []).filter((s) => eligible(s) && !paidIds.has(String(s.id))).map((s) => ({ ...s, percent: Number(percents[s.id]) || 0 }));
  const otherLines = others.map((o) => ({ ...o, percent: Number(o.percent) || 0 }));
  const chosen = [...staffLines.filter((s) => s.percent > 0).map((s) => (s.isWorker ? { workerId: s.id, percent: s.percent } : { userId: s.id, percent: s.percent })), ...otherLines.filter((o) => o.name.trim() && o.percent > 0).map((o) => ({ name: o.name.trim(), percent: o.percent }))];
  const totalPercent = round2(chosen.reduce((s, l) => s + l.percent, 0));
  const earlierTotal = round2((preview?.earlier || []).reduce((s, c) => s + c.total, 0));
  const amountOf = (p) => round2((base * p) / 100);
  // The staff's share: 30% of the year's whole net income so far.
  const staffShare = Math.max(0, Math.round((preview?.yearProfit ?? base) * STAFF_SHARE) / 100);

  const pay = async () => {
    if (!chosen.length) return toast.error('Type a percentage for at least one person.');
    if (!accountId) return toast.error('Choose the account the commission is paid from.');
    setSaving(true);
    try {
      const r = await client.post('/commissions', { kind, type, key, paymentAccountId: accountId, note, lines: chosen });
      toast.success(`${formatCurrency(r.data.data.total)} commission paid to ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}.`);
      setNote('');
      loadPreview();
      loadHistory();
      loadCommissionAccount();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not pay the commission.');
    } finally {
      setSaving(false);
    }
  };

  const confirmCancel = async () => {
    setCancelling(true);
    try {
      await client.post(`/commissions/${cancelTarget.id}/cancel`, { reason: cancelReason });
      toast.success(`${cancelTarget.commissionNumber} cancelled; the money is back in ${cancelTarget.accountName}.`);
      setCancelTarget(null);
      setCancelReason('');
      loadPreview();
      loadHistory();
      loadCommissionAccount();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not cancel.');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Commissions"
        subtitle={
          overview
            ? 'All branches: each branch on its own. Pay every branch at once, or choose one branch above.'
            : "A percentage of the month's or year's profit, paid before the partners share the profit."
        }
      />

      <div className="mb-4 flex gap-1 border-b border-neutral-200">
        {[
          ['staff', 'Staff commission', 'Cashiers and managers'],
          ['admin', 'Admin commission', 'Branch admins'],
        ].map(([k, label, hint]) => {
          const active = (k === 'admin') === (kind === 'ADMIN');
          return (
            <button
              key={k}
              type="button"
              onClick={() => setParams({ kind: k, type, key })}
              className={`-mb-px border-b-2 px-4 py-2 text-left ${active ? 'border-brand-400 text-brand-700' : 'border-transparent text-neutral-500 hover:text-neutral-700'}`}
            >
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-[11px] text-neutral-400">{hint}</span>
            </button>
          );
        })}
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="inline-flex rounded-lg border border-neutral-200/80 bg-white p-1">
          {[
            ['month', 'Monthly'],
            ['year', 'Yearly'],
          ].map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => go({ type: t, key: DEFAULT_KEY[t] })}
              className={`rounded-md px-4 py-1.5 text-sm font-semibold transition ${type === t ? 'bg-primary text-white' : 'text-neutral-600 hover:bg-neutral-50'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {type === 'month' ? (
          <div className="w-44">
          <Input type="month" value={key} onChange={(e) => e.target.value && go({ key: e.target.value })} />
        </div>
        ) : (
          <div className="w-28">
          <Input type="number" min="2000" max="2100" value={key} onChange={(e) => e.target.value.length === 4 && go({ key: e.target.value })} />
        </div>
        )}
        {preview && (() => {
          // The staff's share: 30% of the year's whole net income so far
          // (the opening Net Income plus the profit since).
          const yearProfit = preview.yearProfit ?? base;
          const share = Math.max(0, Math.round(yearProfit * STAFF_SHARE) / 100);
          return (
            <div className={`rounded-xl px-5 py-3 ${share > 0 ? 'surface-blue text-white' : 'border border-neutral-200 bg-white text-neutral-700'}`}>
              <p className={`text-[11px] uppercase tracking-wider ${share > 0 ? 'text-white/70' : 'text-neutral-500'}`}>Staff share {STAFF_SHARE}% · {key.slice(0, 4)}</p>
              <p className="text-2xl font-bold figure">{formatCurrency(share)}</p>
            </div>
          );
        })()}
      </div>

      {!overview && preview && (
        <CommissionAccountCard data={commissionData} share={staffShare} onChanged={loadCommissionAccount} />
      )}

      {overview ? (
        <AllBranchesCommission kind={kind} type={type} periodKey={key} onPaid={loadHistory} />
      ) : !preview ? (
        <PageSpinner />
      ) : base <= 0 ? (
        <div className="mb-6 rounded-xl border border-neutral-200/80 bg-white p-4 text-sm text-neutral-500">{periodLabel(type, key)} has no profit to pay commission on.</div>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-5 lg:grid-cols-5">
          <div className="overflow-x-auto rounded-xl border border-neutral-200/80 bg-white lg:col-span-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  <th className="px-4 py-2.5">Person</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Phone</th>
                  <th className="px-4 py-2.5 text-right">Commission %</th>
                  <th className="px-4 py-2.5 text-right">Gets</th>
                </tr>
              </thead>
              <tbody>
                {staffLines.length === 0 && others.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-neutral-500">
                      {kind === 'ADMIN' ? 'No branch admins here yet.' : 'No cashiers or managers here yet.'} Add them on the Users page (with their branch).
                    </td>
                  </tr>
                )}
                {staffLines.map((s) => (
                  <tr key={s.id} className="border-b border-neutral-100">
                    <td className="px-4 py-2 font-semibold text-neutral-800">
                      {s.name}
                      {overview && <span className="block text-[11px] font-normal text-neutral-400">{branchName(s.branch)}</span>}
                    </td>
                    <td className="px-4 py-2 capitalize text-neutral-500">{s.isWorker ? `Worker${s.job ? ` · ${s.job}` : ''}` : s.role}</td>
                    <td className="px-4 py-2 tabular-nums text-neutral-600">{s.phone || '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        placeholder="—"
                        disabled={!isAdmin}
                        className="ml-auto w-24 text-right"
                        value={percents[s.id] ?? ''}
                        onChange={(e) => setPercents((p) => ({ ...p, [s.id]: e.target.value }))}
                      />
                    </td>
                    <td className="px-4 py-2 text-right font-bold tabular-nums">{s.percent > 0 ? formatCurrency(amountOf(s.percent)) : '—'}</td>
                  </tr>
                ))}
                {others.map((o, i) => (
                  <tr key={i} className="border-b border-neutral-100">
                    <td className="px-4 py-2" colSpan={3}>
                      <div className="flex items-center gap-2">
                        <Input placeholder="Name" value={o.name} onChange={(e) => setOthers((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                        <Button size="sm" variant="secondary" onClick={() => setOthers((list) => list.filter((_, j) => j !== i))}>
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </Button>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        className="ml-auto w-24 text-right"
                        value={o.percent}
                        onChange={(e) => setOthers((list) => list.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))}
                      />
                    </td>
                    <td className="px-4 py-2 text-right font-bold tabular-nums">{Number(o.percent) > 0 ? formatCurrency(amountOf(Number(o.percent))) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-900 font-bold">
                  <td className="px-4 py-2.5" colSpan={3}>
                    Total
                  </td>
                  <td className={`px-4 py-2.5 text-right tabular-nums ${totalPercent > 100 ? 'text-brand-700' : ''}`}>{totalPercent}%</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(amountOf(totalPercent))}</td>
                </tr>
              </tfoot>
            </table>
            {isAdmin && kind === 'STAFF' && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <Button size="sm" variant="secondary" onClick={() => setOthers((list) => [...list, { name: '', percent: '' }])}>
                  <Plus className="h-3.5 w-3.5" /> Add someone else
                </Button>
                <p className="text-xs text-neutral-500">Leave a box empty for anyone who gets nothing.</p>
              </div>
            )}
          </div>

          <div className="space-y-3 lg:col-span-2">
            {preview.earlier.length > 0 && (
              <div className="rounded-xl border border-neutral-200/80 bg-white p-3 text-sm">
                <p className="font-semibold text-neutral-800">Already paid for {periodLabel(type, key)}: {formatCurrency(earlierTotal)}</p>
                <p className="text-xs text-neutral-500">{preview.earlier.flatMap((c) => c.lines.map((l) => `${l.name} ${l.percent}%`)).join(' · ')}</p>
              </div>
            )}
            <FormField label="Paid from account" required>
              <AccountSelect key={commissionAccount ? `c${commissionAccount.balance}` : "all"} value={accountId} onChange={setAccountId} showBalance onlyId={commissionAccount ? String(commissionAccount.id) : null} />
            </FormField>
            <FormField label="Note">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </FormField>
            {isAdmin ? (
              <Button className="w-full" loading={saving} onClick={pay}>
                <BadgePercent className="h-4 w-4" /> Pay {formatCurrency(amountOf(totalPercent))} commission
              </Button>
            ) : (
              <p className="text-xs text-neutral-500">
                {overview ? 'Choose a branch above to pay commission.' : 'Only the Super Admin pays commission.'}
              </p>
            )}
          </div>
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-neutral-500">Commission paid</h2>
      <div className="overflow-x-auto rounded-xl border border-neutral-200/80 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              <th className="px-4 py-2.5">Number</th>
              {overview && <th className="px-4 py-2.5">Branch</th>}
              <th className="px-4 py-2.5">Kind</th>
              <th className="px-4 py-2.5">Period</th>
              <th className="px-4 py-2.5">People</th>
              <th className="px-4 py-2.5 text-right">Total</th>
              <th className="px-4 py-2.5">Paid</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {history === null ? (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-neutral-400">
                  Loading…
                </td>
              </tr>
            ) : history.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-neutral-400">
                  No commission paid yet.
                </td>
              </tr>
            ) : (
              history.map((c) => (
                <tr key={c.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-2.5 font-semibold text-neutral-800">{c.commissionNumber}</td>
                  {overview && <td className="px-4 py-2.5 text-neutral-500">{branchName(c.branch)}</td>}
                  <td className="px-4 py-2.5 text-neutral-600">{c.kind === 'ADMIN' ? 'Admin' : 'Staff'}</td>
                  <td className="px-4 py-2.5">
                    {periodLabel(c.periodType, c.periodKey)} <span className="text-xs text-neutral-400">{c.periodType === 'year' ? 'yearly' : 'monthly'}</span>
                  </td>
                  <td className="px-4 py-2.5 text-neutral-600">{c.lines.map((l) => `${l.name} ${l.percent}%`).join(', ')}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(c.total)}</td>
                  <td className="px-4 py-2.5 text-neutral-600">
                    {formatDate(c.createdAt)} · {c.accountName}
                  </td>
                  <td className="px-4 py-2.5">{c.status === 'ACTIVE' ? <Badge color="green">Paid</Badge> : <Badge color="slate">Cancelled</Badge>}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      <Link to={`/commissions/${c.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50">
                        <FileText className="h-3.5 w-3.5" /> View
                      </Link>
                      {!overview && c.status === 'ACTIVE' && user?.isSuperAdmin && (
                        <Button size="sm" variant="secondary" onClick={() => setCancelTarget(c)}>
                          <XCircle className="h-3.5 w-3.5 text-brand-600" /> Cancel
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal open={!!cancelTarget} onClose={() => setCancelTarget(null)} title={`Cancel ${cancelTarget?.commissionNumber}`} size="sm">
        {cancelTarget && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              The {formatCurrency(cancelTarget.total)} commission comes back into {cancelTarget.accountName}.
            </p>
            <FormField label="Reason">
              <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Optional" />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCancelTarget(null)}>
                Keep it
              </Button>
              <Button loading={cancelling} onClick={confirmCancel}>
                <XCircle className="h-4 w-4" /> Cancel commission
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// All branches at once: each branch on its own card -- its own profit,
// people (users and workers without a login) and the account it pays from.
function AllBranchesCommission({ kind, type, periodKey, onPaid }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [percents, setPercents] = useState({});
  const [accounts, setAccounts] = useState({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    setRows(null);
    client
      .get('/commissions/branches-preview', { params: { type, key: periodKey } })
      .then((r) => {
        setRows(r.data.data);
        setPercents({});
      })
      .catch((err) => {
        toast.error(err.friendlyMessage || 'Could not load the branches.');
        setRows([]);
      });
  };
  useEffect(load, [type, periodKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const eligible = (s) => (kind === 'ADMIN' ? s.role === 'admin' && !s.isSuperAdmin && !s.isWorker : s.role !== 'admin');
  const branchView = (b) => {
    const paid = new Set(b.earlier.flatMap((c) => c.lines.map((l) => String(l.user || l.worker || ''))).filter(Boolean));
    const people = b.people.filter((s) => eligible(s) && !paid.has(String(s.id))).map((s) => ({ ...s, percent: Number(percents[`${b.branchId}:${s.id}`]) || 0 }));
    const totalPercent = round2(people.reduce((s, p) => s + p.percent, 0));
    const amount = (p) => round2((b.baseProfit * p) / 100);
    return { people, totalPercent, amount, totalAmount: amount(totalPercent) };
  };
  const views = (rows || []).map((b) => ({ b, ...branchView(b) }));
  const grand = round2(views.reduce((s, v) => s + (v.b.baseProfit > 0 ? v.totalAmount : 0), 0));

  const payAll = async () => {
    const branches = views
      .filter((v) => v.b.baseProfit > 0 && v.totalPercent > 0)
      .map((v) => ({
        branchId: v.b.branchId,
        paymentAccountId: accounts[v.b.branchId] || '',
        lines: v.people.filter((p) => p.percent > 0).map((p) => (p.isWorker ? { workerId: p.id, percent: p.percent } : { userId: p.id, percent: p.percent })),
      }));
    if (!branches.length) return toast.error('Type a percentage for at least one person.');
    const missing = branches.find((x) => !x.paymentAccountId);
    if (missing) return toast.error(`${views.find((v) => v.b.branchId === missing.branchId).b.branchName}: choose the account the commission is paid from.`);
    setSaving(true);
    try {
      const r = await client.post('/commissions/all-branches', { kind, type, key: periodKey, note, branches });
      toast.success(`${formatCurrency(r.data.data.total)} commission paid in ${r.data.data.branches.length} branch(es).`);
      setNote('');
      load();
      onPaid();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not pay the commission.');
    } finally {
      setSaving(false);
    }
  };

  if (!rows) return <PageSpinner />;
  return (
    <div className="mb-6 space-y-4">
      {views.map(({ b, people, totalPercent, amount, totalAmount }) => (
        <div key={b.branchId} className="overflow-hidden rounded-xl border border-neutral-200/80 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 bg-neutral-50 px-4 py-3">
            <p className="font-bold text-neutral-900">{b.branchName}</p>
            <p className="text-sm text-neutral-600">
              Profit before commission: <span className={`font-bold tabular-nums ${b.baseProfit > 0 ? 'text-neutral-900' : 'text-red-600'}`}>{formatCurrency(b.baseProfit)}</span>
            </p>
          </div>
          {b.baseProfit <= 0 ? (
            <p className="px-4 py-4 text-sm text-neutral-500">No profit to pay commission on.</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                    <th className="px-4 py-2">Person</th>
                    <th className="px-4 py-2">Role</th>
                    <th className="px-4 py-2">Phone</th>
                    <th className="px-4 py-2 text-right">Commission %</th>
                    <th className="px-4 py-2 text-right">Gets</th>
                  </tr>
                </thead>
                <tbody>
                  {people.length === 0 && (
                    <tr>
                      <td className="px-4 py-4 text-center text-neutral-500" colSpan={5}>
                        {kind === 'ADMIN' ? 'No branch admins to pay.' : 'No staff or workers to pay.'}
                      </td>
                    </tr>
                  )}
                  {people.map((s) => (
                    <tr key={s.id} className="border-b border-neutral-100">
                      <td className="px-4 py-2 font-semibold text-neutral-800">{s.name}</td>
                      <td className="px-4 py-2 capitalize text-neutral-500">{s.isWorker ? `Worker${s.job ? ` · ${s.job}` : ''}` : s.role}</td>
                      <td className="px-4 py-2 tabular-nums text-neutral-600">{s.phone || '—'}</td>
                      <td className="px-4 py-2 text-right">
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          placeholder="—"
                          className="ml-auto w-24 text-right"
                          value={percents[`${b.branchId}:${s.id}`] ?? ''}
                          onChange={(e) => setPercents((p) => ({ ...p, [`${b.branchId}:${s.id}`]: e.target.value }))}
                        />
                      </td>
                      <td className="w-32 px-4 py-2 text-right font-bold tabular-nums">{s.percent > 0 ? formatCurrency(amount(s.percent)) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="w-64">
                  <Select value={accounts[b.branchId] || ''} onChange={(e) => setAccounts((m) => ({ ...m, [b.branchId]: e.target.value }))}>
                    <option value="">Paid from account...</option>
                    {b.accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} -- {formatCurrency(a.balance)}</option>
                    ))}
                  </Select>
                </div>
                <p className="text-sm font-bold tabular-nums">
                  {totalPercent}% · {formatCurrency(totalAmount)}
                </p>
              </div>
            </>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-neutral-200/80 bg-white p-4">
        <div className="min-w-[16rem] flex-1">
          <FormField label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </FormField>
        </div>
        <Button loading={saving} disabled={!(grand > 0)} onClick={payAll}>
          <BadgePercent className="h-4 w-4" /> Pay all branches {formatCurrency(grand)}
        </Button>
      </div>
    </div>
  );
}
