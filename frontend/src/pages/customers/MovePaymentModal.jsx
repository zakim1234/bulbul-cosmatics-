import { useEffect, useState } from 'react';
import { useListKeys } from '../../hooks/useListKeys.js';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input, Textarea } from '../../components/ui/Field.jsx';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency } from '../../utils/format.js';

// A debt payment entered on the wrong customer: this customer owes it again,
// and it pays the right customer's debt instead. The money stays in the
// account it came into.
export default function MovePaymentModal({ payment, customerId, fromName, onClose, onMoved }) {
  const kb = useListKeys();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!payment) return;
    setQuery('');
    setMatches([]);
    setTarget(null);
    setReason('');
  }, [payment]);

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
    if (!target) return toast.error('Choose the customer this payment belongs to.');
    setSaving(true);
    try {
      const res = await client.post(`/customers/${customerId}/payments/${payment.id}/move`, { toCustomerId: target.id, reason: reason.trim() });
      toast.success(`${formatCurrency(res.data.data.amount)} payment moved from ${res.data.data.from} to ${res.data.data.to}.`);
      onMoved(res.data.data);
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not move the payment.');
    } finally {
      setSaving(false);
    }
  };

  if (!payment) return null;
  return (
    <Modal
      open={!!payment}
      onClose={onClose}
      title={`Move payment ${payment.receiptNumber || ''} to another customer`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!target}>Move payment</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-neutral-50 px-3 py-2.5 text-sm text-neutral-600">
          <p>
            <span className="font-semibold text-neutral-800">{formatCurrency(payment.amount)}</span> debt payment, now on <span className="font-semibold text-neutral-800">{fromName}</span>
            {target && (
              <>
                {' '}→ moves to <span className="font-semibold text-brand-700">{target.name}</span>
              </>
            )}
          </p>
        </div>
        <FormField label="Customer who really paid" required>
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
        <FormField label="Why">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Put on the wrong name" />
        </FormField>
        <p className="text-xs text-neutral-500">
          {fromName} will owe this {formatCurrency(payment.amount)} again; it comes off {target ? target.name : 'the other customer'}'s debt instead. The money stays in the account it came into, and both histories show the move.
        </p>
      </div>
    </Modal>
  );
}
