import { useEffect, useState } from 'react';
import Modal from '../../components/ui/Modal.jsx';
import AccountSelect from '../../components/AccountSelect.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input } from '../../components/ui/Field.jsx';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency } from '../../utils/format.js';

// Cash lent to a customer -- no goods. It leaves the chosen account and is
// added to what the customer owes; they pay it back with Pay Debt.
export default function GiveLoanModal({ open, onClose, customer, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setAmount('');
      setNote('');
    }
  }, [open]);

  const save = async () => {
    if (!(Number(amount) > 0)) return toast.error('Enter the amount lent.');
    if (!accountId) return toast.error('Choose the account the money is given from.');
    setSaving(true);
    try {
      const r = await client.post(`/customers/${customer.id}/loans`, { amount: Number(amount), accountId, note });
      toast.success(`${r.data.data.number}: ${formatCurrency(r.data.data.amount)} lent to ${customer.name}. They now owe ${formatCurrency(r.data.data.balance)}.`);
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not give the loan.');
    } finally {
      setSaving(false);
    }
  };

  if (!customer) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Lend money to ${customer.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Give Loan
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-neutral-600">
          Cash given to the customer, no goods. It comes out of the account below and is added to what they owe (now {formatCurrency(customer.balance || 0)}). They pay it back with <b>Pay Debt</b>.
        </p>
        <FormField label="Amount" required>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
        </FormField>
        <FormField label="Given from account" required>
          <AccountSelect value={accountId} onChange={setAccountId} placeholder="Select account..." />
        </FormField>
        <FormField label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Optional (why, when it is paid back...)" />
        </FormField>
      </div>
    </Modal>
  );
}
