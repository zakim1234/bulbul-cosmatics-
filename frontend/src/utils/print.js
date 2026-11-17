// Prints the current page at a given page size. @page rules can't be scoped
// by a CSS selector, so we inject one just before printing and remove it
// right after -- other prints on the page stay unaffected.
export function printPage(size = 'A5', margin = '8mm') {
  const style = document.createElement('style');
  style.id = 'dynamic-print-style';
  // Top/bottom page margin 0: the browser then has no room to print the page
  // link and date; the same space is padding on the content instead.
  style.textContent = `@page { size: ${size}; margin: 0 ${margin}; } body { padding: ${margin} 0 !important; }`;
  document.head.appendChild(style);

  const cleanup = () => {
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  window.print();
}
