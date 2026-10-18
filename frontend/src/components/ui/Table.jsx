export function Table({ children }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-brand-100/70 bg-white shadow-[0_1px_2px_rgba(90,20,70,0.04),0_8px_24px_-12px_rgba(90,20,70,0.12)]">
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }) {
  return <thead className="bg-gradient-to-r from-brand-50 to-gold-100/40">{children}</thead>;
}

export function Th({ children, className = '' }) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-brand-900/70 ${className}`}
    >
      {children}
    </th>
  );
}

export function TBody({ children }) {
  return <tbody className="divide-y divide-brand-50 bg-white [&>tr:hover]:bg-brand-50/40">{children}</tbody>;
}

export function Td({ children, className = '' }) {
  return <td className={`px-4 py-3 align-middle text-slate-700 ${className}`}>{children}</td>;
}

export function TableEmpty({ colSpan, message = 'No records found.' }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-14 text-center text-sm text-slate-400">
        {message}
      </td>
    </tr>
  );
}

export function TableLoading({ colSpan, rows = 5 }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td colSpan={colSpan} className="px-4 py-3">
            <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
          </td>
        </tr>
      ))}
    </>
  );
}
