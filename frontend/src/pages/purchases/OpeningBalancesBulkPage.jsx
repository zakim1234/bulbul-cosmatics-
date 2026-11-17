import BulkSheet from '../../components/BulkSheet.jsx';

const columns = [
  { key: 'supplierName', label: 'Supplier name', required: true, lockExisting: true, aliases: ['supplier', 'vendor', 'name'] },
  { key: 'amount', label: 'Opening balance', type: 'money', negative: true, aliases: ['opening', 'balance', 'amount', 'total', 'owed'] },
  { key: 'owed', label: 'Owed now', type: 'money', readOnly: true },
];

// Every supplier opening balance in one sheet: correct amounts, add what we
// owed other suppliers (new ones are created), and save it all in one go.
export default function OpeningBalancesBulkPage() {
  return (
    <BulkSheet
      title="Supplier opening balances"
      subtitle="Every supplier, with what we owed them before the system (opening balance) and what they are owed now. Type or change an opening balance (minus, e.g. -50, when you had paid them ahead and they owe you), add new suppliers below (they are created), then Save All."
      backTo="/purchases"
      backLabel="Back to purchase invoices"
      columns={columns}
      clearUrl="/suppliers/clear"
      describeCleared={(d) => `Deleted ${d.suppliers || 0} supplier(s) and ${d.purchases || 0} purchase invoice(s).`}
      draftKey={`bulk_opening:${localStorage.getItem('pos_branch') || ''}`}
      loadUrl="/purchases/opening-balances/sheet"
      endpoint="/purchases/opening-balances/bulk"
      toPayload={(r) => ({ supplierName: r.supplierName.trim(), amount: Number(r.amount) })}
      problem={(r) => {
        if (!r.supplierName.trim()) return "enter the supplier's name";
        // Minus means we had paid them ahead: they owe us.
        if (r.amount === '' || !Number.isFinite(Number(r.amount)) || Number(r.amount) === 0) return `enter the opening balance for ${r.supplierName.trim()} (minus if they owe you)`;
        return '';
      }}
      sameAs={(r) => r.supplierName.trim().toLowerCase().replace(/\s+/g, ' ')}
      describeDone={(t) => `Saved: ${t.created || 0} new, ${t.updated || 0} changed${t.newSuppliers ? ` (${t.newSuppliers} new supplier(s) created)` : ''}.`}
    />
  );
}
