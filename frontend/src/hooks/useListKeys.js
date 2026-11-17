import { useCallback, useRef } from 'react';

// Arrow keys for any search box with a list of choices under it: ↓ / ↑ move
// through the list (the one you are on is highlighted), Enter picks it, Esc
// closes it (typing or ↓ opens it again). Put `onKeyDown` on the box and `listRef` on the list; every
// button in the list is a choice. Works with lists that pick on click or on
// mouse-down, without changing them.
export function useListKeys() {
  const listRef = useRef(null);
  const index = useRef(-1);

  const buttons = () => (listRef.current ? [...listRef.current.querySelectorAll('button:not([disabled])')] : []);
  const mark = (list, i) => {
    list.forEach((b, n) => {
      if (n === i) b.setAttribute('data-kb-active', 'true');
      else b.removeAttribute('data-kb-active');
    });
    list[i]?.scrollIntoView({ block: 'nearest' });
  };

  // Esc closes the list; typing or ↓ opens it again.
  const show = (on) => {
    if (listRef.current) listRef.current.style.display = on ? '' : 'none';
  };
  const shown = () => listRef.current && listRef.current.style.display !== 'none';

  const onKeyDown = useCallback((e) => {
    const list = buttons();
    if (!list.length) {
      index.current = -1;
      return;
    }
    if (e.key === 'Escape') {
      if (!shown()) return; // already closed: Esc goes on (e.g. closes the window)
      e.preventDefault();
      e.stopPropagation(); // closes only the list, not the window it is in
      index.current = -1;
      mark(list, -1);
      show(false);
      return;
    }
    if (!shown()) {
      if (e.key === 'ArrowDown' || e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') show(true);
      else return; // closed: Enter and the rest act as without a list
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const last = list.length - 1;
      const cur = Math.min(index.current, last);
      index.current = e.key === 'ArrowDown' ? (cur < last ? cur + 1 : last) : cur > 0 ? cur - 1 : 0;
      mark(list, index.current);
    } else if (e.key === 'Enter') {
      const b = list[Math.max(0, Math.min(index.current, list.length - 1))];
      if (!b) return;
      e.preventDefault();
      // Lists pick on mouse-down or on click: a mouse-down chooser cancels
      // the event, so the click is only sent when it did not.
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      if (b.dispatchEvent(down)) b.click();
      index.current = -1;
    } else if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      // Typing changes the list: start again from the top.
      index.current = -1;
      mark(list, -1);
    }
  }, []);

  return { listRef, onKeyDown };
}
