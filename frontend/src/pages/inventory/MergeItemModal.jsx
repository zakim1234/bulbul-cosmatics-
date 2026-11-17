import { useEffect, useState } from 'react';
import { useListKeys } from '../../hooks/useListKeys.js';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useDebounce } from '../../hooks/useDebounce.js';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Field.jsx';

// Merge an item made by mistake into the one it really is: its stock,
// batches and history move there, the average cost is worked out from both
// (the stock is worth the same), and this item is removed.
export default function MergeItemModal({ open, item, onClose, onMerged }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const q = useDebounce(query, 250);
  const [matches, setMatches] = useState([]);
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const kb = useListKeys();

  useEffect(() => {
    if (!open) {
      setQuery('');
      setTarget(null);
      setMatches([]);
    }
  }, [open]);
  useEffect(() => {
    if (!q.trim()) return setMatches([]);
    client
      .get('/inventory/search', { params: { q: q.trim() } })
      .then((r) => setMatches(r.data.data.filter((m) => m.id !== item?.id).slice(0, 8)))
      .catch(() => setMatches([]));
  }, [q, item?.id]);

  const merge = async () => {
    setSaving(true);
    try {
      const res = await client.post(`/inventory/${item.id}/merge`, { intoId: target.id });
      toast.success(`${res.data.data.merged} merged into ${res.data.data.into.name}: now ${res.data.data.into.quantity} in stock.`);
      onMerged?.(res.data.data.into);
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not merge the items.');
    } finally {
      setSaving(false);
    }
  };

  if (!item) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Merge "${item.name}" into another item`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={merge} loading={saving} disabled={!target}>
            Merge
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-neutral-600">
          Use this when the same medicine was entered twice. Everything of <b>{item.name}</b> ({item.quantity} in stock) moves to the item you choose: its stock and batches, its suppliers, and every invoice, quotation and purchase. Then <b>{item.name}</b> is removed.
        </p>
        <div className="relative">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={target ? target.name : 'Search the item it really is…'} autoFocus onKeyDown={kb.onKeyDown} />
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
          <div className="rounded-lg bg-brand-50 p-3 text-brand-800">
            <p>
              <b>{item.name}</b> ({item.quantity}) + <b>{target.name}</b> ({target.quantity}) = <b>{Number(item.quantity) + Number(target.quantity)}</b> in <b>{target.name}</b>.
            </p>
            <p className="mt-1 text-xs text-brand-700">The average cost is worked out from both, so the stock is worth exactly the same and the Balance Sheet does not change. This cannot be undone.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
