import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Printer, ArrowLeft, XCircle } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import { printA5 } from '../../utils/printA5.js';
import { PageSpinner } from '../../components/ui/Spinner.jsx';
import Button from '../../components/ui/Button.jsx';
import DocHeader, { DocInfo, DocFooter, DOC_TH, DOC_THEAD_ROW } from '../../components/docs/DocHeader.jsx';

// The offset voucher: proof that what the customer owes and what we owe the
// supplier were set off against each other.
export default function OffsetVoucherPage() {
  const { id } = useParams();
  const toast = useToast();
  const [o, setO] = useState(null);
  const [error, setError] = useState('');
  const [showBalances, setShowBalances] = useState(false);
  const load = () => client.get(`/offsets/${id}`).then((r) => setO(r.data.data)).catch((err) => setError(err.friendlyMessage || 'Offset not found.'));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async () => {
    const reason = window.prompt(`Cancel ${o.number}? ${o.customerName} will owe ${formatCurrency(o.amount)} again and ${o.supplierName} will be owed it again.\n\nReason (optional):`);
    if (reason === null) return;
    try {
      await client.post(`/offsets/${id}/cancel`, { reason });
      toast.success(`${o.number} cancelled.`);
      load();
    } catch (err) {
      toast.error(err.friendlyMessage || 'Could not cancel it.');
    }
  };

  if (error) return <div className="rounded-lg bg-brand-50 p-4 text-sm text-brand-700">{error}</div>;
  if (!o) return <PageSpinner />;
  const cancelled = o.status === 'CANCELLED';

  return (
    <div>
      <div className="no-print mb-4 flex items-center justify-between">
        <Link to="/offsets" className="flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-700"><ArrowLeft className="h-4 w-4" /> Back to Offsets</Link>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-neutral-600"><input type="checkbox" checked={showBalances} onChange={(e) => setShowBalances(e.target.checked)} /> Show balances</label>
          <Link to={`/offsets/statement?person=${encodeURIComponent(o.customerName)}`}><Button variant="secondary">Statement</Button></Link>
          {!cancelled && <Button variant="secondary" className="!text-red-600" onClick={cancel}><XCircle className="h-4 w-4" /> Cancel offset</Button>}
          <Button onClick={printA5}><Printer className="h-4 w-4" /> Print</Button>
        </div>
      </div>
      <div id="print-area" className="mx-auto max-w-[148mm] rounded-2xl border border-neutral-200/80 bg-white p-6 text-[13px] text-neutral-900 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <DocHeader compact title={cancelled ? 'Offset Voucher · Cancelled' : 'Offset Voucher'} meta={<span className="font-semibold">{o.number}</span>} />
        {cancelled && (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-center text-xs font-semibold text-red-700">
            CANCELLED {formatDate(o.cancelledAt)}{o.cancelReason ? ` · ${o.cancelReason}` : ''} -- both amounts are owed again.
          </p>
        )}
        <DocInfo left={['Customer and supplier', o.customerName === o.supplierName ? o.customerName : `${o.customerName} / ${o.supplierName}`]} right={['Date', formatDate(o.date), `By ${o.createdByName || '—'}`]} />
        <p className="mt-4 text-[12px] text-neutral-600">
          What {o.customerName} owes us and what we owe {o.supplierName} were set off against each other. No money changed hands.
        </p>
        {!showBalances ? (
          <div className="mt-5 rounded-xl border-2 border-neutral-900 px-4 py-5 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-neutral-500">Amount set off</p>
            <p className="mt-1 text-4xl font-extrabold tabular-nums text-neutral-950">{formatCurrency(o.amount)}</p>
          </div>
        ) : (
        <table className="mt-3 w-full">
          <thead>
            <tr className={DOC_THEAD_ROW}>
              <th className={`${DOC_TH} text-left`}></th>
              <th className={`${DOC_TH} text-right`}>Before</th>
              <th className={`${DOC_TH} text-right`}>Set off</th>
              <th className={`${DOC_TH} text-right`}>After</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-neutral-200">
              <td className="px-2 py-2"><b>{o.customerName}</b> owes us<span className="block text-[11px] text-neutral-500">Receipt {o.customerReceipt}</span></td>
              <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(o.customerBefore)}</td>
              <td className="px-2 py-2 text-right tabular-nums">−{formatCurrency(o.amount)}</td>
              <td className="px-2 py-2 text-right font-bold tabular-nums">{formatCurrency(o.customerAfter)}</td>
            </tr>
            <tr className="border-b border-neutral-200">
              <td className="px-2 py-2">We owe <b>{o.supplierName}</b><span className="block text-[11px] text-neutral-500">Payment {o.supplierReceipt}</span></td>
              <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(o.supplierBefore)}</td>
              <td className="px-2 py-2 text-right tabular-nums">−{formatCurrency(o.amount)}</td>
              <td className="px-2 py-2 text-right font-bold tabular-nums">{formatCurrency(o.supplierAfter)}</td>
            </tr>
          </tbody>
        </table>
        )}
        {showBalances && (
        <div className="ml-auto mt-4 flex max-w-xs justify-between surface-blue px-3 py-2 text-sm font-bold text-white" style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
          <span>Amount set off</span>
          <span className="tabular-nums">{formatCurrency(o.amount)}</span>
        </div>
        )}
        {o.note && <p className="mt-3 text-[12px] text-neutral-600">Note: {o.note}</p>}
        <div className="mt-10 grid grid-cols-2 gap-10 text-center text-[11px] text-neutral-500">
          <div className="border-t border-neutral-400 pt-1">Customer / supplier signature</div>
          <div className="border-t border-neutral-400 pt-1">Signed for the business</div>
        </div>
        <DocFooter>{o.number}</DocFooter>
      </div>
    </div>
  );
}
