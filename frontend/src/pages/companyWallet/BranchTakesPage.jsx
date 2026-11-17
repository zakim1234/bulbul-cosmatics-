import { useEffect, useMemo, useState } from 'react';
import { Printer, Landmark, PiggyBank, FileText, AlertCircle } from 'lucide-react';
import client from '../../api/client.js';
import { useToast } from '../../context/ToastContext.jsx';
import { formatCurrency, formatDate } from '../../utils/format.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Button from '../../components/ui/Button.jsx';
import { PageSpinner } from '../../components/ui/Spinner.jsx';

// A read-only report, for the admins the Super Admin allows: the money taken
// out of this branch's accounts into the company wallet -- how much, from
// which account and when -- and what the branch still owes the automatic
// daily take. Nothing about the wallet itself.
export default function BranchTakesPage() {
  const toast = useToast();
  const [data, setData] = useState(null);

  useEffect(() => {
    client
      .get('/company-wallets/branch-takes')
      .then((r) => setData(r.data.data))
      .catch((err) => {
        toast.error(err.friendlyMessage || 'Could not load the report.');
        setData({ total: 0, owed: 0, rows: [], accounts: [] });
      });
  }, [toast]);

  const takes = useMemo(() => new Set((data?.rows || []).map((r) => r.batch || r.id)).size, [data]);

  if (!data) return <PageSpinner />;

  return (
    <div id="print-area" className="space-y-5">
      <PageHeader
        title="Company Wallet report"
        subtitle="Money taken out of this branch's accounts, and the account it was taken from."
        actions={
          <Button variant="secondary" className="no-print" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl surface-blue p-5 text-white">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-neutral-400">Total taken</p>
          <p className="figure mt-1.5 text-[28px] font-extrabold">{formatCurrency(data.total)}</p>
          <p className="mt-1 text-xs text-neutral-400">{takes} time{takes === 1 ? '' : 's'}</p>
        </div>
        <div className="rounded-2xl border border-neutral-200/80 bg-white p-5">
          <p className="eyebrow">Still owed</p>
          <p className={`figure mt-1.5 text-[28px] font-extrabold ${data.owed > 0 ? 'text-red-600' : 'text-neutral-950'}`}>{data.owed > 0 ? `−${formatCurrency(data.owed)}` : formatCurrency(0)}</p>
          <p className="mt-1 text-xs text-neutral-500">{data.owed > 0 ? 'Taken as soon as money comes into an account.' : 'Nothing owed.'}</p>
        </div>
        <div className="rounded-2xl border border-neutral-200/80 bg-white p-5">
          <p className="eyebrow">Daily take</p>
          <p className="figure mt-1.5 text-[28px] font-extrabold text-neutral-950">{data.daily ? formatCurrency(data.daily) : 'Off'}</p>
          <p className="mt-1 text-xs text-neutral-500">{data.daily ? 'Every day at 12:00 noon (Somalia).' : 'No automatic take.'}</p>
        </div>
      </div>

      {data.owed > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> The accounts did not hold enough. {formatCurrency(data.owed)} will be taken from the next money that comes in.
        </div>
      )}

      {data.accounts.length > 0 && (
        <section className="rounded-2xl border border-neutral-200/80 bg-white p-5">
          <h3 className="mb-3 text-[15px] font-bold text-neutral-950">By account</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.accounts.map((a) => (
              <div key={a.name} className="flex items-center justify-between rounded-xl bg-neutral-50 px-4 py-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-neutral-800">
                  <Landmark className="h-4 w-4 text-brand-600" /> {a.name}
                </span>
                <span className="figure text-sm font-bold text-neutral-950">{formatCurrency(a.total)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-neutral-200/80 bg-white">
        {data.rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center text-neutral-500">
            <PiggyBank className="h-8 w-8 text-neutral-300" />
            <p className="text-sm">Nothing has been taken from this branch&apos;s accounts.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-neutral-100 bg-neutral-50 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Statement</th>
                  {data.allBranches && <th className="px-4 py-3">Branch</th>}
                  <th className="px-4 py-3">Account taken from</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Note</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-neutral-700">
                      {formatDate(r.date)}
                      <span className="block text-[11px] text-neutral-400">{new Date(r.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-neutral-700">
                        <FileText className="h-3.5 w-3.5 text-neutral-400" /> {r.batch || '—'}
                      </span>
                    </td>
                    {data.allBranches && <td className="px-4 py-3 text-neutral-700">{r.branchName}</td>}
                    <td className="px-4 py-3 font-semibold text-neutral-900">{r.accountName}</td>
                    <td className="figure whitespace-nowrap px-4 py-3 text-right font-bold text-red-600">−{formatCurrency(r.amount)}</td>
                    <td className="px-4 py-3 text-neutral-500">{r.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-neutral-50 font-bold">
                  <td className="px-4 py-3 text-neutral-900" colSpan={data.allBranches ? 4 : 3}>Total</td>
                  <td className="figure px-4 py-3 text-right text-red-600">−{formatCurrency(data.total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
