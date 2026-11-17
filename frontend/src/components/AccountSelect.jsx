import { useEffect, useState } from 'react';
import client from '../api/client.js';
import { Select } from './ui/Field.jsx';
import { formatCurrency } from '../utils/format.js';

// Populates its options live from the Accounts database -- never a
// hardcoded list -- so new accounts created on the Accounts page are
// immediately selectable here.
// `showBalance`: each account with the money in it now, e.g. "EVC Plus -- $1,200.00".
// `excludeId` leaves one account out; `onlyId` lists that one account only.
export default function AccountSelect({ value, onChange, disabled, className = '', allowEmpty = true, placeholder = 'Select account...', showBalance = false, excludeId = null, onlyId = null }) {
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    client
      .get('/accounts')
      .then((res) => setAccounts(res.data.data.accounts.filter((a) => a.isActive)))
      .catch(() => setAccounts([]));
  }, []);

  return (
    <Select value={value || ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className={className}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {accounts.filter((a) => (onlyId ? a.id === onlyId : a.id !== excludeId)).map((a) => (
        <option key={a.id} value={a.id}>
          {showBalance ? `${a.name} -- ${formatCurrency(a.currentBalance)}` : a.name}
        </option>
      ))}
    </Select>
  );
}

export function useAccounts() {
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    client
      .get('/accounts')
      .then((res) => setAccounts(res.data.data.accounts.filter((a) => a.isActive)))
      .catch(() => setAccounts([]));
  }, []);
  return accounts;
}
