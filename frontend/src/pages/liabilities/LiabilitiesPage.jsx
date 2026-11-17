import { useCallback, useEffect, useState } from 'react';
import { Landmark, Plus, Banknote, History, Pencil, Trash2 } from 'lucide-react';
import client from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import Modal from '../../components/ui/Modal.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import { FormField, Input, Select, Textarea } from '../../components/ui/Field.jsx';
import AccountSelect from '../../components/AccountSelect.jsx';
import { Table, THead, Th, TBody, Td, TableEmpty, TableLoading } from '../../components/ui/Table.jsx';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Add / edit a liability. A normal one is an expense charged now and paid
// later: it counts in Profit & Loss on its date, no money moves. An opening
// one is a debt from before this system: not an expense, only to pay off.
function LiabilityFormModal({ open, item, opening: openingMode, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = !!item;
  const opening = isEdit ? item.opening : openingMode;
  const [categories, setCategories] = useState([]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(item?.name || '');
    setCategory(item?.category || '');
    setAmount(item ? String(item.amount) : '');
    setDate(item?.date ? item.date.slice(0, 10) : today());
    setNote(item?.note || '');
    if (!opening) client.get('/expenses/categories').then((r) => setCategories((r.data.data || []).map((c) => c.name || c))).catch(() => setCategories([]));
  }, [open, item, opening]);
  const save = async () => {
    setSaving(true);
    try {
      const body = { name, category, amount: Number(amount), date, note, opening };
      if (isEdit) await client.put(`/liabilities/${item.id}`, body);
      else await client.post('/liabilities', body);
      toast.success(isEdit ? 'Saved.' : opening ? 'Opening balance added.' : 'Liability added: it is in this period\'s expenses.');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} size="sm" title={isEdit ? 'Edit Liability' : opening ? 'Opening Balance -- Liabilities' : 'Add Liability'} footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!name.trim() || !(Number(amount) > 0) || (!opening && !category)}>Save</Button></>}>
      <div className="space-y-4">
        <p className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
          {opening
            ? 'A debt the company already had before this system (from the old books). It is not an expense now -- only something to pay off.'
            : 'An expense charged now but not paid yet. It counts in Profit & Loss on this date (Net Income goes down); no money leaves an account until you pay it.'}
        </p>
        <FormField label="Owed to / for" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rent -- November, Salaam Bank loan" autoFocus />
        </FormField>
        {!opening && (
          <FormField label="Expense category" required>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choose...</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </FormField>
        )}
        <FormField label="Amount" required>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </FormField>
        <FormField label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        <FormField label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></FormField>
      </div>
    </Modal>
  );
}

// Pays part or all of a liability from an account.
function PayModal({ item, onClose, onSaved }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (item) { setAmount(String(item.left)); setAccountId(null); setDate(today()); setNote(''); }
  }, [item]);
  if (!item) return null;
  const value = Number(amount) || 0;
  const save = async () => {
    setSaving(true);
    try {
      await client.post(`/liabilities/${item.id}/pay`, { amount: value, paymentAccountId: accountId, date, note });
      toast.success(`${formatCurrency(value)} paid on ${item.name}.`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not pay it.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={!!item} onClose={onClose} size="sm" title={`Pay -- ${item.name}`} footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!(value > 0) || value > item.left || !accountId}>Pay {formatCurrency(value)}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-xs">
          <div><p className="text-neutral-500">Owed</p><p className="font-bold tabular-nums">{formatCurrency(item.amount)}</p></div>
          <div><p className="text-neutral-500">Paid</p><p className="font-bold tabular-nums text-brand-700">{formatCurrency(item.paid)}</p></div>
          <div><p className="text-neutral-500">Left</p><p className="font-bold tabular-nums text-red-600">{formatCurrency(item.left)}</p></div>
        </div>
        <FormField label="Amount" required error={value > item.left ? `Only ${formatCurrency(item.left)} is left.` : undefined}>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Paid from account" required><AccountSelect value={accountId} onChange={setAccountId} placeholder="Account the money leaves..." /></FormField>
        <FormField label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        <FormField label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></FormField>
      </div>
    </Modal>
  );
}

function PaymentsModal({ item, canManage, onClose, onChanged }) {
  const toast = useToast();
  if (!item) return null;
  const undo = async (p) => {
    if (!window.confirm(`Undo the payment of ${formatCurrency(p.amount)}? The money comes back into ${p.accountName}.`)) return;
    try {
      await client.delete(`/liabilities/${item.id}/payments/${p.id}`);
      toast.success('Payment undone.');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not undo it.');
    }
  };
  return (
    <Modal open={!!item} onClose={onClose} title={`Payments -- ${item.name}`}>
      {item.payments.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">Nothing paid yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {item.payments.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-neutral-900">{formatCurrency(p.amount)} from {p.accountName}</p>
                <p className="text-xs text-neutral-500">{formatDate(p.date)} · {p.createdByName || '—'}{p.note ? ` · ${p.note}` : ''}</p>
              </div>
              {canManage && <button onClick={() => undo(p)} className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600" title="Undo"><Trash2 className="h-4 w-4" /></button>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function LiabilitiesPage() {
  const { user } = useAuth();
  const toast = useToast();
  const canManage = user?.role === 'admin';
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // { opening } | { item }
  const [paying, setPaying] = useState(null);
  const [history, setHistory] = useState(null);
  const load = useCallback(() => {
    client.get('/liabilities').then((res) => setData(res.data.data)).catch((err) => toast.error(err.friendlyMessage || 'Failed to load liabilities.'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const remove = async (l) => {
    if (!window.confirm(`Delete "${l.name}" (${formatCurrency(l.amount)})?`)) return;
    try {
      await client.delete(`/liabilities/${l.id}`);
      toast.success('Deleted.');
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not delete it.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Liabilities"
        subtitle="Expenses charged but not paid yet -- they count in Profit & Loss now and are paid from here when the money comes. Feeds the Balance Sheet's Liabilities."
        actions={canManage && (
          <>
            <Button variant="secondary" onClick={() => setForm({ opening: true })}><Landmark className="h-4 w-4" /> Opening Balance</Button>
            <Button onClick={() => setForm({ opening: false })}><Plus className="h-4 w-4" /> Add Liability</Button>
          </>
        )}
      />
      <div className="mb-5 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Total owed" value={data ? formatCurrency(data.total) : '…'} />
        <StatCard label="Paid" value={data ? formatCurrency(data.paid) : '…'} />
        <StatCard label="Still to pay" value={data ? formatCurrency(data.left) : '…'} />
      </div>
      <Table>
        <THead>
          <tr>
            <Th>Owed to / for</Th>
            <Th>Category</Th>
            <Th>Date</Th>
            <Th>Amount</Th>
            <Th>Paid</Th>
            <Th>Left</Th>
            <Th>Actions</Th>
          </tr>
        </THead>
        <TBody>
          {data === null ? (
            <TableLoading colSpan={7} />
          ) : data.liabilities.length === 0 ? (
            <TableEmpty colSpan={7} message="No liabilities yet." />
          ) : (
            data.liabilities.map((l) => (
              <tr key={l.id}>
                <Td className="font-medium text-neutral-900">{l.name}{l.note ? <span className="block text-xs font-normal text-neutral-500">{l.note}</span> : null}</Td>
                <Td>{l.opening ? <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">Opening balance</span> : l.category}</Td>
                <Td>{formatDate(l.date)}</Td>
                <Td>{formatCurrency(l.amount)}</Td>
                <Td className="text-brand-700">{formatCurrency(l.paid)}</Td>
                <Td className={`font-bold ${l.left > 0 ? 'text-red-600' : 'text-neutral-400'}`}>{l.left > 0 ? formatCurrency(l.left) : 'Paid'}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1.5">
                    {canManage && l.left > 0 && <Button size="sm" onClick={() => setPaying(l)}><Banknote className="h-3.5 w-3.5" /> Pay</Button>}
                    <Button size="sm" variant="secondary" onClick={() => setHistory(l)} title="Payments"><History className="h-3.5 w-3.5" /></Button>
                    {canManage && <Button size="sm" variant="secondary" onClick={() => setForm({ item: l })} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                    {canManage && l.payments.length === 0 && <Button size="sm" variant="secondary" onClick={() => remove(l)} title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
                  </div>
                </Td>
              </tr>
            ))
          )}
        </TBody>
      </Table>
      <LiabilityFormModal open={!!form} item={form?.item} opening={!!form?.opening} onClose={() => setForm(null)} onSaved={load} />
      <PayModal item={paying} onClose={() => setPaying(null)} onSaved={load} />
      <PaymentsModal item={history} canManage={canManage} onClose={() => setHistory(null)} onChanged={load} />
    </div>
  );
}
