import { hasPermission, showBulkTools } from '../../constants/permissions.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Pencil, Trash2, ScrollText, Rows3, ShieldCheck } from 'lucide-react';
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
import CustomerFormModal from './CustomerFormModal.jsx';
import ClearAllButton from '../../components/ClearAllButton.jsx';
import ImportExcelButton from '../../components/ImportExcelButton.jsx';

export default function CustomersPage() {
  const { user: me } = useAuth();
  const canEdit = hasPermission(me, 'editCustomers'); // the server checks this too
  const canDelete = hasPermission(me, 'deleteCustomers');
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

  // Every customer, A to Z, on one long page.
  const load = useCallback(() => {
    const ticket = ++latest.current;
    setLoading(true);
    fetchAll('/customers', { search: debouncedSearch }, {
      isStale: () => ticket !== latest.current,
      onChunk: (rows) => {
        setItems(rows);
        setLoading(false);
      },
    })
      .catch((err) => ticket === latest.current && toast.error(err.friendlyMessage || 'Failed to load customers.'))
      .finally(() => ticket === latest.current && setLoading(false));
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => load(), [load]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await client.delete(`/customers/${deleteItem.id}`);
      toast.success('Customer deleted. Sales and balance history have been preserved.');
      setDeleteItem(null);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not delete customer.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Manage customer records and outstanding balances"
        actions={
          <div className="flex flex-wrap gap-2">
            <ClearAllButton
              what="all customers"
              warning="Their debts, opening balances and wallet history go too. Sales already made keep the customer's name on the invoice."
              url="/customers/clear"
              describe={(d) => `Deleted ${d.customers || 0} customer(s).`}
              onDone={load}
            />
            <Link to="/customers/debtors" className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/80 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">
              <ScrollText className="h-4 w-4 text-brand-600" /> Debtors statement
            </Link>
            {hasPermission(me, 'creditLimits') && (
              <Link to="/customers/credit-limits" className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/80 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">
                <ShieldCheck className="h-4 w-4 text-brand-600" /> Credit limits
              </Link>
            )}
            {hasPermission(me, 'customersSheet') && <ImportExcelButton to="/customers/bulk" />}
            {/* Edit / Add Many and Add Customer: Super Admin, once switched on in Settings. */}
            {showBulkTools(me) && hasPermission(me, 'customersSheet') && (
              <Link to="/customers/bulk" className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200/80 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">
                <Rows3 className="h-4 w-4 text-brand-600" /> Edit / Add Many
              </Link>
            )}
            {showBulkTools(me) && hasPermission(me, 'createCustomers') && (
              <Button
                onClick={() => {
                  setEditItem(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> Add Customer
              </Button>
            )}
          </div>
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
            <Th>Total Purchased</Th>
            <Th>Balance</Th>
            <Th>Credit limit</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </THead>
        <TBody>
          {loading ? (
            <TableLoading colSpan={6} />
          ) : items.length === 0 ? (
            <TableEmpty colSpan={6} message="No customers found." />
          ) : (
            items.map((c) => (
              <tr key={c.id} className="hover:bg-neutral-50">
                <Td>
                  <Link to={`/customers/${c.id}`} className="font-medium text-neutral-900 hover:text-brand-600">
                    {c.name}
                  </Link>
                </Td>
                <Td>{c.phone || '—'}</Td>
                <Td>{formatCurrency(c.totalPurchased)}</Td>
                <Td>
                  <span className={`font-semibold ${c.balance > 0 ? 'text-brand-600' : 'text-emerald-600'}`}>
                    {formatCurrency(c.balance)}
                  </span>
                </Td>
                <Td className="tabular-nums text-neutral-700">{c.creditLimit == null ? <span className="text-neutral-300">No limit</span> : formatCurrency(c.creditLimit)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    {canEdit && (
<button
                      onClick={() => {
                        setEditItem(c);
                        setFormOpen(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-neutral-600 hover:bg-neutral-100 hover:text-brand-700"
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </button>
)}
                    {canDelete && (
<button onClick={() => setDeleteItem(c)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-neutral-600 hover:bg-neutral-100 hover:text-brand-700" title="Delete">
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
        {items.length} customer{items.length === 1 ? '' : 's'}
      </div>

      <CustomerFormModal open={formOpen} onClose={() => setFormOpen(false)} customer={editItem} onSaved={load} />
      <ConfirmDialog
        open={!!deleteItem}
        title="Delete Customer"
        message={`Remove "${deleteItem?.name}" from the customer list? Sales, debts, and transaction history will be preserved.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteItem(null)}
      />
    </div>
  );
}
