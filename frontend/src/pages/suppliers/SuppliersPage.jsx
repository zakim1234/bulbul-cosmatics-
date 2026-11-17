import { hasPermission } from '../../constants/permissions.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Pencil, Trash2 } from 'lucide-react';
import client from '../../api/client.js';
import { fetchAll } from '../../api/fetchAll.js';
import { useDebounce } from '../../hooks/useDebounce.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Field.jsx';
import { Table, THead, Th, TBody, Td, TableEmpty, TableLoading } from '../../components/ui/Table.jsx';
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx';
import SupplierFormModal from './SupplierFormModal.jsx';

export default function SuppliersPage() {
  const { user: me } = useAuth();
  // The server checks these too.
  const canEdit = hasPermission(me, 'editSuppliers');
  const canDelete = hasPermission(me, 'deleteSuppliers');
  const isAdmin = !!me?.isSuperAdmin || me?.role === 'admin';
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [formOpen, setFormOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const latest = useRef(0);

  // Every supplier, A to Z, on one long page.
  const load = useCallback(() => {
    const ticket = ++latest.current;
    setLoading(true);
    fetchAll('/suppliers', { search: debouncedSearch }, {
      isStale: () => ticket !== latest.current,
      onChunk: (rows) => {
        setItems(rows);
        setLoading(false);
      },
    })
      .catch((err) => ticket === latest.current && toast.error(err.friendlyMessage || 'Failed to load suppliers.'))
      .finally(() => ticket === latest.current && setLoading(false));
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => load(), [load]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await client.delete(`/suppliers/${deleteItem.id}`);
      toast.success('Supplier deleted.');
      setDeleteItem(null);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not delete supplier.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle="Manage supplier records and purchase history"
        actions={
          <Button
            onClick={() => {
              setEditItem(null);
              setFormOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Add Supplier
          </Button>
        }
      />

      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <Input className="pl-9" placeholder="Search by name or phone..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <Table>
        <THead>
          <tr>
            <Th>Name</Th>
            <Th>Phone</Th>
            <Th>Email</Th>
            <Th>Total Spent</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </THead>
        <TBody>
          {loading ? (
            <TableLoading colSpan={5} />
          ) : items.length === 0 ? (
            <TableEmpty colSpan={5} message="No suppliers found." />
          ) : (
            items.map((s) => (
              <tr key={s.id} className="hover:bg-neutral-50">
                <Td>
                  <Link to={`/suppliers/${s.id}`} className="font-medium text-neutral-900 hover:text-brand-600">
                    {s.name}
                  </Link>
                </Td>
                <Td>{s.phone || '—'}</Td>
                <Td>{s.email || '—'}</Td>
                <Td>{formatCurrency(s.totalSpent)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    {canEdit && (
<button
                      onClick={() => {
                        setEditItem(s);
                        setFormOpen(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-neutral-600 hover:bg-neutral-100 hover:text-brand-700"
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </button>
)}
                    {canDelete && (
<button onClick={() => setDeleteItem(s)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-neutral-600 hover:bg-neutral-100 hover:text-brand-700" title="Delete">
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
)}
                  </div>
                </Td>
              </tr>
            ))
          )}
        </TBody>
      </Table>
      <div className="rounded-b-xl border border-t-0 border-neutral-200/80 bg-white px-4 py-2.5 text-sm text-neutral-500">
        {items.length} supplier{items.length === 1 ? '' : 's'}
      </div>

      <SupplierFormModal open={formOpen} onClose={() => setFormOpen(false)} supplier={editItem} onSaved={load} nameAndPhoneOnly={!!editItem && !isAdmin} />
      <ConfirmDialog
        open={!!deleteItem}
        title="Delete Supplier"
        message={`Are you sure you want to delete "${deleteItem?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteItem(null)}
      />
    </div>
  );
}
