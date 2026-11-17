import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Plus, FileText, Users, Building2, Trash2 } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import Modal from '../../components/ui/Modal.jsx';
import { FormField, Input, Select } from '../../components/ui/Field.jsx';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// One side of the offset: a searchable list.
function PartyPicker({ label, icon: Icon, items, value, onChange, amountLabel, amountKey }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200), [items, q]);
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-3">
      <p className="mb-2 flex items-center gap-2 text-sm font-bold text-neutral-900"><Icon className="h-4 w-4 text-neutral-400" />{label}</p>
      <Input placeholder="Search name..." value={q} onChange={(e) => setQ(e.target.value)} />
      <Select className="mt-2" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose...</option>
        {shown.map((i) => (
          <option key={i.id} value={i.id}>{i.name} -- {amountLabel} {formatCurrency(i[amountKey])}</option>
        ))}
      </Select>
    </div>
  );
}

function NewOffsetModal({ open, onClose, onSaved }) {
  const toast = useToast();
  const [parties, setParties] = useState(null);
  const [customerId, setCustomerId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [preview, setPreview] = useState(null);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomerId(''); setSupplierId(''); setPreview(null); setDate(today()); setNote('');
    client.get('/offsets/parties').then((r) => setParties(r.data.data)).catch((err) => { toast.error(err.friendlyMessage || 'Could not load customers and suppliers.'); setParties({ customers: [], suppliers: [] }); });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPreview(null);
    if (!customerId || !supplierId) return;
    client.get('/offsets/preview', { params: { customerId, supplierId } }).then((r) => setPreview(r.data.data)).catch(() => setPreview(null));
  }, [customerId, supplierId]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await client.post('/offsets', { customerId, supplierId, date, note });
      toast.success(`${r.data.data.number}: ${formatCurrency(r.data.data.amount)} set off.`);
      onSaved(r.data.data);
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save the offset.');
    } finally {
      setSaving(false);
    }
  };
  const cName = parties?.customers.find((c) => String(c.id) === customerId)?.name;
  const sName = parties?.suppliers.find((s) => String(s.id) === supplierId)?.name;

  return (
    <Modal open={open} onClose={onClose} size="lg" title="New offset — customer and supplier" footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={!(preview?.amount > 0)}>Set off {formatCurrency(preview?.amount || 0)}</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">The smaller of the two amounts comes off both sides and becomes 0; the bigger side keeps the difference. No money moves in any account.</p>
        {!parties ? (
          <p className="py-6 text-center text-sm text-neutral-400">Loading…</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <PartyPicker label="Customer (owes us)" icon={Users} items={parties.customers} value={customerId} onChange={setCustomerId} amountLabel="owes" amountKey="owes" />
            <PartyPicker label="Supplier (we owe)" icon={Building2} items={parties.suppliers} value={supplierId} onChange={setSupplierId} amountLabel="owed" amountKey="owed" />
          </div>
        )}
        {preview && (
          <div className="overflow-hidden rounded-2xl border border-neutral-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-neutral-50 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  <th className="px-4 py-2"></th>
                  <th className="px-4 py-2 text-right">Now</th>
                  <th className="px-4 py-2 text-right">Set off</th>
                  <th className="px-4 py-2 text-right">After</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-neutral-100">
                  <td className="px-4 py-2"><b>{cName}</b> <span className="text-neutral-500">owes us</span></td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(preview.customerOwes)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-red-600">−{formatCurrency(preview.amount)}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums">{formatCurrency(preview.customerAfter)}</td>
                </tr>
                <tr className="border-t border-neutral-100">
                  <td className="px-4 py-2"><span className="text-neutral-500">We owe</span> <b>{sName}</b></td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(preview.supplierOwed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-red-600">−{formatCurrency(preview.amount)}</td>
                  <td className="px-4 py-2 text-right font-bold tabular-nums">{formatCurrency(preview.supplierAfter)}</td>
                </tr>
              </tbody>
            </table>
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

export default function OffsetsPage() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const load = () => client.get('/offsets').then((r) => setRows(r.data.data)).catch((err) => { toast.error(err.friendlyMessage || 'Could not load offsets.'); setRows([]); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (o) => {
    const msg = o.status === 'CANCELLED'
      ? `Delete ${o.number}? It is already cancelled -- only the record is removed.`
      : `Delete ${o.number}?\n\n${o.customerName} will owe ${formatCurrency(o.amount)} again and ${o.supplierName} will be owed ${formatCurrency(o.amount)} again, as before.`;
    if (!window.confirm(msg)) return;
    try {
      await client.delete(`/offsets/${o.id}`);
      toast.success(`${o.number} deleted; everything is back as before.`);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not delete it.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Customer ↔ Supplier Offset"
        subtitle="Someone who is both your customer and your supplier: set off what they owe you against what you owe them, whenever you choose."
        actions={
          <div className="flex gap-2">
            <Link to="/offsets/statement"><Button variant="secondary"><FileText className="h-4 w-4" /> Statement</Button></Link>
            <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New offset</Button>
          </div>
        }
      />
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
        {rows === null ? (
          <p className="py-10 text-center text-sm text-neutral-400">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center">
            <ArrowLeftRight className="mx-auto h-9 w-9 text-brand-600" />
            <p className="mt-2 font-bold text-neutral-900">No offsets yet</p>
            <p className="text-sm text-neutral-500">Example: Axmed owes you $2,000 and you bought $1,000 from him -- set off $1,000: he owes $1,000, you owe him $0.</p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {rows.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><ArrowLeftRight className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-neutral-900">
                    {o.customerName} <span className="text-neutral-400">↔</span> {o.supplierName}
                    <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600">{o.number}</span>
                    {o.status === 'CANCELLED' && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600">Cancelled</span>}
                  </p>
                  <p className="text-xs text-neutral-500">{formatDate(o.date)} · {o.createdByName || '—'}{o.note ? ` · ${o.note}` : ''}</p>
                </div>
                <p className={`font-bold tabular-nums ${o.status === 'CANCELLED' ? 'text-neutral-400 line-through' : 'text-neutral-900'}`}>{formatCurrency(o.amount)}</p>
                <Link to={`/offsets/${o.id}`}><Button size="sm" variant="secondary"><FileText className="h-3.5 w-3.5" /> Voucher</Button></Link>
                <button onClick={() => remove(o)} className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewOffsetModal open={open} onClose={() => setOpen(false)} onSaved={() => load()} />
    </div>
  );
}
