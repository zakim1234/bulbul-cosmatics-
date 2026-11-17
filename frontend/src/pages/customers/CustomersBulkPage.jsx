import BulkSheet from '../../components/BulkSheet.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasPermission } from '../../constants/permissions.js';

const columns = [
  { key: 'name', label: 'Customer name', required: true, aliases: ['customer', 'name'] },
  { key: 'phone', label: 'Phone', aliases: ['mobile', 'tel'] },
  { key: 'openingBalance', label: 'Opening balance', type: 'money', aliases: ['opening', 'balance', 'amount', 'total', 'owed'] },
  { key: 'owed', label: 'Owed now', type: 'money', readOnly: true },
];

// Every customer in one sheet: correct names, phones and opening balances,
// add new customers, and save it all in one go.
export default function CustomersBulkPage() {
  const { user } = useAuth();
  const canAdd = hasPermission(user, 'createCustomers');
  const canDelete = hasPermission(user, 'deleteCustomers');
  return (
    <BulkSheet
      title="Customers sheet"
      subtitle="Every customer's name, phone and the debt they had before the system (opening balance). Change any of them, add new ones, then Save All."
      backTo="/customers"
      backLabel="Back to customers"
      columns={columns}
      canAdd={canAdd}
      canDelete={canDelete}
      clearUrl="/customers/clear"
      describeCleared={(d) => `Deleted ${d.customers || 0} customer(s).`}
      draftKey={`bulk_customers:${localStorage.getItem('pos_branch') || ''}`}
      loadUrl="/customers/sheet"
      endpoint="/customers/bulk"
      toPayload={(r) => ({ name: r.name.trim(), phone: r.phone.trim(), openingBalance: r.openingBalance === '' ? 0 : Number(r.openingBalance) })}
      problem={(r) => {
        if (!canAdd && !r.id) return 'you do not have permission to add new customers';
        if (!r.name.trim()) return "enter the customer's name";
        if (r.openingBalance !== '' && !(Number(r.openingBalance) >= 0)) return 'the opening balance must be 0 or more';
        return '';
      }}
      sameAs={(r) => r.name.trim().toLowerCase().replace(/\s+/g, ' ')}
      describeDone={(t) => `Saved: ${t.created || 0} new, ${t.updated || 0} changed${t.removed ? `, ${t.removed} deleted` : ''}.`}
    />
  );
}
