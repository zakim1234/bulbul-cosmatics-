// Prints the current page using an A5 page size. @page rules can't be
// scoped by a CSS selector, so we inject one just before printing and
// remove it right after — regular (report) prints stay unaffected.
export function printA5() {
  const style = document.createElement('style');
  style.id = 'a5-print-style';
  // Top/bottom margin 0: no room for the browser's page link and date.
  style.textContent = '@page { size: A5; margin: 0 8mm; } body { padding: 8mm 0 !important; }';
  document.head.appendChild(style);

  const cleanup = () => {
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  window.print();
}
