'use client';

import { useRef, useState } from 'react';
import { SOLSCAN } from '@/lib/links';

/**
 * The burn wallet as a coin-site CA bar: full address on one line under the
 * masthead, click anywhere on it to copy, Solscan a tap away. Callers pass
 * `null` while NEXT_PUBLIC_SHOW_ADDRESS !== "true" and the bar renders
 * nothing — the embargoed address never reaches the HTML.
 */
export default function AddressBar({ address }: { address: string | null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (address === null) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be denied; the address stays selectable by hand.
    }
  };

  return (
    <div className="addressbar">
      <div className="shell addressbar__inner">
        <span className="addressbar__label">
          <span className="addressbar__dot" aria-hidden="true" />
          burn wallet
        </span>
        <button
          type="button"
          className="addressbar__addr"
          onClick={copy}
          title="Copy address"
        >
          <span className="addressbar__value num">{address}</span>
          <span
            className={`addressbar__copy${copied ? ' addressbar__copy--done' : ''}`}
            aria-live="polite"
          >
            {copied ? 'copied' : 'copy'}
          </span>
        </button>
        <a
          className="addressbar__scan"
          href={SOLSCAN.account(address)}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`View ${address} on Solscan`}
        >
          solscan ↗
        </a>
      </div>
    </div>
  );
}
