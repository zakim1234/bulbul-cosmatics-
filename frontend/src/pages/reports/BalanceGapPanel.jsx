import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import client from '../../api/client.js';
import { formatMoney } from '../../utils/format.js';

// "Where does the difference come from?" -- read-only checks of the records
// an out-of-balance gap usually comes from, each with a link to open it.
export default function BalanceGapPanel({ onClose, date }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    client
      .get('/reports/balance-sheet/check', { params: date ? { date } : {} })
      .then((r) => setData(r.data.data))
      .catch((err) => setError(err.friendlyMessage || 'Could not check the difference.'));
  }, [date]);

  return (
    <div className="mt-3 rounded-xl border border-brand-200 bg-white p-4 text-sm no-print">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-bold text-neutral-900">
          <Search className="h-4 w-4 text-brand-600" /> Where does the difference come from?
        </p>
        <button type="button" onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      {error && <p className="text-brand-700">{error}</p>}
      {!data && !error && <p className="text-neutral-500">Checking the records…</p>}
      {data && (
        <div className="space-y-3">
          <p className="text-neutral-600">
            Difference: <b className="text-neutral-900">{formatMoney(Math.abs(data.gap))}</b>{' '}
            {data.side === 'assets' ? '(Assets are higher)' : data.side ? '(Liabilities + Equity are higher)' : ''}
          </p>
          {data.findings.map((f) => (
            <div key={f.key} className={`rounded-lg border p-3 ${f.matchesGap ? 'border-brand-400 bg-brand-50' : 'border-neutral-200'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-neutral-900">
                  {f.title}
                  {f.matchesGap && <span className="ml-2 rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">This is the difference</span>}
                </p>
                <p className="font-bold tabular-nums text-neutral-900">{formatMoney(Math.abs(f.amount))}</p>
              </div>
              <p className="mt-0.5 text-xs text-neutral-500">{f.why}</p>
              <ul className="mt-2 divide-y divide-neutral-100">
                {f.items.map((i, n) => (
                  <li key={n} className="flex items-center justify-between gap-2 py-1">
                    <Link to={i.link} className="font-medium text-brand-700 hover:underline">
                      {i.label} →
                    </Link>
                    <span className={`tabular-nums ${i.isTheGap ? "rounded bg-brand-600 px-1.5 py-0.5 text-xs font-bold text-white" : "text-neutral-700"}`}>{i.isTheGap ? `This one: ${formatMoney(Math.abs(i.amount))}` : formatMoney(Math.abs(i.amount))}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {data.roundingNote && <p className="rounded-lg bg-neutral-50 p-3 text-neutral-600">{data.roundingNote}</p>}
          {!data.findings.length && !data.roundingNote && data.side && (
            <p className="rounded-lg bg-neutral-50 p-3 text-neutral-600">
              No record checked here explains it. The difference then comes from the opening balances entered by hand (Opening balances, partners' opening capital, Opening liabilities, stock imported from Excel, customers' and suppliers' opening debt): compare them with the old books' Balance Sheet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
