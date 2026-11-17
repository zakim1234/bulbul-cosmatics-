import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  const footerRef = useRef(null);
  // Enter in a box (e.g. the amount paid) does what the window's main button
  // does -- the last one in its footer (Save, Pay, Confirm...). Not in a
  // note (a new line), a form (it submits itself), or when Enter was used
  // already (picking from a list).
  const enterSaves = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const t = e.target;
    if (t.tagName !== 'INPUT' || t.form || ['checkbox', 'radio', 'file', 'button', 'submit'].includes(t.type) || t.closest('[data-enter-save="off"]')) return;
    // The main button: the last coloured (primary) one -- in the footer, or
    // in the window itself when it has no footer. A plain one (Cancel...)
    // is never pressed by Enter.
    const coloured = (root) => (root ? [...root.querySelectorAll('button:not([disabled])')].filter((b) => /\bbg-primary\b|\bbg-emerald-600\b/.test(b.className)) : []);
    const inFooter = coloured(footerRef.current);
    const candidates = inFooter.length ? inFooter : coloured(e.currentTarget);
    const main = candidates[candidates.length - 1];
    if (!main) return;
    e.preventDefault();
    main.click();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  // size="full": one long page over the whole screen -- no box and no inner
  // scroll area; the page itself scrolls, header and footer stay in view.
  if (size === 'full') {
    return createPortal(
      <div data-modal className="fixed inset-0 z-50 overflow-y-auto bg-white no-print" onKeyDown={enterSaves}>
        <div className="flex min-h-full flex-col">
          <div className="sticky top-0 z-20 flex h-[57px] items-center justify-between border-b border-neutral-100 bg-white px-5">
            <h2 className="text-[17px] font-bold text-neutral-950" style={{ fontFamily: 'var(--font-display)' }}>{title}</h2>
            <button onClick={onClose} className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-4">{children}</div>
          {footer && <div ref={footerRef} className="sticky bottom-0 z-20 flex justify-end gap-2 border-t border-neutral-100 bg-white px-5 py-3">{footer}</div>}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div data-modal className="fixed inset-0 z-50 flex items-center justify-center p-4 no-print">
      <div className="absolute inset-0 bg-brand-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={`relative z-10 w-full ${widths[size]} max-h-[90vh] overflow-y-auto rounded-3xl bg-white shadow-2xl ring-1 ring-black/5`}
        onKeyDown={enterSaves}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white px-5 py-4">
          <h2 className="text-[17px] font-bold text-neutral-950" style={{ fontFamily: 'var(--font-display)' }}>{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div ref={footerRef} className="sticky bottom-0 flex justify-end gap-2 border-t border-neutral-100 bg-white px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
