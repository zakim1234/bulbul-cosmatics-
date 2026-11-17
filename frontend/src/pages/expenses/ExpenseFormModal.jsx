import { useEffect, useState } from 'react';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input, Select, Textarea } from '../../components/ui/Field.jsx';
import AccountSelect from '../../components/AccountSelect.jsx';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const emptyForm = () => ({ category: '', amount: '', date: today(), paymentAccountId: '', note: '' });

const NEW_CATEGORY = '__new__';

export default function ExpenseFormModal({ open, onClose, onSaved, categories, onCategoriesChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const canAddCategory = user?.role === 'admin' || user?.role === 'manager';
  const [newCategory, setNewCategory] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  // 'later': charged now as an expense but not paid -- it goes to the
  // Liabilities page and is paid from the right account there later.
  // For the admin (who manages Liabilities).
  const canPayLater = user?.role === 'admin';
  const [when, setWhen] = useState('now');
  const later = canPayLater && when === 'later';

  useEffect(() => {
    if (open) {
      setWhen('now');
      setForm(emptyForm());
      setErrors({});
      setNewCategory('');
    }
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const addCategory = async () => {
    setAddingCategory(true);
    try {
      const res = await client.post('/expenses/categories', { name: newCategory });
      await onCategoriesChanged?.();
      setForm((f) => ({ ...f, category: res.data.data.name }));
      setNewCategory('');
      toast.success(`Category "${res.data.data.name}" added.`);
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not add category.');
    } finally {
      setAddingCategory(false);
    }
  };

  const validate = () => {
    const e = {};
    if (!form.category || form.category === NEW_CATEGORY) e.category = 'Select a category.';
    if (!(Number(form.amount) > 0)) e.amount = 'Enter an amount greater than zero.';
    if (!later && !form.paymentAccountId) e.paymentAccountId = 'Select the account this was paid from.';
    if (!form.date) e.date = 'Select a date.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      if (later) {
        await client.post('/expenses', { ...form, paymentAccountId: undefined, payLater: true, amount: Number(form.amount) });
        toast.success('Expense charged (it is in this month\'s expenses) and put on the Liabilities page -- pay it from the right account there when the money comes.');
      } else {
        await client.post('/expenses', { ...form, amount: Number(form.amount) });
        toast.success('Expense saved and deducted from the account.');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save expense.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Expense" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormField label="Category" required error={errors.category}>
          <Select value={form.category} onChange={set('category')} error={errors.category}>
            <option value="">Select category...</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            {canAddCategory && <option value={NEW_CATEGORY}>+ Add new category...</option>}
          </Select>
          {form.category === NEW_CATEGORY && (
            <div className="mt-2 flex gap-2">
              <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} maxLength={60} placeholder="e.g. Internet, Cleaning" autoFocus />
              <Button type="button" onClick={addCategory} loading={addingCategory} disabled={!newCategory.trim()}>
                Add
              </Button>
            </div>
          )}
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Amount" required error={errors.amount}>
            <Input type="number" step="0.01" min="0" value={form.amount} onChange={set('amount')} placeholder="0.00" error={errors.amount} />
          </FormField>
          <FormField label="Date" required error={errors.date}>
            <Input type="date" value={form.date} onChange={set('date')} error={errors.date} />
          </FormField>
        </div>
        {canPayLater && (
          <div className="grid grid-cols-2 gap-2">
            {[
              ['now', 'Pay now', 'From an account today'],
              ['later', 'Pay later', 'Expense now, to Liabilities -- no account moves'],
            ].map(([key, label, hint]) => (
              <button key={key} type="button" onClick={() => setWhen(key)} className={`rounded-xl border px-3 py-2 text-left text-sm ${when === key ? 'border-brand-400 bg-brand-50' : 'border-neutral-200 hover:border-neutral-300'}`}>
                <span className="block font-semibold text-neutral-900">{label}</span>
                <span className="block text-xs text-neutral-500">{hint}</span>
              </button>
            ))}
          </div>
        )}
        {!later && (
          <FormField label="Payment Account" required error={errors.paymentAccountId}>
            <AccountSelect value={form.paymentAccountId} onChange={(id) => setForm((f) => ({ ...f, paymentAccountId: id || '' }))} />
          </FormField>
        )}
        <FormField label="Note">
          <Textarea rows={2} maxLength={500} value={form.note} onChange={set('note')} placeholder="e.g. Cumar's salary" />
        </FormField>
        <div className="flex justify-end gap-2 border-t border-neutral-100 pt-4">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {later ? 'Save -- pay later' : 'Save Expense'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
