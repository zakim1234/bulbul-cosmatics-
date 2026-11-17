import { useEffect, useState } from 'react';
import { useListKeys } from '../../hooks/useListKeys.js';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input, Textarea } from '../../components/ui/Field.jsx';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency } from '../../utils/format.js';

// Moves an invoice put on the wrong customer to the right one (Super Admin,
// or an admin the Super Admin allowed). What it owes and what was paid at
// the sale go with it; both customers' histories record the move.
export default function TransferInvoiceModal({ sale, customerId, fromName, onClose, onMoved }) {
  const kb = useListKeys();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!sale) return;
    setQuery('');
    setMatches([]);
    setTarget(null);
    setReason('');
  }, [sale]);

  useEffect(() => {
    const q = query.trim();
    if (!q || target?.name === query) return setMatches([]);
    let alive = true;
    const timer = setTimeout(() => {
      client
        .get('/customers/search', { params: { q } })
        .then((res) => alive && setMatches(res.data.data.filter((c) => String(c.id) !== String(customerId))))
        .catch(() => alive && setMatches([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!target) return toast.error('Choose the customer this invoice belongs to.');
    if (!reason.trim()) return toast.error('Say why the invoice is being moved.');
    setSaving(true);
    try {
      const res = await client.post(`/sales/${sale.id}/transfer`, { customerId: target.id, reason: reason.trim() });
      toast.success(`${res.data.data.receiptNumber} moved from ${res.data.data.from} to ${res.data.data.to}.`);
      onMoved(res.data.data);
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not move the invoice.');
    } finally {
      setSaving(false);
    }
  };

  if (!sale) return null;
  return (
    <Modal
      open={!!sale}
      onClose={onClose}
      title={`Move ${sale.receiptNumber} to another customer`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!target || !reason.trim()}>Move invoice</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-neutral-50 px-3 py-2.5 text-sm text-neutral-600">
          <p>
            <span className="font-semibold text-neutral-800">{sale.receiptNumber}</span> · total {formatCurrency(sale.total)}
            {sale.outstanding > 0 ? ` · ${formatCurrency(sale.outstanding)} still owed` : ' · fully paid'}
          </p>
          <p className="mt-0.5">
            Now on <span className="font-semibold text-neutral-800">{fromName}</span>
            {target && (
              <>
                {' '}→ moves to <span className="font-semibold text-brand-700">{target.name}</span>
              </>
            )}
          </p>
        </div>
        <FormField label="Customer it belongs to" required>
          <div className="relative">
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setTarget(null);
              }}
              placeholder="Search name or phone..."
              autoFocus
              onKeyDown={kb.onKeyDown}
            />
            {matches.length > 0 && !target && (
              <div ref={kb.listRef} className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-neutral-200 bg-white shadow-xl">
                {matches.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-brand-50"
                    onClick={() => {
                      setTarget(c);
                      setQuery(c.name);
                      setMatches([]);
                    }}
                  >
                    {c.name}
                    <small className="block text-neutral-500">
                      {c.phone || 'No phone'} · owes {formatCurrency(c.balance || 0)}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </FormField>
        <FormField label="Why" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </FormField>
        <p className="text-xs text-neutral-500">
          Everything moves with the invoice: what it still owes, and every payment made on it (at the sale or later). Wallet money used on it goes back to {fromName}'s wallet, and the other customer owes that part. Both histories show the move.
        </p>
      </div>
    </Modal>
  );
}
