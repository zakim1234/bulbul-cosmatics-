import BulkSheet from '../../components/BulkSheet.jsx';

// Every customer's credit limit in one sheet: the name and the limit only.
// Blank = no limit, 0 = nothing on credit. Paste from Excel (name, limit):
// each name finds its customer. The Credit limits permission.
const columns = [
  { key: 'name', label: 'Customer name', required: true, lockExisting: true, aliases: ['customer', 'name'] },
  { key: 'creditLimit', label: 'Credit limit', type: 'money', aliases: ['limit', 'credit', 'credit limit'] },
  { key: 'owed', label: 'Owed now', type: 'money', readOnly: true },
];

export default function CreditLimitsSheetPage() {
  return (
    <BulkSheet
      title="Credit limits"
      subtitle="Each customer's credit limit: the most they may owe. Blank = no limit, 0 = nothing on credit. Type or paste them (name, limit), then Save All."
      backTo="/customers"
      backLabel="Back to customers"
      columns={columns}
      canAdd={false}
      canDelete={false}
      draftKey={`bulk_credit_limits:${localStorage.getItem('pos_branch') || ''}`}
      loadUrl="/customers/credit-limits"
      endpoint="/customers/credit-limits"
      blankRows={0}
      toPayload={(r) => ({ id: r.id, creditLimit: r.creditLimit === '' || r.creditLimit == null ? null : Number(r.creditLimit) })}
      problem={(r) => {
        if (!r.id) return 'no customer has this name';
        if (r.creditLimit !== '' && r.creditLimit != null && !(Number(r.creditLimit) >= 0)) return 'the credit limit must be 0 or more';
        return '';
      }}
      sameAs={(r) => r.name.trim().toLowerCase().replace(/\s+/g, ' ')}
      describeDone={(t) => `Saved: ${t.updated || 0} credit limit(s) changed.`}
    />
  );
}
