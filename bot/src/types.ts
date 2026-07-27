/**
 * Shape of ../config/constants.json (the single source of truth) plus the
 * ledger event union. Nothing in here may hardcode a value that lives in
 * constants.json — these are types only.
 */

export interface ConstantsShareholder {
  /** key into `wallets` (e.g. "bull" | "ops"), not a raw address */
  wallet: string;
  bps: number;
}

export interface Constants {
  ansem: {
    mint: string;
    name: string;
    symbol: string;
    decimals: number;
    launchSupplyRaw: string;
    tokenProgram: string;
    sharingConfigPda: string;
    graduatedPumpSwapPool: string;
  };
  programs: {
    pump: string;
    pumpAmm: string;
    pumpFees: string;
    token2022: string;
    wsolMint: string;
  };
  wallets: { bull: string; ops: string; [k: string]: string };
  /**
   * The ON-CHAIN fee-sharing config every participating coin commits to: exactly
   * one shareholder, the BULL wallet at 10000 bps, admin_revoked. The ops fee is
   * NOT in here — it is not a shareholder anywhere (see `opsFee`).
   */
  split: {
    shareholders: ConstantsShareholder[];
    /** superseded + dormant; kept so the disabled rebate code stays type-safe */
    rebate: {
      enabled: boolean;
      coinMcapThresholdUsd: number;
      opsRetainedBpsAboveThreshold: number;
    };
  };
  /**
   * The disclosed operations fee. Taken by THIS keeper, not by the protocol:
   * a plain SystemProgram transfer out of the BULL wallet at the start of every
   * buyback cycle, before the swap. Never describe it as protocol-enforced.
   */
  opsFee: {
    bps: number;
    /** must equal wallets.ops */
    recipient: string;
    /** always "keeper" — anything else is a lie the code would not enforce */
    enforcement: string;
    appliedTo: string;
  };
  keeper: {
    triggerSol: number;
    reserveSol: number;
    reserveAlertSol: number;
    maxSolPerSwap: number;
    slippageBpsFallback: number;
    maxPriceImpactPct: number;
    maxRefPriceDeviationPct: number;
    priorityLevel: string;
    priorityMaxLamports: number;
    pollIntervalSec: number;
    crankIntervalSec: number;
    /**
     * optional: absent in synthetic test constants. Skip a coin's crank when
     * the program reports fewer distributable lamports than this — a crank
     * costs ~5k lamports in fees, and skipped fees simply distribute on a
     * later pass once they clear the floor.
     */
    minCrankLamports?: number;
  };
  listing: {
    minMarketCapUsd: number;
    minHolders: number;
    maxFreshWalletPct: number;
    requireAdminRevoked: boolean;
    requireStatusActive: boolean;
    excludeCashbackCoins: boolean;
    /** false since the 2026-07-28 two-tier amendment — project-tier coins carry other shareholders */
    requireSoleShareholder: boolean;
    /** listing FLOOR (the project-tier minimum). Cranking is NOT gated on this — any share that arrives gets processed. */
    minShareBpsToUs: number;
    /** optional: absent in synthetic test constants. fullBps = the flagship sole-recipient tier. */
    tiers?: { fullBps: number; partialMinBps: number };
  };
  sharingConfigLayout: {
    discriminator: number[];
    discriminatorB58: string;
    shareholder0Offset: number;
    shareholderSize: number;
    maxShareholders: number;
  };
  pool: { coinCreatorOffset: number; canonicalPoolSizeBytes: number };
  endpoints: {
    jupiterBase: string;
    jupiterQuote: string;
    jupiterSwap: string;
    dexscreenerBatch: string;
    pumpFrontendApi: string;
    defaultRpc: string;
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type CycleState =
  | 'PENDING'
  /** the disclosed ops-fee transfer has been signed + broadcast, not yet resolved */
  | 'OPS_SENT'
  | 'SWAP_SENT'
  | 'SWAP_CONFIRMED'
  | 'BURN_SENT'
  | 'DONE'
  | 'ABORTED';

interface LedgerBase {
  /** ISO-8601 UTC */
  ts: string;
}

/** SOL arriving at the BULL wallet. */
export interface InflowEvent extends LedgerBase {
  type: 'inflow';
  sig: string;
  slot: number;
  lamports: string;
  /** mint the inflow is attributable to, when we could prove it */
  sourceMint: string | null;
  /** how sourceMint was established */
  attribution: 'own_crank' | 'distribute_event' | 'unknown';
}

/** A distribute we (or someone) cranked, attributed to a mint. */
export interface CrankEvent extends LedgerBase {
  type: 'crank';
  mint: string;
  sig: string;
  /** total lamports paid out to ALL shareholders by this distribute */
  distributedLamports: string;
  /** our (BULL) slice of the above, in lamports */
  bullLamports: string;
  mcapUsd: number | null;
  /** true when this keeper submitted the tx */
  ownCrank: boolean;
  dryRun: boolean;
}

/**
 * The disclosed operations fee, moved by this keeper out of the BULL wallet
 * before the swap. One confirmed on-chain SystemProgram transfer per cycle —
 * this is the record the public claim ("visible on-chain every cycle") points at.
 */
export interface OpsFeeEvent extends LedgerBase {
  type: 'ops_fee';
  cycleId: string;
  sig: string;
  lamports: string;
  /** lamports this cycle processed; the cut is floor(processed * bps / 10000) */
  processedLamports: string;
  bps: number;
  recipient: string;
  dryRun: boolean;
}

export interface SwapEvent extends LedgerBase {
  type: 'swap';
  cycleId: string;
  sig: string;
  /** lamports actually swapped = processed - ops cut */
  inLamports: string;
  outRaw: string;
  priceImpact: number;
  dryRun: boolean;
}

export interface BurnEvent extends LedgerBase {
  type: 'burn';
  cycleId: string;
  sig: string;
  amountRaw: string;
  supplyAfter: string | null;
  dryRun: boolean;
}

export interface RebateAccrualEvent extends LedgerBase {
  type: 'rebate_accrual';
  mint: string;
  /** distribute signature this accrual derives from — also the dedupe key */
  sig: string;
  distributedLamports: string;
  distributedSource: 'event' | 'derived';
  mcapUsd: number | null;
  eligible: boolean;
  opsGrossLamports: string;
  opsRetainedLamports: string;
  rebateLamports: string;
}

export interface RebatePaidEvent extends LedgerBase {
  type: 'rebate_paid';
  sig: string;
  lamports: string;
  /** rebate_accrual sigs settled by this payment */
  settles: string[];
  dryRun: boolean;
}

/** Buyback-cycle state-machine transition. Replaying these rebuilds state. */
export interface CycleEvent extends LedgerBase {
  type: 'cycle';
  cycleId: string;
  state: CycleState;
  /**
   * Lamports this cycle processes end to end: the ops cut plus the swap amount.
   * (Historically "what we intend to swap"; since the ops cut it is the total.)
   */
  planLamports: string;
  opsSig?: string;
  opsLastValidBlockHeight?: number;
  /** floor(planLamports * opsFee.bps / 10000) */
  opsLamports?: string;
  /** planLamports - opsLamports; what actually goes into the swap */
  swapLamports?: string;
  swapSig?: string;
  swapLastValidBlockHeight?: number;
  swapOutRaw?: string;
  /** price impact (%) of the quote this cycle was sent with */
  priceImpactPct?: number;
  burnSig?: string;
  burnLastValidBlockHeight?: number;
  burnAmountRaw?: string;
  reason?: string;
  dryRun: boolean;
}

export type LedgerEvent =
  | InflowEvent
  | CrankEvent
  | OpsFeeEvent
  | SwapEvent
  | BurnEvent
  | RebateAccrualEvent
  | RebatePaidEvent
  | CycleEvent;

/** Latest known state of a buyback cycle, folded from CycleEvents. */
export interface CycleRecord {
  cycleId: string;
  state: CycleState;
  /** total lamports processed by the cycle: ops cut + swap amount */
  planLamports: bigint;
  opsSig?: string;
  opsLastValidBlockHeight?: number;
  opsLamports?: bigint;
  swapLamports?: bigint;
  swapSig?: string;
  swapLastValidBlockHeight?: number;
  swapOutRaw?: bigint;
  priceImpactPct?: number;
  burnSig?: string;
  burnLastValidBlockHeight?: number;
  burnAmountRaw?: bigint;
  reason?: string;
  updatedAt: string;
  dryRun: boolean;
}
