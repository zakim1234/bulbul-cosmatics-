import { useCallback, useEffect, useState } from 'react';

const KEY = 'theme';

// Light or dark, remembered on this device. index.html applies the saved
// choice before the app loads so the page never flashes the wrong theme.
export function useTheme() {
  const [theme, setTheme] = useState(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Storage blocked (private window): the choice lasts for this visit only.
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
