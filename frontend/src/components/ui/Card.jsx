export default function Card({ children, className = '', title, subtitle, actions, dense = false }) {
  return (
    <div className={`rounded-2xl border border-brand-100/70 bg-white shadow-[0_1px_2px_rgba(90,20,70,0.04),0_8px_24px_-12px_rgba(90,20,70,0.12)] ${className}`}>
      {(title || actions) && (
        <div className={`flex items-center justify-between border-b border-brand-50 ${dense ? 'px-3.5 py-2' : 'px-5 py-3.5'}`}>
          <div>
            {title && <h3 className="font-display text-[15px] font-semibold text-brand-950">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs font-normal text-slate-400">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={dense ? 'p-3.5' : 'p-5'}>{children}</div>
    </div>
  );
}
