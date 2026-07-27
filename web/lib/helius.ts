import 'server-only';
import { HELIUS_API_KEY, PROGRAMS } from './constants';

/**
 * Holder counts via Helius `getProgramAccountsV2` — 1 credit per page, 50x
 * cheaper than DAS getTokenAccounts. The public mainnet-beta RPC cannot do this
 * (getTokenLargestAccounts 429s and only returns the top 20), so without a key
 * the holders criterion renders "unverified". We never estimate it.
 */

const TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 10_000;
/** Safety valve: 100k token accounts is far beyond any coin we would list. */
const MAX_PAGES = 10;

export const HOLDERS_AVAILABLE = HELIUS_API_KEY !== null;

interface V2Response {
  result?: {
    accounts?: Array<{ pubkey?: string; account?: { data?: [string, string] } }>;
    paginationKey?: string | null;
  };
  error?: { message?: string };
}

async function post(body: unknown): Promise<V2Response | null> {
  if (!HELIUS_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        // See lib/rpc.ts — no-store here would force every page to be dynamic.
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as V2Response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Counts token accounts with a non-zero balance for one mint.
 * `dataSlice {offset:32,length:40}` returns owner + amount only, so a page of
 * 10k accounts is ~400 KB rather than ~1.6 MB.
 *
 * The `dataSize: 165` filter is exact, and that is only the right size for the
 * classic SPL Token program. A Token-2022 account carries an account-type byte
 * plus extension TLVs the moment it has any extension at all (an ATA with
 * immutableOwner is 170 bytes), so the same filter would quietly skip most of
 * its holders. Rather than report a number we know is low, we report nothing.
 */
async function countHolders(
  mint: string,
  tokenProgram: string,
): Promise<number | null> {
  if (tokenProgram === PROGRAMS.token2022) return null;

  let paginationKey: string | null | undefined = undefined;
  let holders = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, unknown> = {
      encoding: 'base64',
      dataSlice: { offset: 32, length: 40 },
      limit: PAGE_LIMIT,
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
    };
    if (paginationKey) params.paginationKey = paginationKey;

    const json: V2Response | null = await post({
      jsonrpc: '2.0',
      id: 'holders',
      method: 'getProgramAccountsV2',
      params: [tokenProgram, params],
    });

    if (!json || json.error || !json.result?.accounts) return null;

    for (const acct of json.result.accounts) {
      const encoded = acct.account?.data?.[0];
      if (typeof encoded !== 'string') continue;
      const buf = Buffer.from(encoded, 'base64');
      // Slice is [owner(32) | amount(8)] — amount is the last 8 bytes.
      if (buf.length < 40) continue;
      if (buf.readBigUInt64LE(32) > 0n) holders++;
    }

    paginationKey = json.result.paginationKey;
    if (!paginationKey) return holders;
  }

  // Hit the page cap — the real count is higher, but we would rather report
  // "unverified" than a number we know is wrong.
  return null;
}

export interface HolderLookup {
  mint: string;
  tokenProgram: string;
}

export async function fetchHolderCounts(
  lookups: HolderLookup[],
): Promise<{ counts: Map<string, number>; errors: string[] }> {
  const counts = new Map<string, number>();
  const errors: string[] = [];

  // Not an error: an unconfigured holder index is a known, permanent state,
  // already reported as `holdersProvider: 'unavailable'`, as the ribbon's
  // "Holders: unverified — no index key", and per-coin as an unverified
  // criterion. Repeating it in errors[] would mark every healthy render
  // "degraded" and make that signal worthless when something really breaks.
  if (!HELIUS_API_KEY) return { counts, errors };

  // Sequential on purpose: each call can page 10x and we are on a free tier.
  for (const { mint, tokenProgram } of lookups) {
    if (tokenProgram === PROGRAMS.token2022) {
      errors.push(
        `helius: ${mint} is a Token-2022 mint — its token accounts are not a fixed 165 bytes, so the holder filter would undercount. Reported as unverified.`,
      );
      continue;
    }
    const count = await countHolders(mint, tokenProgram);
    if (count === null) {
      errors.push(`helius: holder count unavailable for ${mint}`);
      continue;
    }
    counts.set(mint, count);
  }

  return { counts, errors };
}
