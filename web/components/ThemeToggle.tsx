'use client';

import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

/**
 * Writes `data-theme` on <html>, which wins over prefers-color-scheme in both
 * directions. The initial value is applied by the blocking script in layout.tsx
 * so there is no flash; this component only mirrors and mutates it.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') {
      setTheme(attr);
      return;
    }
    setTheme(
      window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
    );
  }, []);

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem('bullscreener-theme', next);
    } catch {
      // Private mode / storage disabled — the choice just will not persist.
    }
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label="Toggle colour theme"
    >
      {/* Render a stable placeholder until the client knows the real theme. */}
      <span aria-hidden="true">{theme === 'light' ? 'LIGHT' : 'DARK'}</span>
    </button>
  );
}
