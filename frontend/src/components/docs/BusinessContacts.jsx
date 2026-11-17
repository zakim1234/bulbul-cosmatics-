import { Mail, MapPin, Phone } from 'lucide-react';
import { BUSINESS } from '../../constants/business.js';

// Address, the number to call and email on one line, and -- on documents
// customers pay from -- the EVC Plus / bank accounts as small boxes below.
export default function BusinessContacts({ payments = false, className = '' }) {
  return (
    <div className={`flex flex-col items-center gap-1.5 ${className}`}>
      <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[11px] text-neutral-600">
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-3 w-3 text-neutral-400" /> {BUSINESS.addressLine}
        </span>
        <span className="inline-flex items-center gap-1 font-bold text-neutral-900">
          <Phone className="h-3 w-3 fill-emerald-600 text-emerald-600" /> {BUSINESS.phone}
        </span>
        <span className="inline-flex items-center gap-1">
          <Mail className="h-3 w-3 text-neutral-400" /> {BUSINESS.email}
        </span>
      </p>
      {payments && (
        <div className="flex flex-wrap justify-center gap-2" style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
          {BUSINESS.payments.map((p) => (
            <span key={p.label} className="inline-flex items-center overflow-hidden rounded-md border border-brand-200 text-[11px]">
              <span className="bg-brand-50 px-2 py-0.5 font-semibold uppercase tracking-wide text-emerald-700">{p.label}</span>
              <span className="px-2 py-0.5 font-bold tabular-nums text-brand-800">{p.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
