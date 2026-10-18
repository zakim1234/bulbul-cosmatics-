export default function StatCard({ label, value, icon: Icon, tone = 'slate', hint }) {
  const tones = {
    slate: 'from-slate-100 to-slate-200 text-slate-600',
    indigo: 'from-brand-100 to-brand-200 text-brand-700',
    emerald: 'from-emerald-50 to-emerald-100 text-emerald-600',
    amber: 'from-gold-100 to-gold-200 text-gold-600',
    rose: 'from-rose-50 to-rose-100 text-rose-600',
  };

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-brand-100/70 bg-white p-4 shadow-[0_1px_2px_rgba(90,20,70,0.04),0_8px_24px_-12px_rgba(90,20,70,0.12)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-12px_rgba(90,20,70,0.25)]">
      <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-brand-50 opacity-70 transition group-hover:scale-110" />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-brand-950">{value}</p>
          {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
        </div>
        {Icon && (
          <div className={`rounded-xl bg-gradient-to-br p-2.5 ${tones[tone]}`}>
            <Icon className="h-5 w-5" />
          </div>
        )}
      </div>
    </div>
  );
}
