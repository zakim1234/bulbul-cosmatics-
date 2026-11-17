import { useEffect, useState } from 'react';
import Modal from '../../components/ui/Modal.jsx';
import Button from '../../components/ui/Button.jsx';
import { FormField, Input, Select } from '../../components/ui/Field.jsx';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';

const TYPES = [
  { value: 'MOBILE_MONEY', label: 'Mobile Money' },
  { value: 'BANK', label: 'Bank' },
  { value: 'MERCHANT', label: 'Merchant' },
  { value: 'OTHER', label: 'Other' },
];

export default function AccountFormModal({ open, onClose, onSaved, account }) {
  const toast = useToast();
  const isEdit = !!account;
  const [name, setName] = useState('');
  const [type, setType] = useState('MOBILE_MONEY');
  const [accountNumber, setAccountNumber] = useState('');
  const [openingBalance, setOpeningBalance] = useState('0');
  const [vatPercent, setVatPercent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(account?.name || '');
      setType(account?.type || 'MOBILE_MONEY');
      setAccountNumber(account?.accountNumber || '');
      setOpeningBalance(account ? String(account.openingBalance) : '0');
      setVatPercent(account?.vatPercent ? String(account.vatPercent) : '');
    }
  }, [open, account]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('Please enter an account name.');
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        await client.put(`/accounts/${account.id}`, { name, type, accountNumber, openingBalance: Number(openingBalance) || 0, vatPercent: type === 'MERCHANT' ? Number(vatPercent) || 0 : 0 });
        toast.success('Account updated.');
      } else {
        await client.post('/accounts', { name, type, accountNumber, openingBalance: Number(openingBalance) || 0, vatPercent: type === 'MERCHANT' ? Number(vatPercent) || 0 : 0 });
        toast.success('Account created.');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not save this account.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Account' : 'New Account'} size="sm">
      <div className="space-y-4">
        <FormField label="Account Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Premier Bank" />
        </FormField>
        <FormField label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Account Number (optional)">
          <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Optional" />
        </FormField>
        {type === 'MERCHANT' && (
          <FormField label="VAT % (Merchant)">
            <Input type="number" min="0" max="100" step="0.01" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} placeholder="e.g. 5" />
            <p className="mt-1 text-xs text-neutral-500">What the merchant company keeps out of each payment (e.g. 3%: the customer sends $100, this account gets $97). The $3 is recorded as a Merchant VAT expense.</p>
          </FormField>
        )}
        <FormField label="Opening Balance">
          <Input type="number" step="0.01" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
          <p className="mt-1 text-xs text-neutral-500">The money in this account before the system. Changing it moves the balance by the same amount.</p>
        </FormField>
        <div className="flex justify-end gap-2 border-t border-neutral-100 pt-4">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            {isEdit ? 'Save Changes' : 'Create Account'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
