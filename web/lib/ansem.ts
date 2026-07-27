import 'server-only';
import { ANSEM, BULL_WALLET, KEEPER, REVALIDATE_SECONDS } from './constants';
import { cached } from './cache';
import { rpc } from './rpc';
import { fetchDexPairs } from './dexscreener';

/**
 * $ANSEM's own market data, plus how full the burn engine currently is.
 *
 * EMBARGO — read this before adding an export. `getBuybackProgress` reads the
 * BULL deposit wallet's balance server-side and returns *scalars only*: a SOL
 * figure, a fraction, and pre-written error strings. The address itself must
 * never be returned, embedded in an error message, or passed into a prop.
 * `server-only` makes importing this from a client component a build error, and
 * every export below is deliberately a number, a threshold, or a fixed string.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * The canonical $ANSEM pair: the PumpSwap pool the coin graduated into. Checked
 * 2026-07-27 against all 30 DexScreener-indexed pairs for the mint — it is the
 * deepest Solana market by a clear margin (~$1.89M liquidity against ~$1.72M
 * for the runner-up), so it is both the honest reference price and the pair a
 * reader would open anyway.
 *
 * Sourced from config/constants.json rather than re-typed: that file is the
 * single source of truth for every address shared by bot/ and web/.
 */
export const ANSEM_PAIR_ADDRESS = ANSEM.graduatedPumpSwapPool;

/** Public DexScreener page for the pair — the embed's caption and fallback. */
export const ANSEM_PAIR_URL = `https://dexscreener.com/solana/${ANSEM_PAIR_ADDRESS}`;

/**
 * DexScreener's embeddable chart. `trades=0&info=0` strips its own panels so
 * the frame carries the price series and nothing else; `theme` is resolved by
 * the caller so the embed follows the site's light/dark choice.
 */
export function ansemChartEmbedUrl(theme: 'dark' | 'light'): string {
  return `${ANSEM_PAIR_URL}?embed=1&theme=${theme}&trades=0&info=0`;
}

export interface AnsemMarket {
  priceUsd: number | null;
  /**
   * DexScreener's own market-cap figure. Known to be wrong for some tokens,
   * which is why the UI cross-checks it against supply x price and shows the
   * lower of the two — the same discipline listings.ts applies to every coin.
   */
  reportedMcapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** Non-empty when the read degraded. A null above then means unknown, not zero. */
  errors: string[];
}

async function loadAnsemMarket(): Promise<AnsemMarket> {
  const { pairs, errors } = await fetchDexPairs([ANSEM.mint]);
  const pair = pairs.get(ANSEM.mint) ?? null;

  return {
    priceUsd: pair?.priceUsd ?? null,
    // fdv is the fallback only because ANSEM has no locked/vesting schedule —
    // for this mint the two are the same number.
    reportedMcapUsd: pair?.marketCap ?? pair?.fdv ?? null,
    liquidityUsd: pair?.liquidityUsd ?? null,
    volume24hUsd: pair?.volume24hUsd ?? null,
    errors:
      pair === null && errors.length === 0
        ? ['dexscreener: no indexed pair for $ANSEM']
        : errors,
  };
}

export async function getAnsemMarket(): Promise<AnsemMarket & { stale: boolean }> {
  const envelope = await cached(
    'ansem-market',
    REVALIDATE_SECONDS * 1000,
    loadAnsemMarket,
  );
  return { ...envelope.data, stale: envelope.stale };
}

export interface BuybackProgress {
  /** Fee-wallet balance in SOL. null when the read failed — never rendered as 0. */
  balanceSol: number | null;
  /**
   * What the keeper may actually spend: balance minus the transaction-fee
   * reserve, floored at zero. This — not the raw balance — is what the trigger
   * is measured against (bot/src/trigger.ts: fires when balance - reserve >= trigger).
   */
  deployableSol: number | null;
  triggerSol: number;
  reserveSol: number;
  /** 0..1 fill against the trigger. null when the balance is unknown. */
  fraction: number | null;
  errors: string[];
}

async function loadBullBalanceSol(): Promise<{
  balanceSol: number | null;
  errors: string[];
}> {
  if (!BULL_WALLET) {
    return {
      balanceSol: null,
      errors: ['constants: fee wallet is not a valid pubkey'],
    };
  }

  const result = await rpc<{ value?: number }>('getBalance', [
    BULL_WALLET,
    { commitment: 'confirmed' },
  ]);

  // Deliberately NOT interpolating `result.error`: RPC nodes echo the offending
  // parameter back in some error bodies, and these strings are rendered into a
  // client-visible title attribute on the status ribbon. A fixed string cannot
  // leak the address; a passthrough might.
  if (!result.ok) {
    return { balanceSol: null, errors: ['rpc: fee wallet balance read failed'] };
  }

  const lamports = result.value?.value;
  if (typeof lamports !== 'number' || !Number.isFinite(lamports)) {
    return {
      balanceSol: null,
      errors: ['rpc: fee wallet balance came back unreadable'],
    };
  }

  return { balanceSol: lamports / LAMPORTS_PER_SOL, errors: [] };
}

export async function getBuybackProgress(): Promise<
  BuybackProgress & { stale: boolean }
> {
  const envelope = await cached(
    'bull-balance',
    REVALIDATE_SECONDS * 1000,
    loadBullBalanceSol,
  );
  const { balanceSol, errors } = envelope.data;

  const triggerSol = KEEPER.triggerSol;
  const reserveSol = KEEPER.reserveSol;
  const deployableSol =
    balanceSol === null ? null : Math.max(0, balanceSol - reserveSol);
  const fraction =
    deployableSol === null || !(triggerSol > 0)
      ? null
      : Math.max(0, Math.min(1, deployableSol / triggerSol));

  return {
    balanceSol,
    deployableSol,
    triggerSol,
    reserveSol,
    fraction,
    errors,
    stale: envelope.stale,
  };
}
