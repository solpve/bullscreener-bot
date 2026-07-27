import 'server-only';
import { NextResponse } from 'next/server';
import { OUR_WALLETS, REVALIDATE_SECONDS } from './constants';
import { SHOW_ADDRESS } from './flags';

/**
 * Public JSON API conventions: open CORS, CDN-cached for the same window as the
 * pages, and serve-stale-while-revalidating so a rate-limited upstream degrades
 * instead of erroring.
 */
export const API_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=300`,
};

export const EMBARGOED = 'embargoed:reveals-at-launch';

/**
 * The embargo has to hold on the API too, or the address leaks through
 * /api/v1/tokens the moment a config exists. Third-party shareholder addresses
 * are public chain data and pass through untouched; ours are masked until the
 * launch flag flips.
 */
export function redactAddress(address: string): string {
  if (SHOW_ADDRESS) return address;
  return OUR_WALLETS.includes(address) ? EMBARGOED : address;
}

export function apiJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: API_HEADERS });
}

export function apiOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: API_HEADERS });
}
