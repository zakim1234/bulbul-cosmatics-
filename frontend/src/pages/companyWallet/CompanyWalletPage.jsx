import { useCallback, useEffect, useState } from 'react';
import { Plus, ArrowDownCircle, ArrowUpCircle, Trash2, Pencil, PiggyBank, Store, FileText, Printer, Wallet, HandCoins } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import Modal from '../../components/ui/Modal.jsx';
import { FormField, Input, Select, Textarea } from '../../components/ui/Field.jsx';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Company wallets: money the owners keep apart from the shop. The Super Admin
// (or someone they allow) can put money in, take it out, or take it from the
// branches' accounts -- each "Take from branches" is one statement.
function WalletFormModal({ open, wallet, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) { setName(wallet?.name || ''); setNote(wallet?.note || ''); }
  }, [open, wallet]);
  const save = async () => {
    setSaving(true);
    try {
      const res = wallet ? await client.put(`/company-wallets/${wallet.id}`, { name, note }) : await client.post('/company-wallets', { name, note });
      toast.success(wallet ? 'Wallet updated.' : 'Wallet created.');
      onSaved(res.data.data);
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save the wallet.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={wallet ? 'Edit Wallet' : 'New Company Wallet'} footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}>
      <div className="space-y-4">
        <FormField label="Wallet name" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Group Wallet" /></FormField>
        <FormField label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this money is for" /></FormField>
      </div>
    </Modal>
  );
}

function MoneyModal({ mode, wallet, onClose, onSaved }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [person, setPerson] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (mode) { setAmount(''); setDate(today()); setPerson(''); setNote(''); }
  }, [mode]);
  const deposit = mode === 'DEPOSIT';
  const save = async () => {
    setSaving(true);
    try {
      await client.post(`/company-wallets/${wallet.id}/entries`, { type: mode, amount: Number(amount), date, person, note });
      toast.success(deposit ? 'Money put in.' : 'Money taken out.');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={!!mode} onClose={onClose} title={`${deposit ? 'Put money in' : 'Take money out'} — ${wallet?.name || ''}`} footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!(Number(amount) > 0)}>{deposit ? 'Deposit' : 'Withdraw'}</Button></>}>
      <div className="space-y-4">
        {!deposit && <p className="text-sm text-neutral-600">In the wallet now: <b>{formatCurrency(wallet?.balance || 0)}</b></p>}
        <FormField label="Amount" required><Input autoFocus type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
        <FormField label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        <FormField label={deposit ? 'Brought by' : 'Taken by'}><Input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Name (optional)" /></FormField>
        <FormField label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      </div>
    </Modal>
  );
}

function TakeFromBranchesModal({ open, wallet, onClose, onSaved }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [amounts, setAmounts] = useState({});
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setRows(null); setAmounts({}); setDate(today()); setNote('');
    client.get('/company-wallets/branch-accounts').then((r) => setRows(r.data.data)).catch((err) => { toast.error(err.friendlyMessage || 'Could not load the branches.'); setRows([]); });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = (rows || []).flatMap((b) => b.accounts.map((a) => ({ branchId: b.branchId, accountId: a.id, amount: Number(amounts[a.id]) || 0 }))).filter((i) => i.amount > 0);
  const total = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const branchTotal = (b) => Math.round(b.accounts.reduce((s, a) => s + (Number(amounts[a.id]) || 0), 0) * 100) / 100;
  const save = async () => {
    setSaving(true);
    try {
      const r = await client.post(`/company-wallets/${wallet.id}/take`, { date, note, items });
      toast.success(`${formatCurrency(r.data.data.total)} taken into ${wallet.name} (${r.data.data.batch}).`);
      onSaved(r.data.data.batch);
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not take the money.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} size="lg" title={`Take from branches — ${wallet?.name || ''}`} footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!(total > 0)}>Take {formatCurrency(total)}</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">Type how much to take from each account. It all becomes one statement; each branch's balance sheet shows its part under Cash &amp; bank.</p>
        {rows === null ? (
          <p className="py-6 text-center text-sm text-neutral-400">Loading…</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((b) => (
              <div key={b.branchId} className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
                <div className="flex items-center justify-between border-b border-neutral-100 bg-neutral-50 px-3 py-2">
                  <p className="flex items-center gap-2 text-sm font-bold text-neutral-900"><Store className="h-4 w-4 text-neutral-400" />{b.branchName}</p>
                  {branchTotal(b) > 0 && <span className="text-xs font-bold text-brand-700">{formatCurrency(branchTotal(b))}</span>}
                </div>
                {b.accounts.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-neutral-500">No accounts.</p>
                ) : (
                  b.accounts.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-2 border-b border-neutral-100 px-3 py-1.5 last:border-0">
                      <div className="min-w-0 text-sm">
                        <p className="truncate font-medium text-neutral-800">{a.name}</p>
                        <p className={`text-[11px] ${a.balance > 0 ? 'text-neutral-500' : 'text-neutral-300'}`}>{formatCurrency(a.balance)}</p>
                      </div>
                      <Input type="number" min="0" step="0.01" placeholder="0.00" disabled={!(a.balance > 0)} className="w-28 text-right" value={amounts[a.id] ?? ''} onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))} />
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
          <FormField label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></FormField>
        </div>
      </div>
    </Modal>
  );
}

// Gives part of the wallet's money to one branch, into one of its accounts.
// Not a loan: the branch owes nothing for it. Its admins are told by chat.
function GiveToBranchModal({ open, wallet, onClose, onSaved }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [owed, setOwed] = useState({});
  const [branchId, setBranchId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setRows(null); setOwed({}); setBranchId(''); setAccountId(''); setAmount(''); setDate(today()); setNote('');
    client.get('/company-wallets/branch-accounts').then((r) => setRows(r.data.data)).catch((err) => { toast.error(err.friendlyMessage || 'Could not load the branches.'); setRows([]); });
    // What each branch still owes the daily take (Super Admin only; else none shown).
    client.get('/company-wallets/auto-take').then((r) => setOwed(r.data.data.enabled ? Object.fromEntries(r.data.data.branches.map((b) => [String(b.branchId), b.owed])) : {})).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const branch = (rows || []).find((b) => String(b.branchId) === branchId);
  const owes = Number(owed[branchId] || 0);
  const value = Number(amount) || 0;
  const tooMuch = value > (wallet?.balance || 0);
  const save = async () => {
    setSaving(true);
    try {
      const r = await client.post(`/company-wallets/${wallet.id}/give`, { branchId, accountId, amount: value, date, note });
      toast.success(`${formatCurrency(r.data.data.total)} given to ${branch?.branchName} (${r.data.data.batch}). Its admins were told.`);
      onSaved(r.data.data.batch);
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not give the money.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Give to branch — ${wallet?.name || ''}`} footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!branchId || !accountId || !(value > 0) || tooMuch || owes > 0}>Give {formatCurrency(value)}</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">The money goes from the wallet into one of the branch's accounts. It is <b>not a loan</b>: the branch owes nothing for it. The branch admins get a chat message.</p>
        <p className="text-sm text-neutral-600">In the wallet now: <b>{formatCurrency(wallet?.balance || 0)}</b></p>
        {rows === null ? (
          <p className="py-6 text-center text-sm text-neutral-400">Loading…</p>
        ) : (
          <>
            <FormField label="Branch" required>
              <Select value={branchId} onChange={(e) => { setBranchId(e.target.value); setAccountId(''); }}>
                <option value="">Choose a branch</option>
                {rows.map((b) => <option key={b.branchId} value={String(b.branchId)}>{b.branchName}</option>)}
              </Select>
            </FormField>
            {owes > 0 && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{branch?.branchName} still owes {formatCurrency(owes)} to the daily take, so this money would be taken straight back. Set what it owes to 0 under the automatic daily take first.</p>}
            {branch && (
              <FormField label="Into account" required>
                {branch.accounts.length === 0 ? (
                  <p className="text-sm text-neutral-500">This branch has no accounts.</p>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-neutral-200">
                    {branch.accounts.map((a) => (
                      <label key={a.id} className={`flex cursor-pointer items-center justify-between gap-3 border-b border-neutral-100 px-3 py-2 last:border-0 ${accountId === String(a.id) ? 'bg-brand-50' : 'hover:bg-neutral-50'}`}>
                        <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
                          <input type="radio" name="give-account" checked={accountId === String(a.id)} onChange={() => setAccountId(String(a.id))} />
                          {a.name}
                        </span>
                        <span className="text-xs tabular-nums text-neutral-500">{formatCurrency(a.balance)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </FormField>
            )}
            <FormField label="Amount" required error={tooMuch ? 'More than the wallet has.' : undefined}><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
              <FormField label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional, sent to the admins" /></FormField>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// One "Take from branches" (or "Give to branch") as a statement: every
// branch, its accounts and amounts, the total -- printable.
function StatementModal({ take, wallet, onClose, onUndo }) {
  if (!take) return null;
  const give = take.kind === 'GIVE';
  const byBranch = take.items.reduce((m, i) => {
    (m[i.branchName] = m[i.branchName] || []).push(i);
    return m;
  }, {});
  const sum = (list) => list.reduce((s, i) => s + i.amount, 0);
  const print = () => {
    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) return;
    const body = Object.entries(byBranch)
      .map(([b, list]) => `<tr class="b"><td colspan="2">${esc(b)}</td><td class="r">${formatCurrency(sum(list))}</td></tr>` + list.map((i) => `<tr><td></td><td>${esc(i.accountName)}</td><td class="r">${formatCurrency(i.amount)}</td></tr>`).join(''))
      .join('');
    w.document.write(`<html><head><title>${esc(take.batch)}</title><style>body{font-family:system-ui,sans-serif;padding:32px;color:#111}h1{font-size:20px;margin:0}p{margin:4px 0;color:#555;font-size:13px}table{width:100%;border-collapse:collapse;margin-top:20px;font-size:14px}td,th{padding:8px;border-bottom:1px solid #eee;text-align:left}.r{text-align:right}.b td{font-weight:700;background:#f6f6f6}.t td{font-weight:800;border-top:2px solid #111;font-size:16px}</style></head><body><h1>${esc(wallet?.name || 'Company Wallet')} — ${give ? 'Given to branch (not a loan)' : 'Take from branches'}</h1><p>${esc(take.batch)} · ${formatDate(take.date)} · by ${esc(take.createdByName || '')}</p>${take.note ? `<p>Note: ${esc(take.note)}</p>` : ''}<table><thead><tr><th>Branch</th><th>Account</th><th class="r">Amount</th></tr></thead><tbody>${body}<tr class="t"><td colspan="2">Total</td><td class="r">${formatCurrency(take.amount)}</td></tr></tbody></table></body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };
  return (
    <Modal
      open={!!take}
      onClose={onClose}
      size="lg"
      title={`Statement ${take.label || take.batch}`}
      footer={<><Button variant="secondary" className="!text-red-600" onClick={() => onUndo(take)}><Trash2 className="h-4 w-4" /> Undo</Button><Button variant="secondary" onClick={print}><Printer className="h-4 w-4" /> Print</Button><Button onClick={onClose}>Close</Button></>}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl bg-neutral-50 p-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500">{give ? 'Given to' : 'Taken from'} {take.branches.length} branch{take.branches.length === 1 ? '' : 'es'}{give ? ' · not a loan' : ''}</p>
            <p className="text-3xl font-extrabold text-neutral-950">{formatCurrency(take.amount)}</p>
          </div>
          <div className="text-right text-sm text-neutral-600">
            <p>{formatDate(take.date)}</p>
            <p>By {take.createdByName || '—'}</p>
            {take.note && <p className="text-neutral-500">{take.note}</p>}
          </div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-neutral-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <th className="px-4 py-2">Branch</th>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(byBranch).map(([b, list]) => [
                <tr key={b} className="border-t border-neutral-200 bg-white">
                  <td className="px-4 py-2 font-bold text-neutral-900" colSpan={2}>{b}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums">{formatCurrency(sum(list))}</td>
                </tr>,
                ...list.map((i, k) => (
                  <tr key={`${b}-${k}`} className="border-t border-neutral-100">
                    <td />
                    <td className="px-4 py-1.5 text-neutral-600">{i.accountName}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-neutral-700">{formatCurrency(i.amount)}</td>
                  </tr>
                )),
              ])}
              <tr className="border-t-2 border-neutral-900">
                <td className="px-4 py-2.5 font-extrabold" colSpan={2}>Total</td>
                <td className="px-4 py-2.5 text-right text-base font-extrabold tabular-nums">{formatCurrency(take.amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

// Automatic daily take: every day at 12:00 noon (Somalia) each branch owes
// the amount set here; it is taken from its accounts at once, and what they
// cannot cover stays owed until money comes in. Super Admin only.
function AutoTakeCard({ wallets, onTaken }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({ enabled: false, amount: '', walletId: '' });
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const d = (await client.get('/company-wallets/auto-take')).data.data;
      setCfg(d);
      setForm({ enabled: d.enabled, amount: d.amount ? String(d.amount) : '', walletId: d.walletId || '' });
    } catch {
      setCfg(false); // not the Super Admin
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // Each branch's own daily amount (empty: the amount for every branch).
  const [daily, setDaily] = useState({});
  useEffect(() => {
    if (cfg) setDaily(Object.fromEntries(cfg.branches.map((b) => [b.branchId, b.daily === '' ? '' : String(b.daily)])));
  }, [cfg]);
  // (All hooks above this line: returning early before a hook breaks the page.)
  if (!cfg) return null;
  const save = async () => {
    setSaving(true);
    try {
      await client.put('/company-wallets/auto-take', { enabled: form.enabled, amount: Number(form.amount) || 0, walletId: form.walletId || (wallets[0]?.id ?? '') });
      toast.success(form.enabled ? 'Automatic daily take saved.' : 'Automatic daily take switched off.');
      await load();
      onTaken?.();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  const saveDaily = async (b) => {
    try {
      await client.put(`/company-wallets/auto-take/branches/${b.branchId}`, { daily: daily[b.branchId] === '' ? null : Number(daily[b.branchId]) });
      toast.success(daily[b.branchId] === '' ? `${b.name}: uses the amount for every branch.` : `${b.name}: ${formatCurrency(Number(daily[b.branchId]))} every day.`);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save.');
    }
  };
  const forgive = async (b) => {
    if (!window.confirm(`Clear what ${b.name} owes (${formatCurrency(b.owed)})? It will not be taken.`)) return;
    try {
      await client.put(`/company-wallets/auto-take/branches/${b.branchId}`, { owed: 0 });
      toast.success(`${b.name}: nothing owed now.`);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not change it.');
    }
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3">
        <div>
          <p className="font-bold text-neutral-900">Automatic daily take — 12:00 noon (Somalia)</p>
          <p className="text-xs text-neutral-500">Every branch, every day. If its accounts are short, the rest stays owed and is taken as soon as money comes in.</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-neutral-800">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} className="h-4 w-4 accent-brand-600" />
          {form.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3 px-5 py-4">
        <FormField label="Amount per day (every branch, unless set below)">
          <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="500" className="w-40" />
        </FormField>
        <FormField label="Into wallet">
          <select value={form.walletId || wallets[0]?.id || ''} onChange={(e) => setForm((f) => ({ ...f, walletId: e.target.value }))} className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm">
            {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </FormField>
        <Button onClick={save} loading={saving}>Save</Button>
      </div>
      {cfg.branches.length > 0 && (
        <div className="grid gap-2 border-t border-neutral-100 bg-neutral-50/60 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {cfg.branches.map((b) => (
            <div key={b.branchId} className="space-y-2 rounded-xl bg-white px-4 py-3 ring-1 ring-neutral-200/70">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-neutral-900">{b.name}</p>
                  <p className="text-[11px] text-neutral-400">{b.lastChargedDay ? `Last daily amount: ${b.lastChargedDay}` : 'Not charged yet'}</p>
                </div>
                <div className="text-right">
                  <p className={`figure text-sm font-bold ${b.owed > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{b.owed > 0 ? `−${formatCurrency(b.owed)}` : 'Paid up'}</p>
                  {b.owed > 0 && <button onClick={() => forgive(b)} className="text-[11px] font-semibold text-neutral-400 hover:text-red-600">Clear</button>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-neutral-500">Every day</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={daily[b.branchId] ?? ''}
                  onChange={(e) => setDaily((d) => ({ ...d, [b.branchId]: e.target.value }))}
                  placeholder={form.amount ? `${form.amount} (all)` : '0'}
                  className="w-28 rounded-lg border border-neutral-200 px-2 py-1 text-sm tabular-nums"
                />
                <Button size="sm" variant="secondary" onClick={() => saveDaily(b)}>Save</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Every message sent to the branch admins about money taken (Super Admin).
// Hidden until opened, so the list does not fill the page.
function NoticesCard() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    client.get('/company-wallets/notices').then((r) => setList(r.data.data)).catch(() => setList(false));
  }, []);
  if (list === false) return null;
  const shown = open ? list || [] : (list || []).slice(0, 5);
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <button type="button" onClick={() => setVisible((v) => !v)} className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-neutral-50">
        <span>
          <span className="block font-bold text-neutral-900">Messages sent to admins{list?.length ? ` (${list.length})` : ''}</span>
          <span className="block text-xs text-neutral-500">What each branch admin was told when money was taken or is owed.</span>
        </span>
        <span className="shrink-0 text-xs font-semibold text-brand-700">{visible ? 'Hide' : 'Show'}</span>
      </button>
      {!visible ? null : list === null ? (
        <p className="py-8 text-center text-sm text-neutral-400">Loading…</p>
      ) : list.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-500">No messages yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {shown.map((n) => (
            <li key={n.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-neutral-900">
                  {n.branchName} <span className="font-normal text-neutral-500">→ {n.to.length ? n.to.join(', ') : 'no admin in this branch'}</span>
                </span>
                <span className="text-neutral-400">
                  {formatDate(n.date)} {new Date(n.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  {n.automatic ? ' · automatic' : ''}
                  {n.batch ? ` · ${n.batch}` : ''}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-line rounded-xl bg-neutral-50 px-3 py-2 text-sm text-neutral-800">{n.text}</p>
            </li>
          ))}
        </ul>
      )}
      {visible && list && list.length > 5 && (
        <button onClick={() => setOpen((v) => !v)} className="w-full border-t border-neutral-100 py-2.5 text-xs font-semibold text-brand-700 hover:bg-neutral-50">
          {open ? 'Show less' : `Show all ${list.length}`}
        </button>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${tone || 'text-neutral-900'}`}>{value}</p>
    </div>
  );
}

export default function CompanyWalletPage() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [walletForm, setWalletForm] = useState(null);
  const [moneyMode, setMoneyMode] = useState(null);
  const [takeOpen, setTakeOpen] = useState(false);
  const [giveOpen, setGiveOpen] = useState(false);
  const [statement, setStatement] = useState(null);
  // The History list is hidden until opened, so it does not fill the page.
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadList = useCallback(async (pick) => {
    try {
      const res = await client.get('/company-wallets');
      setList(res.data.data);
      const ws = res.data.data.wallets;
      setSelectedId((cur) => pick || (ws.some((w) => w.id === cur) ? cur : ws[0]?.id || null));
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not load the wallets.');
      setList({ total: 0, wallets: [] });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = useCallback(async (id, openBatch) => {
    if (!id) return setDetail(null);
    try {
      const res = await client.get(`/company-wallets/${id}/entries`);
      setDetail(res.data.data);
      if (openBatch) setStatement(res.data.data.rows.find((r) => r.batch === openBatch) || null);
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not load the wallet.');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { setDetail(null); loadDetail(selectedId); }, [selectedId, loadDetail]);

  const refresh = (openBatch) => { loadList(selectedId); loadDetail(selectedId, openBatch); };
  const wallet = detail?.wallet || list?.wallets.find((w) => w.id === selectedId);

  const removeEntry = async (e) => {
    if (!window.confirm(`Remove this ${e.type === 'DEPOSIT' ? 'deposit' : 'withdrawal'} of ${formatCurrency(e.amount)}?`)) return;
    try {
      await client.delete(`/company-wallets/${selectedId}/entries/${e.id}`);
      toast.success('Removed.');
      refresh();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not remove it.');
    }
  };
  const undoTake = async (t) => {
    const give = t.kind === 'GIVE';
    if (!window.confirm(give ? `Undo ${t.batch}? ${formatCurrency(t.amount)} comes back out of the branch account into the wallet.` : `Undo ${t.batch}? ${formatCurrency(t.amount)} goes back to the branch accounts.`)) return;
    try {
      await client.delete(`/company-wallets/${selectedId}/takes/${t.batch}`);
      toast.success(give ? `${t.batch} undone; the money is back in the wallet.` : `${t.batch} undone; the money is back in the branch accounts.`);
      setStatement(null);
      refresh();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not undo it.');
    }
  };
  const removeWallet = async () => {
    if (!window.confirm(`Delete the wallet "${wallet.name}"?`)) return;
    try {
      await client.delete(`/company-wallets/${wallet.id}`);
      toast.success('Wallet deleted.');
      setSelectedId(null);
      loadList();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not delete the wallet.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Company Wallet"
        subtitle="Money kept apart from the shop. Take from branches moves money out of branch accounts -- one statement each time."
        actions={<Button variant="secondary" onClick={() => setWalletForm({})}><Plus className="h-4 w-4" /> New Wallet</Button>}
      />
      {list === null ? (
        <p className="py-16 text-center text-sm text-neutral-400">Loading…</p>
      ) : list.wallets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <PiggyBank className="mx-auto h-10 w-10 text-brand-600" />
          <p className="mt-3 font-bold text-neutral-900">No wallet yet</p>
          <p className="mt-1 text-sm text-neutral-500">Create one, then take money from the branches or put money in.</p>
          <Button className="mt-4" onClick={() => setWalletForm({})}><Plus className="h-4 w-4" /> New Wallet</Button>
        </div>
      ) : (
        <div className="space-y-5">
          {list.wallets.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {list.wallets.map((w) => (
                <button key={w.id} onClick={() => setSelectedId(w.id)} className={`flex items-center gap-3 rounded-full border px-4 py-2 text-sm ${w.id === selectedId ? 'border-brand-400 bg-brand-50 font-bold text-neutral-900' : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300'}`}>
                  <PiggyBank className="h-4 w-4 text-brand-600" />{w.name}<span className="tabular-nums">{formatCurrency(w.balance)}</span>
                </button>
              ))}
              <span className="flex items-center rounded-full bg-neutral-100 px-4 py-2 text-sm text-neutral-600">All wallets <b className="ml-2 tabular-nums text-neutral-900">{formatCurrency(list.total)}</b></span>
            </div>
          )}

          {wallet && (
            <div className="overflow-hidden rounded-3xl border border-neutral-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-4 p-6">
                <div className="flex items-center gap-4">
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"><Wallet className="h-7 w-7" /></span>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">{wallet.name}</p>
                    <p className="text-4xl font-extrabold tabular-nums text-neutral-950">{formatCurrency(wallet.balance)}</p>
                    {wallet.note && <p className="text-sm text-neutral-500">{wallet.note}</p>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setTakeOpen(true)}><Store className="h-4 w-4" /> Take from branches</Button>
                  <Button variant="secondary" onClick={() => setGiveOpen(true)} disabled={!(wallet.balance > 0)}><HandCoins className="h-4 w-4" /> Give to branch</Button>
                  <Button variant="secondary" onClick={() => setMoneyMode('DEPOSIT')}><ArrowDownCircle className="h-4 w-4" /> Put in</Button>
                  <Button variant="secondary" onClick={() => setMoneyMode('WITHDRAW')}><ArrowUpCircle className="h-4 w-4" /> Take out</Button>
                  <Button variant="secondary" onClick={() => setWalletForm({ wallet })} title="Edit"><Pencil className="h-4 w-4" /></Button>
                  {wallet.balance === 0 && <Button variant="secondary" className="!text-red-600" onClick={removeWallet} title="Delete"><Trash2 className="h-4 w-4" /></Button>}
                </div>
              </div>
              {detail && (
                <div className="grid grid-cols-1 gap-3 border-t border-neutral-100 bg-neutral-50/60 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="From branches" value={formatCurrency(detail.fromBranches || 0)} tone="text-brand-700" />
                  <Stat label="Given to branches" value={formatCurrency(detail.givenToBranches || 0)} tone="text-amber-700" />
                  <Stat label="Put in by hand" value={formatCurrency(detail.deposited || 0)} />
                  <Stat label="Taken out" value={formatCurrency(detail.withdrawn || 0)} tone="text-red-600" />
                </div>
              )}
            </div>
          )}

          <AutoTakeCard wallets={list.wallets} onTaken={() => refresh()} />

          <NoticesCard />

          <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
            <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-neutral-50">
              <span>
                <span className="block font-bold text-neutral-900">History{detail?.rows?.length ? ` (${detail.rows.length})` : ''}</span>
                <span className="block text-xs text-neutral-500">Each "Take from branches" is one line -- open it for the full statement.</span>
              </span>
              <span className="shrink-0 text-xs font-semibold text-brand-700">{historyOpen ? 'Hide' : 'Show'}</span>
            </button>
            {!historyOpen ? null : detail === null ? (
              <p className="py-10 text-center text-sm text-neutral-400">Loading…</p>
            ) : detail.rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-neutral-500">No money in or out yet.</p>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {detail.rows.map((r) => {
                  // A take or a give: one statement line.
                  const take = r.kind === 'TAKE' || r.kind === 'GIVE';
                  const give = r.kind === 'GIVE';
                  const inflow = r.type === 'DEPOSIT';
                  return (
                    <li key={r.id} className={`flex flex-wrap items-center gap-4 px-5 py-3 ${take ? 'cursor-pointer hover:bg-neutral-50' : ''}`} onClick={take ? () => setStatement(r) : undefined}>
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${give ? 'bg-amber-50 text-amber-600' : take ? 'bg-brand-50 text-brand-600' : inflow ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                        {give ? <HandCoins className="h-5 w-5" /> : take ? <Store className="h-5 w-5" /> : inflow ? <ArrowDownCircle className="h-5 w-5" /> : <ArrowUpCircle className="h-5 w-5" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-neutral-900">
                          {give ? `Given to ${r.branches.join(', ')} · ${r.items.map((i) => i.accountName).join(', ')}` : take ? `Taken from ${r.branches.join(', ')}` : inflow ? 'Put in' : 'Taken out'}
                          {take && <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600">{r.label || r.batch}</span>}
                        </p>
                        <p className="truncate text-xs text-neutral-500">
                          {formatDate(r.date)} · {r.createdByName || '—'}
                          {give ? ' · not a loan' : take ? ` · ${r.items.length} account${r.items.length === 1 ? '' : 's'}` : r.person ? ` · ${r.person}` : ''}
                          {r.note ? ` · ${r.note}` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`font-bold tabular-nums ${inflow ? 'text-emerald-700' : 'text-red-600'}`}>{inflow ? '+' : '−'}{formatCurrency(r.amount)}</p>
                        <p className="text-[11px] tabular-nums text-neutral-400">Balance {formatCurrency(r.balanceAfter)}</p>
                      </div>
                      {take ? (
                        <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setStatement(r); }}><FileText className="h-3.5 w-3.5" /> Statement</Button>
                      ) : (
                        <button onClick={() => removeEntry(r)} className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600" title="Remove"><Trash2 className="h-4 w-4" /></button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
      <WalletFormModal open={!!walletForm} wallet={walletForm?.wallet} onClose={() => setWalletForm(null)} onSaved={(w) => loadList(w?.id)} />
      <MoneyModal mode={moneyMode} wallet={wallet} onClose={() => setMoneyMode(null)} onSaved={() => refresh()} />
      <TakeFromBranchesModal open={takeOpen} wallet={wallet} onClose={() => setTakeOpen(false)} onSaved={(batch) => refresh(batch)} />
      <GiveToBranchModal open={giveOpen} wallet={wallet} onClose={() => setGiveOpen(false)} onSaved={(batch) => refresh(batch)} />
      <StatementModal take={statement} wallet={wallet} onClose={() => setStatement(null)} onUndo={undoTake} />
    </div>
  );
}
