'use client';

import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

/**
 * The live $ANSEM price chart, embedded from DexScreener.
 *
 * Both src variants are built on the server and handed down as plain strings —
 * this component never imports lib/constants.ts, which is where the embargoed
 * deposit address lives.
 *
 * `dark` is the SSR value and the initial client state, so the first paint
 * matches the markup Next rendered and there is no hydration mismatch; the
 * effect then follows whatever theme the visitor is actually on, the same
 * `data-theme` attribute ThemeToggle writes.
 */
export default function AnsemChart({
  darkSrc,
  lightSrc,
  pairUrl,
}: {
  darkSrc: string;
  lightSrc: string;
  pairUrl: string;
}) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');

    const read = (): Theme => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'light' || attr === 'dark') return attr;
      return media.matches ? 'light' : 'dark';
    };

    const sync = () => setTheme(read());
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    media.addEventListener('change', sync);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, []);

  return (
    <figure className="chart">
      <div className="chart__frame panel panel--ticked">
        <iframe
          src={theme === 'light' ? lightSrc : darkSrc}
          title="$ANSEM price chart, live from DexScreener"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </div>
      <figcaption className="chart__cap">
        Live chart from DexScreener, drawn from the deepest $ANSEM pool on
        Solana. Third-party embed — if it does not load,{' '}
        <a
          className="link"
          href={pairUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          open the pair on DexScreener
        </a>
        .
      </figcaption>
    </figure>
  );
}
