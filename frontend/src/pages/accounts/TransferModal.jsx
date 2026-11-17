import { useEffect, useState } from 'react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency } from '../../utils/format.js';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input, Select } from '../../components/ui/Field.jsx';

// Move money between our own accounts: choose the account it goes to, then
// how much from each of the others ("All" takes everything in it) -- e.g.
// put the money of every account into one.
export default function TransferModal({ open, onClose, onDone }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState([]);
  const [toId, setToId] = useState('');
  const [amounts, setAmounts] = useState({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToId('');
    setAmounts({});
    setNote('');
    client
      .get('/accounts')
      .then((r) => setAccounts(r.data.data.accounts.filter((a) => a.isActive)))
      .catch(() => setAccounts([]));
  }, [open]);

  const sources = accounts.filter((a) => a.id !== toId);
  const total = Math.round(sources.reduce((t, a) => t + (Number(amounts[a.id]) || 0), 0) * 100) / 100;
  const allIn = () => setAmounts(Object.fromEntries(sources.filter((a) => a.currentBalance > 0).map((a) => [a.id, String(a.currentBalance)])));
  const to = accounts.find((a) => a.id === toId);

  const save = async () => {
    if (!toId) return toast.error('Choose the account the money goes to.');
    const items = sources.map((a) => ({ fromAccountId: a.id, amount: Number(amounts[a.id]) || 0 })).filter((i) => i.amount > 0);
    if (!items.length) return toast.error('Enter an amount to move from at least one account.');
    const over = sources.find((a) => (Number(amounts[a.id]) || 0) > a.currentBalance);
    if (over) return toast.error(`${over.name} has only ${formatCurrency(over.currentBalance)}.`);
    setSaving(true);
    try {
      const r = await client.post('/accounts/transfer', { toAccountId: toId, items, note });
      toast.success(`${formatCurrency(r.data.data.total)} moved into ${r.data.data.to}.`);
      onDone();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not move the money.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Transfer between accounts" size="md">
      <div className="space-y-4">
        <FormField label="Move the money into" required>
          <Select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">Choose account...</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} -- {formatCurrency(a.currentBalance)}
              </option>
            ))}
          </Select>
        </FormField>

        {toId && (
          <div className="rounded-xl border border-neutral-200">
            <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">From</p>
              <Button size="sm" variant="secondary" onClick={allIn}>
                All money into {to?.name}
              </Button>
            </div>
            <div className="divide-y divide-neutral-100">
              {sources.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-neutral-900">{a.name}</p>
                    <p className="text-xs text-neutral-500">Has {formatCurrency(a.currentBalance)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input type="number" step="0.01" min="0" className="w-28 text-right" value={amounts[a.id] || ''} onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))} placeholder="0.00" disabled={!(a.currentBalance > 0)} />
                    <button type="button" className="text-xs font-semibold text-brand-700 hover:underline disabled:text-neutral-300" disabled={!(a.currentBalance > 0)} onClick={() => setAmounts((m) => ({ ...m, [a.id]: String(a.currentBalance) }))}>
                      All
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <FormField label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Optional" />
        </FormField>

        <div className="flex items-center justify-between gap-2 border-t border-neutral-100 pt-4">
          <p className="text-sm text-neutral-600">
            Total: <b className="text-neutral-900">{formatCurrency(total)}</b>
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!toId || !(total > 0)}>
              Transfer {formatCurrency(total)}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
