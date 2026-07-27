import type { KeeperConfig } from './config.js';
import { log } from './logger.js';

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address: string; name?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

const TIMEOUT_MS = 10_000;
/** DexScreener's batch endpoint accepts at most 30 addresses per call. */
const BATCH_MAX = 30;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * One pair per mint (the deepest by USD liquidity). Returns an empty map entry
 * for mints DexScreener does not know — callers must treat null as "no data",
 * never as zero.
 */
export async function fetchTopPairs(
  cfg: KeeperConfig,
  mints: readonly string[],
): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  const unique = [...new Set(mints)];
  for (let i = 0; i < unique.length; i += BATCH_MAX) {
    const chunk = unique.slice(i, i + BATCH_MAX);
    const url = `${cfg.constants.endpoints.dexscreenerBatch}${chunk.join(',')}`;
    let pairs: DexPair[];
    try {
      pairs = (await getJson<DexPair[] | null>(url)) ?? [];
    } catch (err) {
      log.warn('dexscreener batch failed', err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const pair of pairs) {
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      const prev = out.get(mint);
      const prevLiq = prev?.liquidity?.usd ?? -1;
      const liq = pair.liquidity?.usd ?? 0;
      if (!prev || liq > prevLiq) out.set(mint, pair);
    }
  }
  return out;
}

/**
 * marketCap for a mint. RESEARCH.md flags DexScreener's `marketCap` as wrong for
 * some tokens, so we prefer `fdv` only as a fallback and return null rather than
 * guessing.
 */
export async function fetchMarketCapUsd(cfg: KeeperConfig, mint: string): Promise<number | null> {
  const pairs = await fetchTopPairs(cfg, [mint]);
  const pair = pairs.get(mint);
  if (!pair) return null;
  const mcap = pair.marketCap ?? pair.fdv;
  return typeof mcap === 'number' && Number.isFinite(mcap) && mcap > 0 ? mcap : null;
}

/** marketCap for many mints in one (or few) call(s). */
export async function fetchMarketCaps(
  cfg: KeeperConfig,
  mints: readonly string[],
): Promise<Map<string, number | null>> {
  const pairs = await fetchTopPairs(cfg, mints);
  const out = new Map<string, number | null>();
  for (const mint of mints) {
    const pair = pairs.get(mint);
    const mcap = pair?.marketCap ?? pair?.fdv;
    out.set(mint, typeof mcap === 'number' && Number.isFinite(mcap) && mcap > 0 ? mcap : null);
  }
  return out;
}

/**
 * Independent reference price in SOL per token, used as the circuit-breaker
 * anchor for Jupiter quotes.
 *
 * Preferred path: a SOL-quoted pair's `priceNative` (already SOL per token).
 * Fallback: tokenUsd / solUsd, both from DexScreener.
 * Returns null when neither is available — callers MUST fail closed.
 */
export async function fetchReferenceSolPerToken(
  cfg: KeeperConfig,
  mint: string,
): Promise<{ solPerToken: number; source: string } | null> {
  const wsol = cfg.constants.programs.wsolMint;
  let pairs: Map<string, DexPair>;
  try {
    pairs = await fetchTopPairs(cfg, [mint]);
  } catch (err) {
    log.warn('dexscreener reference lookup failed', err instanceof Error ? err.message : String(err));
    return null;
  }
  const pair = pairs.get(mint);
  if (!pair) return null;

  if (pair.quoteToken?.address === wsol && pair.priceNative) {
    const priceNative = Number(pair.priceNative);
    if (Number.isFinite(priceNative) && priceNative > 0) {
      return { solPerToken: priceNative, source: `dexscreener:${pair.dexId}:priceNative` };
    }
  }

  const tokenUsd = Number(pair.priceUsd ?? NaN);
  if (!Number.isFinite(tokenUsd) || tokenUsd <= 0) return null;

  const solPairs = await fetchTopPairs(cfg, [wsol]).catch(() => new Map<string, DexPair>());
  const solUsd = Number(solPairs.get(wsol)?.priceUsd ?? NaN);
  if (!Number.isFinite(solUsd) || solUsd <= 0) return null;

  return { solPerToken: tokenUsd / solUsd, source: 'dexscreener:usd-ratio' };
}
