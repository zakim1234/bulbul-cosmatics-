import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useDebounce } from '../hooks/useDebounce.js';
import { useListKeys } from '../hooks/useListKeys.js';
import { hasPermission } from '../constants/permissions.js';
import { formatCurrency, formatDate } from '../utils/format.js';
import Modal from './ui/Modal.jsx';
import Button from './ui/Button.jsx';
import { Input } from './ui/Field.jsx';

// Batches of one item, and its stock movements. A batch put on the wrong item
// can be moved to the right one (onChanged reloads the page that shows it).
export default function BatchHistory({ item, onChanged }) {
  const { user } = useAuth();
  const canMove = !!onChanged && hasPermission(user, 'mergeItems');
  const [moving, setMoving] = useState(null);

  return (
    <section className="mt-5 overflow-x-auto">
      <h3 className="font-semibold">Stock / Batch History</h3>
      <p className="my-2 text-sm">
        Physical: {item.quantity} · Sellable: {item.availableQuantity} · Expired: {item.expiredQuantity || 0} · Times Stocked: {item.timesStocked || 0} · Total Received: {item.totalReceived || 0}
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr>
            {['Stock Serial', 'Received', 'Original', 'Remaining', 'Reserved', 'Cost', 'Selling', 'Expiry', 'Supplier', ''].map((h, i) => (
              <th key={i} className="p-2 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(item.batches || []).map((b) => (
            <tr key={b._id} className="border-t">
              <td className="p-2">
                <Link to={`/stock?q=${encodeURIComponent(b.stockSerial || '')}`}>{b.stockSerial || b.purchase?.purchaseNumber || 'Legacy stock'}</Link>
              </td>
              <td>{formatDate(b.receivedAt || b.createdAt)}</td>
              <td>{b.originalQuantity}</td>
              <td>{b.remainingQuantity}</td>
              <td>{b.reservedQuantity || 0}</td>
              <td>{formatCurrency(b.unitCostCents / 100)}</td>
              <td>{b.sellingPriceCents == null ? '—' : formatCurrency(b.sellingPriceCents / 100)}</td>
              <td>{b.expiryDate?.slice(0, 10) || '—'}</td>
              <td>{b.supplier?.name || '—'}</td>
              <td className="no-print p-1 text-right">
                {canMove && b.remainingQuantity > 0 && !(b.reservedQuantity > 0) && (
                  <button type="button" onClick={() => setMoving(b)} className="rounded-md border border-neutral-200 px-2 py-1 font-semibold text-neutral-700 hover:bg-neutral-50" title="Put on the wrong item? Move it to the right one">
                    Move
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className="mt-4 font-semibold">Stock movements</h4>
      {(item.stockEvents || []).map((event, i) => (
        <p key={i} className="text-xs">
          {formatDate(event.at)} · {event.type} · {event.reference} · {event.quantityBefore} → {event.quantityAfter}
        </p>
      ))}
      <MoveLotModal
        lot={moving}
        item={item}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          onChanged?.();
        }}
      />
    </section>
  );
}

// Choose the item a batch really belongs to.
function MoveLotModal({ lot, item, onClose, onMoved }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const q = useDebounce(query, 250);
  const [matches, setMatches] = useState([]);
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const kb = useListKeys();

  useEffect(() => {
    if (!lot) {
      setQuery('');
      setTarget(null);
      setMatches([]);
    }
  }, [lot]);
  useEffect(() => {
    if (!q.trim()) return setMatches([]);
    client
      .get('/inventory/search', { params: { q: q.trim() } })
      .then((r) => setMatches(r.data.data.filter((m) => m.id !== item.id).slice(0, 8)))
      .catch(() => setMatches([]));
  }, [q, item.id]);

  const move = async () => {
    setSaving(true);
    try {
      const r = await client.post(`/inventory/lots/${lot._id}/move`, { toItemId: target.id });
      toast.success(`${r.data.data.quantity} moved from ${r.data.data.from} to ${r.data.data.into}.`);
      onMoved();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not move the batch.');
    } finally {
      setSaving(false);
    }
  };

  if (!lot) return null;
  return (
    <Modal
      open={!!lot}
      onClose={onClose}
      title={`Move ${lot.stockSerial || 'batch'} to another item`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={move} loading={saving} disabled={!target}>
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-neutral-600">
          The <b>{lot.remainingQuantity}</b> left of this batch (cost {formatCurrency(lot.unitCostCents / 100)}) go from <b>{item.name}</b> to the item you choose, with their supplier and expiry. Both items' average cost is worked out again; the stock is worth the same, so the Balance Sheet does not change.
        </p>
        <div className="relative">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={kb.onKeyDown} placeholder={target ? target.name : 'Search the right item…'} autoFocus />
          {matches.length > 0 && (
            <div ref={kb.listRef} className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-neutral-200 bg-white shadow-xl">
              {matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setTarget(m);
                    setQuery('');
                    setMatches([]);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-brand-50"
                >
                  <span className="font-medium text-neutral-900">{m.name}</span>
                  <span className="text-xs text-neutral-500">{m.quantity} in stock</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {target && (
          <p className="rounded-lg bg-brand-50 p-3 text-brand-800">
            {lot.remainingQuantity} of <b>{item.name}</b> → <b>{target.name}</b> (now {target.quantity}, then {Number(target.quantity) + Number(lot.remainingQuantity)}).
          </p>
        )}
      </div>
    </Modal>
  );
}
