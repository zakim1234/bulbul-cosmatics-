import { useCallback, useEffect, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Trash2, Wallet } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import Button from '../../components/ui/Button.jsx';
import Modal from '../../components/ui/Modal.jsx';
import { FormField, Input, Select, Textarea } from '../../components/ui/Field.jsx';
import AccountSelect from '../../components/AccountSelect.jsx';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Profit set aside from a year's Net Income to pay the owners back for the
// company's equipment (fixed assets). Set aside: Net Income goes down and the
// wallet -- owed to the owners -- goes up. Pay out: the money leaves an
// account to the owner.
function SetAsideModal({ open, fund, onClose, onSaved }) {
  const toast = useToast();
  const [year, setYear] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) { setYear(String(fund?.years?.[0]?.year || new Date().getFullYear())); setAmount(''); setNote(''); }
  }, [open, fund]);
  const chosen = fund?.years?.find((y) => String(y.year) === year);
  const value = Number(amount) || 0;
  const save = async () => {
    setSaving(true);
    try {
      await client.post('/fixed-assets/fund/set-aside', { year: Number(year), amount: value, note });
      toast.success(`${formatCurrency(value)} set aside from the ${year} Net Income.`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not set the money aside.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Set aside from profit" size="sm" footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!(value > 0) || !chosen || value > chosen.available}>Set aside {formatCurrency(value)}</Button></>}>
      <div className="space-y-4">
        <p className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-600">The amount comes off that year's <b>Net Income</b> (and the profit left to share) and goes into the wallet, to pay the equipment debt back to the owners. No account moves until it is paid out.</p>
        <FormField label="From the profit of">
          <Select value={year} onChange={(e) => setYear(e.target.value)}>
            {(fund?.years || []).map((y) => <option key={y.year} value={String(y.year)}>{y.year} -- {y.shared ? 'already shared' : `${formatCurrency(y.available)} left`}</option>)}
          </Select>
        </FormField>
        {chosen?.shared && <p className="text-sm text-red-600">The {chosen.year} profit was already shared with the partners.</p>}
        <FormField label="Amount" required error={chosen && value > chosen.available ? `Only ${formatCurrency(chosen.available)} is left.` : undefined}>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></FormField>
      </div>
    </Modal>
  );
}

// Pays back the person the equipment money is owed to: pick them, and what
// is still owed to them shows.
function PayOutModal({ open, fund, onClose, onSaved }) {
  const toast = useToast();
  const [person, setPerson] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPerson(''); setAccountId(null); setAmount(''); setDate(today()); setNote('');
  }, [open]);
  const owedList = (fund?.creditors || []).filter((c) => c.left > 0);
  const chosen = owedList.find((c) => c.name === person);
  const value = Number(amount) || 0;
  const owed = chosen ? chosen.left : 0;
  const tooMuch = value > (fund?.balance || 0) || (chosen && value > owed);
  const save = async () => {
    setSaving(true);
    try {
      await client.post('/fixed-assets/fund/payout', { amount: value, person, paymentAccountId: accountId, date, note });
      toast.success(`${formatCurrency(value)} paid to ${person}.`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not pay it out.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Pay out" size="sm" footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!(value > 0) || tooMuch || !accountId || !chosen}>Pay {formatCurrency(value)}</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">In the wallet now: <b>{formatCurrency(fund?.balance || 0)}</b></p>
        <FormField label="Pay to" required>
          <Select value={person} onChange={(e) => { setPerson(e.target.value); const c = owedList.find((x) => x.name === e.target.value); if (c) setAmount(String(Math.min(c.left, fund?.balance || 0))); }}>
            <option value="">{owedList.length ? 'Choose who is owed...' : 'Nobody is owed anything'}</option>
            {owedList.map((c) => <option key={c.name} value={c.name}>{c.name} -- owed {formatCurrency(c.left)}</option>)}
          </Select>
        </FormField>
        {chosen && (
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-xs">
            <div><p className="text-neutral-500">Bought from them</p><p className="font-bold tabular-nums">{formatCurrency(chosen.bought)}</p></div>
            <div><p className="text-neutral-500">Paid back</p><p className="font-bold tabular-nums text-brand-700">{formatCurrency(chosen.paid)}</p></div>
            <div><p className="text-neutral-500">Still owed</p><p className="font-bold tabular-nums text-red-600">{formatCurrency(chosen.left)}</p></div>
          </div>
        )}
        <FormField label="Amount" required error={tooMuch ? (chosen && value > owed ? `Only ${formatCurrency(owed)} is owed to ${chosen.name}.` : 'More than the wallet has.') : undefined}><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
        <FormField label="Paid from account" required><AccountSelect value={accountId} onChange={setAccountId} placeholder="Account the money leaves..." /></FormField>
        <FormField label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        <FormField label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></FormField>
      </div>
    </Modal>
  );
}

export default function FixedAssetWallet({ canManage, equipmentTotal }) {
  const toast = useToast();
  const [fund, setFund] = useState(null);
  const [mode, setMode] = useState(null); // 'set' | 'pay'
  const [historyOpen, setHistoryOpen] = useState(false);
  const load = useCallback(() => {
    client.get('/fixed-assets/fund').then((r) => setFund(r.data.data)).catch((err) => { toast.error(err.friendlyMessage || 'Could not load the Fixed Asset Wallet.'); setFund(false); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  if (fund === false) return null;

  const undo = async (e) => {
    const text = e.type === 'SET_ASIDE' ? `Undo setting aside ${formatCurrency(e.amount)}? It goes back to the ${e.year} Net Income.` : `Undo the payout of ${formatCurrency(e.amount)} to ${e.person}? The money comes back into ${e.accountName}.`;
    if (!window.confirm(text)) return;
    try {
      await client.delete(`/fixed-assets/fund/${e.id}`);
      toast.success('Undone.');
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not undo it.');
    }
  };
  const left = Math.max(0, Math.round(((equipmentTotal || 0) - (fund?.paidOut || 0)) * 100) / 100);

  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"><Wallet className="h-6 w-6" /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Fixed Asset Wallet</p>
            <p className="text-3xl font-extrabold tabular-nums text-neutral-950">{fund ? formatCurrency(fund.balance) : '…'}</p>
            <p className="text-xs text-neutral-500">The equipment was bought with money that is not the company's, so its value is a debt. Profit set aside here pays it back to the owners.</p>
          </div>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setMode('set')} disabled={!fund}><ArrowDownCircle className="h-4 w-4" /> Set aside from profit</Button>
            <Button variant="secondary" onClick={() => setMode('pay')} disabled={!fund || !(fund.balance > 0)}><ArrowUpCircle className="h-4 w-4" /> Pay out</Button>
          </div>
        )}
      </div>
      {fund && (
        <div className="grid grid-cols-1 gap-3 border-t border-neutral-100 bg-neutral-50/60 p-4 text-sm sm:grid-cols-4">
          <div><p className="text-xs text-neutral-500">Equipment bought</p><p className="font-bold tabular-nums">{formatCurrency(equipmentTotal || 0)}</p></div>
          <div><p className="text-xs text-neutral-500">Set aside from profit</p><p className="font-bold tabular-nums">{formatCurrency(fund.setAside)}</p></div>
          <div><p className="text-xs text-neutral-500">Paid back to owners</p><p className="font-bold tabular-nums text-brand-700">{formatCurrency(fund.paidOut)}</p></div>
          <div><p className="text-xs text-neutral-500">Equipment still to pay back</p><p className="font-bold tabular-nums text-red-600">{formatCurrency(left)}</p></div>
        </div>
      )}
      {fund && fund.creditors.length > 0 && (
        <div className="overflow-x-auto border-t border-neutral-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <th className="px-5 py-2">Owed to</th>
                <th className="px-3 py-2 text-right">Bought</th>
                <th className="px-3 py-2 text-right">Paid back</th>
                <th className="px-5 py-2 text-right">Still owed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {fund.creditors.map((c) => (
                <tr key={c.name}>
                  <td className="px-5 py-2 font-medium text-neutral-900">{c.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(c.bought)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-brand-700">{formatCurrency(c.paid)}</td>
                  <td className="px-5 py-2 text-right font-bold tabular-nums text-red-600">{formatCurrency(c.left)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fund && (
        <>
          <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="flex w-full items-center justify-between border-t border-neutral-100 px-5 py-2.5 text-left text-sm hover:bg-neutral-50">
            <span className="font-semibold text-neutral-800">History ({fund.entries.length})</span>
            <span className="text-xs font-semibold text-brand-700">{historyOpen ? 'Hide' : 'Show'}</span>
          </button>
          {historyOpen && (
            <ul className="divide-y divide-neutral-100 border-t border-neutral-100">
              {fund.entries.length === 0 && <li className="px-5 py-4 text-center text-sm text-neutral-500">Nothing yet.</li>}
              {fund.entries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-neutral-900">{e.type === 'SET_ASIDE' ? `Set aside from the ${e.year} Net Income` : `Paid to ${e.person} from ${e.accountName}`}</p>
                    <p className="text-xs text-neutral-500">{formatDate(e.date)} · {e.createdByName || '—'}{e.note ? ` · ${e.note}` : ''}</p>
                  </div>
                  <p className={`font-bold tabular-nums ${e.type === 'SET_ASIDE' ? 'text-emerald-700' : 'text-red-600'}`}>{e.type === 'SET_ASIDE' ? '+' : '−'}{formatCurrency(e.amount)}</p>
                  {canManage && <button onClick={() => undo(e)} className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600" title="Undo"><Trash2 className="h-4 w-4" /></button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <SetAsideModal open={mode === 'set'} fund={fund} onClose={() => setMode(null)} onSaved={load} />
      <PayOutModal open={mode === 'pay'} fund={fund} onClose={() => setMode(null)} onSaved={load} />
    </div>
  );
}
