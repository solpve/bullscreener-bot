import 'server-only';
import { ENDPOINTS, REVALIDATE_SECONDS } from './constants';

/**
 * DexScreener batch endpoint — free, keyless, one top pair per mint.
 * Its `marketCap` field is demonstrably wrong for some tokens, which is why
 * listings.ts cross-checks it against supply x price and gates on the lower of
 * the two.
 */

export interface DexPair {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  url: string | null;
}

const TIMEOUT_MS = 10_000;
/** The batch endpoint accepts up to 30 comma-separated addresses. */
const CHUNK = 30;

interface RawPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  url?: string;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * `ok` separates "the request failed" from "the request succeeded and these
 * mints have no indexed pair". Collapsing the two would make a DexScreener
 * outage indistinguishable from a page of brand-new coins.
 */
async function fetchChunk(
  mints: string[],
): Promise<{ pairs: RawPair[]; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINTS.dexscreenerBatch}${mints.join(',')}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return { pairs: [], ok: false };
    const json: unknown = await res.json();
    // The endpoint returns a bare array; older shapes nested it under `pairs`.
    if (Array.isArray(json)) return { pairs: json as RawPair[], ok: true };
    if (json && typeof json === 'object' && Array.isArray((json as { pairs?: unknown }).pairs)) {
      return { pairs: (json as { pairs: RawPair[] }).pairs, ok: true };
    }
    // Reachable shape, unreachable meaning: treat an unparseable body as a
    // failed read rather than as "no pairs exist".
    return { pairs: [], ok: false };
  } catch {
    return { pairs: [], ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the best pair per mint, keyed by mint address.
 * Missing mints simply do not appear in the map — callers render "no market".
 */
export async function fetchDexPairs(
  mints: string[],
): Promise<{ pairs: Map<string, DexPair>; missing: number; errors: string[] }> {
  const pairs = new Map<string, DexPair>();
  const errors: string[] = [];
  if (mints.length === 0) return { pairs, missing: 0, errors };

  const unique = Array.from(new Set(mints));
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    chunks.push(unique.slice(i, i + CHUNK));
  }

  const results = await Promise.all(chunks.map((chunk) => fetchChunk(chunk)));

  const failedChunks = results.filter((r) => !r.ok).length;
  if (failedChunks > 0) {
    errors.push(
      `dexscreener: ${failedChunks}/${chunks.length} batch request(s) failed — market data is incomplete`,
    );
  }

  for (const raw of results.flatMap((r) => r.pairs)) {
    const mint = raw.baseToken?.address;
    if (!mint) continue;
    const liquidityUsd = num(raw.liquidity?.usd);
    const existing = pairs.get(mint);
    // Keep the deepest pair when the endpoint returns several for one mint.
    if (existing && (existing.liquidityUsd ?? 0) >= (liquidityUsd ?? 0)) continue;
    pairs.set(mint, {
      mint,
      symbol: raw.baseToken?.symbol ?? null,
      name: raw.baseToken?.name ?? null,
      priceUsd: num(raw.priceUsd),
      marketCap: num(raw.marketCap),
      fdv: num(raw.fdv),
      liquidityUsd,
      volume24hUsd: num(raw.volume?.h24),
      url: raw.url ?? null,
    });
  }

  // A mint with no indexed pair is an absence, not a failed read — most small
  // pump.fun coins simply have none. It is reported as a count and as a
  // per-coin "no market data" criterion, NOT as an error: counting it as one
  // would leave the site permanently flagged "degraded" on a healthy day and
  // bury the failures that actually matter.
  const missing = unique.filter((m) => !pairs.has(m)).length;

  return { pairs, missing, errors };
}
