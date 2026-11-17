import { useEffect, useState } from 'react';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input, Textarea } from '../../components/ui/Field.jsx';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency } from '../../utils/format.js';
import SupplierPicker from './SupplierPicker.jsx';

function dayString(date) {
  const d = date ? new Date(date) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// What was already owed to a supplier before using the system. Saved as an
// unpaid "Opening" invoice, so it is paid off like any other invoice.
export default function SupplierOpeningBalanceModal({ open, initialSupplier, onClose, onSaved }) {
  const toast = useToast();
  const [supplier, setSupplier] = useState(null);
  const [amount, setAmount] = useState('0');
  const [date, setDate] = useState(dayString());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSupplier(initialSupplier || null);
    setAmount('0');
    setDate(dayString());
    setNotes('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = Number(amount) || 0;

  const save = async () => {
    if (!supplier) return toast.error('Select a supplier.');
    // Minus: we had paid them ahead, so they owe us.
    if (!total) return toast.error('Enter the opening balance (minus if the supplier owes you).');
    setSaving(true);
    try {
      const res = await client.post('/purchases', { supplierId: supplier.id, amount: total, amountPaid: 0, purchaseDate: date, notes, isOpeningBalance: true });
      toast.success(`Opening balance of ${formatCurrency(total)} added for ${supplier.name} (${res.data.data.purchaseNumber}).`);
      onSaved(res.data.data);
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save the opening balance.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Supplier Opening Balance"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={saving} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <SupplierPicker active={supplier} onSelect={setSupplier} onClear={() => setSupplier(null)} />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Opening Balance (minus if they owe you)" required>
            <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} />
          </FormField>
          <FormField label="Date">
            <Input type="date" value={date} max={dayString()} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Optional" />
        </FormField>
      </div>
    </Modal>
  );
}
