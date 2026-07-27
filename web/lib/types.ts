export type CriterionState = 'pass' | 'fail' | 'unverified' | 'pending';

export interface Criterion {
  /** Stable machine key — safe for API consumers to switch on. */
  id: string;
  label: string;
  state: CriterionState;
  /** Human-readable observed value, e.g. "$412,900" or "no Helius key". */
  detail: string;
  /** Why this criterion exists — surfaced in /api/v1/criteria. */
  rule: string;
}

export interface Shareholder {
  address: string;
  shareBps: number;
  isUs: boolean;
}

export interface SharingConfig {
  /** PDA address of the sharing config account (seeds ['sharing-config', mint]). */
  address: string;
  mint: string;
  admin: string;
  bump: number;
  version: number;
  status: 'Active' | 'Paused' | 'Unknown';
  adminRevoked: boolean;
  shareholders: Shareholder[];
}

export interface MarketData {
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  /** Market cap as reported by DexScreener. Known to be wrong for some tokens. */
  reportedMcapUsd: number | null;
  /** supply x price, computed from the mint account. The cross-check. */
  computedMcapUsd: number | null;
  /** The conservative value actually used by the gate (min of the two). */
  mcapUsd: number | null;
  /** True when reported and computed diverge by more than 10%. */
  mcapMismatch: boolean;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  supply: number | null;
  decimals: number | null;
  pairUrl: string | null;
}

export interface TokenRow {
  mint: string;
  sharingConfig: SharingConfig;
  market: MarketData;
  holders: number | null;
  holdersVerified: boolean;
  /** BondingCurve.is_cashback_coin. null when the account could not be read. */
  isCashbackCoin: boolean | null;
  cashbackSource: 'bonding-curve' | 'pump-api' | 'unknown';
  /** bonding_curve.creator === sharing config PDA — proves the vault migration happened. */
  vaultMigrated: boolean | null;
  ourShareBps: number;
  /**
   * 'full' = the burn wallet holds all 10000 bps (the flagship tier, the only
   * one the podium crowns). 'partial' = anything less — including below-floor
   * coins, whose share criterion then reads `fail`. Listing still requires the
   * floor; tier is classification, not a verdict.
   */
  tier: 'full' | 'partial';
  criteria: Criterion[];
  /** Every required criterion passes. */
  listed: boolean;
  /**
   * No required criterion failed, but at least one could not be evaluated
   * (missing holder index / RPC failure) — so the verdict is genuinely unknown.
   * A coin with any outright `fail` is excluded regardless: a definitive
   * failure is not made uncertain by an unrelated missing measurement.
   */
  incomplete: boolean;
}

export interface ListingsResult {
  tokens: TokenRow[];
  /** Discovered sharing configs before gating — the denominator. */
  discovered: number;
  /**
   * True only when all ten shareholder-slot scans succeeded. When false, an
   * empty `tokens` list means "we could not look", not "nobody has committed" —
   * the UI must not claim absence on a failed scan.
   */
  enumerationComplete: boolean;
  holdersProvider: 'helius' | 'unavailable';
  /**
   * Discovered mints with no indexed DexScreener pair. An absence, not a
   * failure — those coins report `market_cap: unverified` per-coin. Kept out of
   * `errors` so the degraded-read signal stays meaningful.
   */
  marketDataMissing: number;
  errors: string[];
  fetchedAt: number;
  stale: boolean;
}

export interface BurnRecord {
  signature: string;
  blockTime: number | null;
  slot: number;
  /** ANSEM burned by our instructions in this tx, in UI units. */
  ansemBurned: number;
  /**
   * SOL spent on the buy attributed to this burn. Attribution pairs each burn
   * with the nearest preceding unattributed swap out of the BULL wallet.
   * null when no matching swap was found inside the scanned window.
   */
  solIn: number | null;
  solInAttributed: boolean;
  swapSignature: string | null;
}

export interface InflowRecord {
  signature: string;
  blockTime: number | null;
  slot: number;
  sol: number;
}

export interface ActivityResult {
  burns: BurnRecord[];
  inflows: InflowRecord[];
  totalSolReceived: number;
  totalAnsemBurned: number;
  burnTxCount: number;
  /**
   * True only when the signature walk AND every transaction detail fetch
   * succeeded. When false the totals are not a measurement: zero means "we
   * could not read", not "nothing has happened". The UI and the API must not
   * present a zero as fact unless this is true — this is the burn-log analogue
   * of ListingsResult.enumerationComplete.
   */
  scanComplete: boolean;
  /** The signature walk hit its cap — totals cover only the scanned window. */
  truncated: boolean;
  /** Signatures returned by the wallet's signature walk. */
  scannedSignatures: number;
  /**
   * Transactions actually fetched and decoded. Always <= scannedSignatures: the
   * detail fetch is capped independently, and the totals above are derived from
   * these, not from the signature count.
   */
  parsedTransactions: number;
  errors: string[];
}

export interface StatsResult {
  solReceived: number;
  ansemBurnedByUs: number;
  burnTxCount: number;
  listedCoins: number;
  discoveredConfigs: number;
  /** See ListingsResult.enumerationComplete — gates any "none exist" wording. */
  enumerationComplete: boolean;
  /** See ActivityResult.scanComplete — gates any "nothing burned yet" wording. */
  historyComplete: boolean;
  ansemSupply: number | null;
  ansemLaunchSupply: number;
  preExistingBurned: number;
  truncated: boolean;
  errors: string[];
  fetchedAt: number;
  stale: boolean;
}
