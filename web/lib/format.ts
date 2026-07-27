/**
 * Formatting helpers. Deliberately free of any constants.json import so this
 * can be shared with client components without dragging the embargoed address
 * into the browser bundle.
 *
 * All numeric output is designed for `font-variant-numeric: tabular-nums` in a
 * monospace face — fixed decimal counts so columns align.
 */

const LOCALE = 'en-US';

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value);
}

export function formatUsd(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `$${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)}`;
}

export function formatCompactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatAmount(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Percentages that are legitimately tiny — a burn measured against a
 * billion-token supply starts in the fourth decimal place. Fixed digits so an
 * early, honest "0.0000%" stays visibly different from a figure we could not
 * read, which returns "—".
 */
export function formatPercent(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)}%`;
}

export function formatSol(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * The single conversion from on-chain basis points to the human percentage the
 * site shows. Every user-facing share figure goes through this — "bps" is a
 * unit of the fee program and of our JSON API, not something a reader should
 * have to divide by 100. 9500 -> "95%", 9550 -> "95.50%".
 *
 * Callers pass a config- or chain-derived value; nothing here hardcodes a split.
 */
export function bpsToPercent(bps: number): string {
  if (!Number.isFinite(bps)) return '—';
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

export function shortenAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** Deterministic UTC rendering — avoids a server/client hydration mismatch. */
export function formatUtc(blockTime: number | null): string {
  if (blockTime === null || !Number.isFinite(blockTime)) return '—';
  const d = new Date(blockTime * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}
