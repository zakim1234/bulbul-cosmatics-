import { useEffect, useState } from 'react';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input, Textarea } from '../../components/ui/Field.jsx';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasPermission } from '../../constants/permissions.js';

const empty = { name: '', phone: '', email: '', address: '', openingBalance: '0', notes: '' };

export default function CustomerFormModal({ open, onClose, customer, onSaved }) {
  const toast = useToast();
  const { user } = useAuth();
  // Changing what an existing customer owed is a money change.
  const canEditOpening = !customer || hasPermission(user, 'changeOpeningDebt');
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (customer) {
      setForm({
        name: customer.name || '',
        phone: customer.phone || '',
        email: customer.email || '',
        address: customer.address || '',
        openingBalance: String(customer.openingBalance ?? 0),
        notes: customer.notes || '',
      });
    } else {
      setForm(empty);
    }
    setError('');
  }, [customer, open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Customer name is required.');
      return;
    }
    setSaving(true);
    try {
      if (customer) {
        await client.put(`/customers/${customer.id}`, form);
        const opening = Number(form.openingBalance) || 0;
        if (canEditOpening && opening !== Number(customer.openingBalance ?? 0)) {
          await client.put(`/customers/${customer.id}/opening-balance`, { openingBalance: opening });
        }
        toast.success('Customer updated.');
      } else {
        await client.post('/customers', form);
        toast.success('Customer created.');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save customer.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={customer ? 'Edit Customer' : 'Add Customer'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">{error}</div>}
        <FormField label="Full Name" required>
          <Input value={form.name} onChange={set('name')} placeholder="e.g. Ahmed Ali" />
        </FormField>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Phone">
            <Input value={form.phone} onChange={set('phone')} placeholder="Optional" />
          </FormField>
          <FormField label="Email">
            <Input value={form.email} onChange={set('email')} placeholder="Optional" />
          </FormField>
        </div>
        <FormField label="Address">
          <Input value={form.address} onChange={set('address')} placeholder="Optional" />
        </FormField>
        {canEditOpening && (
          <FormField label="Opening Balance">
            <Input type="number" min="0" step="0.01" value={form.openingBalance} onChange={set('openingBalance')} />
            {customer && <p className="mt-1 text-xs text-neutral-500">What they owed before the system. Changing it moves their debt by the same amount.</p>}
          </FormField>
        )}
        <FormField label="Notes">
          <Textarea rows={2} value={form.notes} onChange={set('notes')} placeholder="Optional" />
        </FormField>
        <div className="flex justify-end gap-2 border-t border-neutral-100 pt-4">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {customer ? 'Save Changes' : 'Create Customer'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
