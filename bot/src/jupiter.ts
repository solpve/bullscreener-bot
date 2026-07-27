import type { KeeperConfig } from './config.js';
import { log } from './logger.js';
import { fetchReferenceSolPerToken } from './dexscreener.js';

/**
 * Jupiter Swap API v1 only (api.jup.ag/swap/v1/*).
 *
 * NEVER the Ultra API: it skims 5-10 bps off every swap, which would silently
 * reduce the burn. `platformFeeBps` is never sent for the same reason.
 */

export interface JupQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string | number;
  routePlan: unknown[];
  contextSlot?: number;
  [k: string]: unknown;
}

export interface JupSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  [k: string]: unknown;
}

const TIMEOUT_MS = 20_000;

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  const key = (process.env['JUPITER_API_KEY'] ?? '').trim();
  if (key !== '') h['x-api-key'] = key;
  return h;
}

export function parsePriceImpactPct(quote: Pick<JupQuote, 'priceImpactPct'>): number {
  const raw = quote.priceImpactPct;
  const n = typeof raw === 'number' ? raw : Number(raw);
  // Jupiter returns a fraction ("0.0017" = 0.17%). Absolute value: a positive
  // impact is still a deviation we care about.
  return Number.isFinite(n) ? Math.abs(n) * 100 : Number.POSITIVE_INFINITY;
}

/** SOL paid per whole output token, implied by the quote. */
export function impliedSolPerToken(
  inLamports: bigint,
  outRaw: bigint,
  outDecimals: number,
): number | null {
  if (outRaw <= 0n || inLamports <= 0n) return null;
  const inSol = Number(inLamports) / 1e9;
  const outTokens = Number(outRaw) / 10 ** outDecimals;
  if (!Number.isFinite(inSol) || !Number.isFinite(outTokens) || outTokens === 0) return null;
  return inSol / outTokens;
}

export function deviationPct(implied: number, reference: number): number {
  if (!Number.isFinite(reference) || reference <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(implied - reference) / reference) * 100;
}

export type BreakerResult =
  | { ok: true; priceImpactPct: number; deviationPct: number; referenceSolPerToken: number; impliedSolPerToken: number; referenceSource: string }
  | { ok: false; reason: string; priceImpactPct: number; deviationPct: number | null };

/**
 * Circuit breakers, as a pure function so they are unit-testable.
 *
 * Fails CLOSED: a missing reference price aborts the swap rather than trusting
 * the router unchecked.
 */
export function evaluateBreakers(params: {
  inLamports: bigint;
  outRaw: bigint;
  outDecimals: number;
  priceImpactPct: number;
  reference: { solPerToken: number; source: string } | null;
  maxPriceImpactPct: number;
  maxRefPriceDeviationPct: number;
}): BreakerResult {
  const { inLamports, outRaw, outDecimals, priceImpactPct, reference } = params;

  if (!Number.isFinite(priceImpactPct)) {
    return { ok: false, reason: 'quote has no parseable priceImpactPct', priceImpactPct, deviationPct: null };
  }
  if (priceImpactPct > params.maxPriceImpactPct) {
    return {
      ok: false,
      reason: `price impact ${priceImpactPct.toFixed(4)}% > max ${params.maxPriceImpactPct}%`,
      priceImpactPct,
      deviationPct: null,
    };
  }

  const implied = impliedSolPerToken(inLamports, outRaw, outDecimals);
  if (implied === null) {
    return { ok: false, reason: 'quote returned a zero/invalid amount', priceImpactPct, deviationPct: null };
  }
  if (reference === null) {
    return {
      ok: false,
      reason: 'no reference price available (failing closed)',
      priceImpactPct,
      deviationPct: null,
    };
  }

  const dev = deviationPct(implied, reference.solPerToken);
  if (dev > params.maxRefPriceDeviationPct) {
    return {
      ok: false,
      reason: `implied price deviates ${dev.toFixed(2)}% from reference (max ${params.maxRefPriceDeviationPct}%)`,
      priceImpactPct,
      deviationPct: dev,
    };
  }

  return {
    ok: true,
    priceImpactPct,
    deviationPct: dev,
    referenceSolPerToken: reference.solPerToken,
    impliedSolPerToken: implied,
    referenceSource: reference.source,
  };
}

export async function getQuote(cfg: KeeperConfig, inLamports: bigint): Promise<JupQuote> {
  const url = new URL(cfg.constants.endpoints.jupiterQuote, cfg.constants.endpoints.jupiterBase);
  url.searchParams.set('inputMint', cfg.constants.programs.wsolMint);
  url.searchParams.set('outputMint', cfg.constants.ansem.mint);
  url.searchParams.set('amount', inLamports.toString());
  url.searchParams.set('swapMode', 'ExactIn');
  // Fallback slippage; the swap request turns on dynamic slippage which
  // overrides this when Jupiter can estimate something tighter.
  url.searchParams.set('slippageBps', String(cfg.constants.keeper.slippageBpsFallback));
  url.searchParams.set('restrictIntermediateTokens', 'true');

  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`jupiter quote failed: ${res.status} ${res.statusText} ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as JupQuote;
}

export async function buildSwapTransaction(
  cfg: KeeperConfig,
  quote: JupQuote,
  userPublicKey: string,
): Promise<JupSwapResponse> {
  const url = new URL(cfg.constants.endpoints.jupiterSwap, cfg.constants.endpoints.jupiterBase);
  const body = {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicSlippage: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        priorityLevel: cfg.constants.keeper.priorityLevel,
        maxLamports: cfg.constants.keeper.priorityMaxLamports,
      },
    },
    // NOTE: no platformFeeBps, no feeAccount — every lamport must reach the burn.
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`jupiter swap build failed: ${res.status} ${res.statusText} ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as JupSwapResponse;
}

export interface PreparedSwap {
  quote: JupQuote;
  inLamports: bigint;
  outRaw: bigint;
  breakers: Extract<BreakerResult, { ok: true }>;
}

/** Quote + circuit breakers. Throws (does not silently downsize) on a breach. */
export async function prepareSwap(cfg: KeeperConfig, inLamports: bigint): Promise<PreparedSwap> {
  const quote = await getQuote(cfg, inLamports);
  const outRaw = BigInt(quote.outAmount);
  const quotedIn = BigInt(quote.inAmount);
  if (quotedIn !== inLamports) {
    // ExactIn should always echo the requested amount back; if it does not, our
    // accounting would be wrong.
    throw new Error(`jupiter quote inAmount ${quotedIn} != requested ${inLamports}`);
  }
  const reference = await fetchReferenceSolPerToken(cfg, cfg.constants.ansem.mint);
  const breakers = evaluateBreakers({
    inLamports,
    outRaw,
    outDecimals: cfg.ansemDecimals,
    priceImpactPct: parsePriceImpactPct(quote),
    reference,
    maxPriceImpactPct: cfg.constants.keeper.maxPriceImpactPct,
    maxRefPriceDeviationPct: cfg.constants.keeper.maxRefPriceDeviationPct,
  });
  if (!breakers.ok) throw new SwapAbort(breakers.reason);
  log.info(
    `quote ok: ${Number(inLamports) / 1e9} SOL -> ${Number(outRaw) / 10 ** cfg.ansemDecimals} ${cfg.constants.ansem.symbol}` +
      ` (impact ${breakers.priceImpactPct.toFixed(4)}%, ref dev ${breakers.deviationPct.toFixed(2)}% via ${breakers.referenceSource})`,
  );
  return { quote, inLamports, outRaw, breakers };
}

/** Thrown when a circuit breaker trips. Not a bug — a deliberate refusal. */
export class SwapAbort extends Error {}
