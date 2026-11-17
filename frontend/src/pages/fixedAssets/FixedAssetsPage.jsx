import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Landmark } from 'lucide-react';
import client from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import Modal from '../../components/ui/Modal.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import { FormField, Input, Textarea } from '../../components/ui/Field.jsx';
import { Table, THead, Th, TBody, Td, TableEmpty, TableLoading } from '../../components/ui/Table.jsx';
import FixedAssetWallet from './FixedAssetWallet.jsx';

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Handles both "Add Fixed Asset" (no asset passed) and "Edit Fixed Asset"
// (asset passed -- PUT, same fields prefilled).
// `opening`: the Opening Balance form -- equipment the company bought with its
// own money before this system, so nobody is owed for it.
function AssetFormModal({ open, asset, opening: openingMode = false, people = [], onClose, onSaved }) {
  const toast = useToast();
  const isEdit = !!asset;
  const [opening, setOpening] = useState(false);
  const [owedTo, setOwedTo] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [dateAdded, setDateAdded] = useState(today());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setOpening(asset ? !!asset.opening : openingMode);
      setOwedTo(asset?.owedTo || '');
      setName(asset?.name || '');
      setValue(asset ? String(asset.value) : '');
      setDateAdded(asset?.dateAdded ? asset.dateAdded.slice(0, 10) : today());
      setNotes(asset?.notes || '');
    }
  }, [open, asset, openingMode]);

  const save = async () => {
    if (!opening && !owedTo.trim()) return toast.error('Enter the name of the person it was bought from.');
    if (!name.trim()) return toast.error('Enter the asset name.');
    if (!(Number(value) >= 0)) return toast.error('Enter a valid value.');
    setSaving(true);
    try {
      const body = { opening, owedTo: opening ? '' : owedTo, name, value: Number(value), dateAdded, notes };
      if (isEdit) {
        await client.put(`/fixed-assets/${asset.id}`, body);
        toast.success(`"${name.trim()}" updated.`);
      } else {
        await client.post('/fixed-assets', body);
        toast.success(`"${name.trim()}" added to Fixed Assets.`);
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save asset.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Fixed Asset' : opening ? 'Opening Balance' : 'Add Fixed Asset'} size="sm">
      <div className="space-y-4">
        <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
          <input type="checkbox" className="mt-0.5" checked={opening} onChange={(e) => setOpening(e.target.checked)} />
          <span><b>Opening balance</b> -- bought with the company's own money before this system. Not a debt: nobody is owed for it.</span>
        </label>
        {!opening && (
          <FormField label="Bought from (owed to)" required>
            <Input value={owedTo} onChange={(e) => setOwedTo(e.target.value)} placeholder="Name of the person the company owes for it" list="fixed-asset-people" autoFocus />
            <datalist id="fixed-asset-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
          </FormField>
        )}
        <FormField label="Item" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Computer and Printer" autoFocus={opening} />
        </FormField>
        <FormField label="Amount" required>
          <Input type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
        </FormField>
        <FormField label="Date Added">
          <Input type="date" value={dateAdded} onChange={(e) => setDateAdded(e.target.value)} />
        </FormField>
        <FormField label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button loading={saving} onClick={save}>
            {isEdit ? 'Save Changes' : 'Save Asset'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function FixedAssetsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const [data, setData] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [openingOpen, setOpeningOpen] = useState(false);
  const [editAsset, setEditAsset] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState(false);

  // Bumped on every reload so the wallet's "owed to" list follows the assets.
  const [walletKey, setWalletKey] = useState(0);
  const people = [...new Set((data?.assets || []).map((a) => a.owedTo).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const load = useCallback(() => {
    client
      .get('/fixed-assets')
      .then((res) => { setData(res.data.data); setWalletKey((k) => k + 1); })
      .catch((err) => toast.error(err.friendlyMessage || 'Failed to load fixed assets.'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const confirmRemove = async () => {
    setRemoving(true);
    try {
      await client.post(`/fixed-assets/${removeTarget.id}/remove`, { reason });
      toast.success(`"${removeTarget.name}" removed from Fixed Assets.`);
      setRemoveTarget(null);
      setReason('');
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not remove asset.');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Fixed Assets"
        subtitle="Durable, non-trade assets the business owns (computers, shelving, furniture) -- feeds the Balance Sheet's Fixed Assets line."
        actions={
          canManage && (
            <>
              <Button variant="secondary" onClick={() => setOpeningOpen(true)}>
                <Landmark className="h-4 w-4" /> Opening Balance
              </Button>
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" /> Add Fixed Asset
              </Button>
            </>
          )
        }
      />

      <div className="mb-5 max-w-xs">
        <StatCard label="Total Fixed Assets" value={data ? formatCurrency(data.total) : '…'} />
      </div>

      {/* Only equipment bought with someone else's money is a debt. */}
      <FixedAssetWallet key={walletKey} canManage={user?.role === 'admin'} equipmentTotal={data?.owedTotal ?? data?.total ?? 0} />

      <Table>
        <THead>
          <tr>
            <Th>Owed to</Th>
            <Th>Item</Th>
            <Th>Amount</Th>
            <Th>Date Added</Th>
            <Th>Notes</Th>
            {canManage && <Th>Actions</Th>}
          </tr>
        </THead>
        <TBody>
          {data === null ? (
            <TableLoading colSpan={canManage ? 6 : 5} />
          ) : data.assets.length === 0 ? (
            <TableEmpty colSpan={canManage ? 6 : 5} message="No fixed assets recorded yet." />
          ) : (
            data.assets.map((a) => (
              <tr key={a.id}>
                <Td className="font-medium text-neutral-900">{a.opening ? <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">Opening balance -- not a debt</span> : a.owedTo || '—'}</Td>
                <Td>{a.name}</Td>
                <Td>{formatCurrency(a.value)}</Td>
                <Td>{formatDate(a.dateAdded)}</Td>
                <Td>{a.notes || '—'}</Td>
                {canManage && (
                  <Td>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setEditAsset(a)}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setRemoveTarget(a)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </Td>
                )}
              </tr>
            ))
          )}
        </TBody>
      </Table>

      <AssetFormModal open={addOpen} people={people} onClose={() => setAddOpen(false)} onSaved={load} />
      <AssetFormModal open={openingOpen} opening people={people} onClose={() => setOpeningOpen(false)} onSaved={load} />
      <AssetFormModal open={!!editAsset} asset={editAsset} people={people} onClose={() => setEditAsset(null)} onSaved={load} />

      <Modal open={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove Fixed Asset" size="sm">
        <p className="text-sm text-neutral-600">
          Remove <strong>{removeTarget?.name}</strong> ({removeTarget && formatCurrency(removeTarget.value)})? It stays on record but no longer counts
          toward Fixed Assets totals.
        </p>
        <Input className="mt-3" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRemoveTarget(null)} disabled={removing}>
            Cancel
          </Button>
          <Button variant="danger" loading={removing} onClick={confirmRemove}>
            Remove
          </Button>
        </div>
      </Modal>
    </div>
  );
}
