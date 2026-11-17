import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Receipt } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDateTime } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { Table, THead, Th, TBody, Td, TableEmpty, TableLoading } from '../../components/ui/Table.jsx';

// Merchant VAT: what the merchant company kept out of payments made through a
// Merchant account (the account got the paid amount less it; it is a
// Merchant VAT expense). Every invoice, and the total year by year.
export default function MerchantVatPage() {
  const toast = useToast();
  const [year, setYear] = useState(null);
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    client
      .get('/reports/merchant-vat', { params: year ? { year } : {} })
      .then((res) => {
        setData(res.data.data);
        if (!year) setYear(res.data.data.year);
      })
      .catch((err) => {
        toast.error(err.friendlyMessage || 'Could not load the VAT report.');
        setData({ year, years: [], rows: [], yearVat: 0, allTimeVat: 0 });
      });
  }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageHeader title="Merchant VAT" subtitle="VAT the merchant company kept out of Merchant payments. Our account got the amount less the VAT; the VAT is a Merchant VAT expense." />

      {/* Year by year */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(data?.years || []).map((y) => (
          <button
            key={y.year}
            onClick={() => setYear(y.year)}
            className={`rounded-2xl border px-4 py-3 text-left transition ${y.year === year ? 'border-brand-400 bg-brand-50' : 'border-neutral-200 bg-white hover:border-neutral-300'}`}
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{y.year}</p>
            <p className="mt-1 text-2xl font-extrabold text-neutral-950">{formatCurrency(y.vat)}</p>
            <p className="text-xs text-neutral-500">{y.count} invoice(s) · paid {formatCurrency(y.paid)}</p>
          </button>
        ))}
        {data && data.years.length > 1 && (
          <div className="rounded-2xl bg-neutral-100 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">All years</p>
            <p className="mt-1 text-2xl font-extrabold text-neutral-950">{formatCurrency(data.allTimeVat)}</p>
          </div>
        )}
      </div>

      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-bold text-neutral-800"><Receipt className="h-4 w-4 text-brand-600" /> Invoices {year || ''}</p>
        {data && <p className="text-sm text-neutral-600">Total VAT {year}: <b className="text-neutral-950">{formatCurrency(data.yearVat)}</b></p>}
      </div>
      <Table>
        <THead>
          <tr><Th>Date</Th><Th>Invoice</Th><Th>Customer</Th><Th>Account</Th><Th>Customer sent</Th><Th>VAT %</Th><Th>VAT</Th><Th>Account got</Th></tr>
        </THead>
        <TBody>
          {data === null ? (
            <TableLoading colSpan={8} />
          ) : data.rows.length === 0 ? (
            <TableEmpty colSpan={8} message="No Merchant VAT yet." />
          ) : (
            data.rows.map((r) => (
              <tr key={r.id}>
                <Td>{formatDateTime(r.date)}</Td>
                <Td><Link to={`/receipt/${r.id}`} className="font-semibold text-brand-700 hover:underline">{r.receiptNumber}</Link>{r.status === 'DRAFT' && <span className="ml-1 rounded bg-neutral-100 px-1 text-[10px] text-neutral-500">draft</span>}</Td>
                <Td>{r.customerName}</Td>
                <Td>{r.account || '—'}</Td>
                <Td>{formatCurrency(r.customerSent)}</Td>
                <Td>{r.vatPercent}%</Td>
                <Td className="font-semibold text-amber-700">{formatCurrency(r.vat)}</Td>
                <Td>{formatCurrency(r.accountGot ?? r.paid)}</Td>
              </tr>
            ))
          )}
        </TBody>
      </Table>
    </div>
  );
}
