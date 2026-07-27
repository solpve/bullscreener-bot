import 'server-only';
import {
  BULL_WALLET,
  ENDPOINTS,
  LISTING,
  OUR_WALLETS,
  PROGRAMS,
  REVALIDATE_SECONDS,
  SHARING_CONFIG_LAYOUT,
} from './constants';
import { cached } from './cache';
import { accountBytes, rpcBatch, rpcChunked, type RpcAccount, type RpcCall } from './rpc';
import {
  bondingCurvePda,
  decodeBondingCurve,
  decodeMint,
  decodeSharingConfig,
  rawToUi,
  type BondingCurveState,
} from './decode';
import { fetchDexPairs, type DexPair } from './dexscreener';
import { fetchHolderCounts, HOLDERS_AVAILABLE } from './helius';
import { bpsToPercent, formatCompactUsd, formatInt } from './format';
import type { Criterion, ListingsResult, MarketData, SharingConfig, TokenRow } from './types';

/**
 * The screener's core read path. Every value below is derived from chain or a
 * free public API at request time — there is no database to trust and nothing
 * an operator could quietly edit.
 *
 * Enumeration: getProgramAccounts on the Pump Fees program, filtered by the
 * SharingConfig discriminator at offset 0 AND the BULL wallet at offset
 * 80 + 34*i for each of the 10 shareholder slots. Never an unfiltered scan.
 */

const MCAP_MISMATCH_TOLERANCE = 0.1;
const GMA_CHUNK = 100;

interface ProgramAccountEntry {
  pubkey: string;
  account: RpcAccount;
}

async function enumerateSharingConfigs(): Promise<{
  configs: SharingConfig[];
  /** False when any shareholder-slot scan failed — an empty list is then not proof of absence. */
  complete: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  if (!BULL_WALLET) {
    return {
      configs: [],
      complete: false,
      errors: ['constants: BULL wallet is not a valid pubkey'],
    };
  }

  const { shareholder0Offset, shareholderSize, maxShareholders, discriminatorB58 } =
    SHARING_CONFIG_LAYOUT;

  // One getProgramAccounts per shareholder slot — a memcmp can only match a
  // fixed offset, and our wallet may sit anywhere in the vec.
  const calls: RpcCall[] = Array.from({ length: maxShareholders }, (_, i) => ({
    method: 'getProgramAccounts',
    params: [
      PROGRAMS.pumpFees,
      {
        encoding: 'base64',
        // Everything the decoder needs: header + all 10 shareholder slots.
        dataSlice: {
          offset: 0,
          length: shareholder0Offset + shareholderSize * maxShareholders,
        },
        filters: [
          { memcmp: { offset: 0, bytes: discriminatorB58 } },
          { memcmp: { offset: shareholder0Offset + shareholderSize * i, bytes: BULL_WALLET } },
        ],
      },
    ],
  }));

  // getProgramAccounts is rate-limited per-method on the public RPC far more
  // tightly than other reads — batching all ten slots into one HTTP request
  // returns 429 for every entry. One call per request, paced, is the only
  // shape that reliably completes. Measured: 10/10 succeed at 250ms spacing.
  const results = await rpcChunked<ProgramAccountEntry[]>(calls, {
    batchSize: 1,
    concurrency: 1,
    spacingMs: 250,
  });

  const byPda = new Map<string, SharingConfig>();
  const failureReasons: string[] = [];

  for (const result of results) {
    if (!result.ok) {
      failureReasons.push(result.error);
      continue;
    }
    for (const entry of result.value ?? []) {
      if (!entry?.pubkey || byPda.has(entry.pubkey)) continue;
      const data = accountBytes(entry.account);
      if (!data) continue;
      const config = decodeSharingConfig(entry.pubkey, data);
      if (config) byPda.set(entry.pubkey, config);
    }
  }

  if (failureReasons.length > 0) {
    errors.push(
      `rpc: ${failureReasons.length}/${calls.length} shareholder-slot scans failed — listing may be incomplete (${failureReasons[0]})`,
    );
  }

  return {
    configs: Array.from(byPda.values()),
    complete: failureReasons.length === 0,
    errors,
  };
}

interface MintInfo {
  supply: number;
  decimals: number;
  tokenProgram: string;
}

async function fetchMintInfo(
  mints: string[],
): Promise<{ info: Map<string, MintInfo>; errors: string[] }> {
  const info = new Map<string, MintInfo>();
  const errors: string[] = [];
  if (mints.length === 0) return { info, errors };

  const calls: RpcCall[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += GMA_CHUNK) {
    const chunk = mints.slice(i, i + GMA_CHUNK);
    chunks.push(chunk);
    calls.push({
      method: 'getMultipleAccounts',
      params: [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 82 } }],
    });
  }

  const results = await rpcChunked<{ value: (RpcAccount | null)[] }>(calls, {
    batchSize: 5,
    concurrency: 2,
  });

  results.forEach((result, index) => {
    const chunk = chunks[index];
    if (!chunk) return;
    if (!result.ok) {
      // Fixed string, never `result.error`: providers can echo request params
      // (including the embargoed wallet) into error bodies, and errors[] is
      // client-visible via the status ribbon.
      console.error(`listings: mint accounts unavailable (${result.error})`);
      errors.push('rpc: mint accounts unavailable');
      return;
    }
    result.value?.value?.forEach((account, i) => {
      const mint = chunk[i];
      if (!mint || !account) return;
      const data = accountBytes(account);
      if (!data) return;
      const decoded = decodeMint(data);
      if (!decoded) return;
      info.set(mint, {
        supply: rawToUi(decoded.supplyRaw, decoded.decimals),
        decimals: decoded.decimals,
        tokenProgram: account.owner,
      });
    });
  });

  return { info, errors };
}

async function fetchBondingCurves(
  mints: string[],
): Promise<{ curves: Map<string, BondingCurveState>; errors: string[] }> {
  const curves = new Map<string, BondingCurveState>();
  const errors: string[] = [];
  if (mints.length === 0) return { curves, errors };

  const pdaByMint = new Map<string, string>();
  for (const mint of mints) {
    const pda = bondingCurvePda(mint);
    if (pda) pdaByMint.set(mint, pda);
  }

  const mintList = Array.from(pdaByMint.keys());
  const calls: RpcCall[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < mintList.length; i += GMA_CHUNK) {
    const chunk = mintList.slice(i, i + GMA_CHUNK);
    chunks.push(chunk);
    calls.push({
      method: 'getMultipleAccounts',
      params: [
        chunk.map((m) => pdaByMint.get(m)),
        { encoding: 'base64', dataSlice: { offset: 0, length: 115 } },
      ],
    });
  }

  const results = await rpcChunked<{ value: (RpcAccount | null)[] }>(calls, {
    batchSize: 5,
    concurrency: 2,
  });

  results.forEach((result, index) => {
    const chunk = chunks[index];
    if (!chunk) return;
    if (!result.ok) {
      // Fixed string for the same embargo reason as above.
      console.error(`listings: bonding curves unavailable (${result.error})`);
      errors.push('rpc: bonding curves unavailable');
      return;
    }
    result.value?.value?.forEach((account, i) => {
      const mint = chunk[i];
      if (!mint || !account) return;
      const data = accountBytes(account);
      if (!data) return;
      const decoded = decodeBondingCurve(data);
      if (decoded) curves.set(mint, decoded);
    });
  });

  return { curves, errors };
}

/**
 * Convenience fallback only. `BondingCurve.is_cashback_coin` is the trustless
 * source; this is used when the account read fails so a transient RPC error
 * does not silently list a coin whose fees can never reach us.
 */
async function fetchCashbackFallback(mint: string): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${ENDPOINTS.pumpFrontendApi}${mint}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { is_cashback_enabled?: unknown };
    return typeof json.is_cashback_enabled === 'boolean'
      ? json.is_cashback_enabled
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DexScreener returns a literal 0 for `marketCap`/`priceUsd` on pairs it has
 * not indexed yet. Zero is never a real price, and treating it as data would
 * drag `min(reported, computed)` to 0 and silently exclude a qualifying coin,
 * so a non-positive value is absence, not a measurement.
 */
function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function buildMarketData(
  pair: DexPair | undefined,
  mintInfo: MintInfo | undefined,
): MarketData {
  const priceUsd = positive(pair?.priceUsd);
  const supply = mintInfo?.supply ?? null;
  const reportedMcapUsd = positive(pair?.marketCap);
  const computedMcapUsd =
    priceUsd !== null && supply !== null ? priceUsd * supply : null;

  let mcapUsd: number | null;
  let mcapMismatch = false;
  if (reportedMcapUsd !== null && computedMcapUsd !== null) {
    const spread =
      Math.abs(reportedMcapUsd - computedMcapUsd) /
      Math.max(reportedMcapUsd, computedMcapUsd, 1);
    mcapMismatch = spread > MCAP_MISMATCH_TOLERANCE;
    // Gate on the conservative figure — DexScreener's marketCap is unreliable.
    mcapUsd = Math.min(reportedMcapUsd, computedMcapUsd);
  } else {
    mcapUsd = reportedMcapUsd ?? computedMcapUsd;
  }

  return {
    symbol: pair?.symbol ?? null,
    name: pair?.name ?? null,
    priceUsd,
    reportedMcapUsd,
    computedMcapUsd,
    mcapUsd,
    mcapMismatch,
    liquidityUsd: pair?.liquidityUsd ?? null,
    volume24hUsd: pair?.volume24hUsd ?? null,
    supply,
    decimals: mintInfo?.decimals ?? null,
    pairUrl: pair?.url ?? null,
  };
}

function buildCriteria(input: {
  config: SharingConfig;
  market: MarketData;
  holders: number | null;
  isCashbackCoin: boolean | null;
  vaultMigrated: boolean | null;
  ourShareBps: number;
}): Criterion[] {
  const { config, market, holders, isCashbackCoin, vaultMigrated, ourShareBps } = input;

  return [
    {
      id: 'status_active',
      label: 'Config active',
      state: config.status === 'Active' ? 'pass' : config.status === 'Unknown' ? 'unverified' : 'fail',
      detail: config.status,
      rule: 'SharingConfig.status == Active',
    },
    {
      id: 'admin_revoked',
      label: 'Irreversible',
      state: config.adminRevoked ? 'pass' : 'fail',
      detail: config.adminRevoked
        ? `admin_revoked = true (v${config.version})`
        : 'admin can still rewrite shares',
      rule: 'SharingConfig.admin_revoked == true — set only by update_fee_shares_v2',
    },
    {
      id: 'share_to_burns',
      label: 'Share to burns',
      state: ourShareBps >= LISTING.minShareBpsToUs ? 'pass' : 'fail',
      // `detail` is the chip tooltip a reader sees, so it speaks percent.
      // `rule` below is the machine-readable statement of the on-chain gate and
      // stays in the program's own unit. Two tiers share one floor: the full
      // route (all 10000 bps, sole recipient by arithmetic) and the project
      // tier at >= the floor alongside the team's own shareholders.
      detail:
        ourShareBps >= LISTING.tiers.fullBps
          ? `${bpsToPercent(ourShareBps)} — full route`
          : bpsToPercent(ourShareBps),
      rule: `share_bps of the burn wallet >= ${LISTING.minShareBpsToUs} (${LISTING.tiers.fullBps} = the full-route tier)`,
    },
    {
      id: 'vault_migrated',
      label: 'Vault migrated',
      state: vaultMigrated === null ? 'unverified' : vaultMigrated ? 'pass' : 'fail',
      detail:
        vaultMigrated === null
          ? 'bonding curve unreadable'
          : vaultMigrated
            ? 'bonding_curve.creator = sharing config'
            : 'creator still points elsewhere',
      rule: 'BondingCurve.creator == the sharing config PDA',
    },
    {
      id: 'market_cap',
      label: 'Market cap',
      state:
        market.mcapUsd === null
          ? 'unverified'
          : market.mcapUsd >= LISTING.minMarketCapUsd
            ? 'pass'
            : 'fail',
      detail: market.mcapUsd === null ? 'no market data' : formatCompactUsd(market.mcapUsd),
      rule: `min(DexScreener marketCap, supply x price) >= $${formatInt(LISTING.minMarketCapUsd)}`,
    },
    {
      id: 'holders',
      label: 'Holders',
      state:
        holders === null
          ? 'unverified'
          : holders >= LISTING.minHolders
            ? 'pass'
            : 'fail',
      detail:
        holders === null
          ? HOLDERS_AVAILABLE
            ? 'lookup failed'
            : 'no holder index configured'
          : formatInt(holders),
      rule: `non-zero token accounts >= ${formatInt(LISTING.minHolders)}`,
    },
    {
      id: 'not_cashback',
      label: 'Not cashback',
      state:
        isCashbackCoin === null ? 'unverified' : isCashbackCoin ? 'fail' : 'pass',
      detail:
        isCashbackCoin === null
          ? 'flag unreadable'
          : isCashbackCoin
            ? 'cashback coin — fees route to traders'
            : 'is_cashback_coin = false',
      rule: 'BondingCurve.is_cashback_coin == false (locked at launch, never routable to us)',
    },
    {
      id: 'fresh_wallets',
      label: 'Fresh wallets',
      state: 'pending',
      detail: `<= ${LISTING.maxFreshWalletPct}% — ships in v1.1`,
      rule: `supply held by wallets born inside the scan window <= ${LISTING.maxFreshWalletPct}% (not yet enforced)`,
    },
  ];
}

async function loadListings(): Promise<Omit<ListingsResult, 'fetchedAt' | 'stale'>> {
  const errors: string[] = [];

  const {
    configs,
    complete: enumerationComplete,
    errors: enumErrors,
  } = await enumerateSharingConfigs();
  errors.push(...enumErrors);

  if (configs.length === 0) {
    return {
      tokens: [],
      discovered: 0,
      enumerationComplete,
      holdersProvider: HOLDERS_AVAILABLE ? 'helius' : 'unavailable',
      marketDataMissing: 0,
      errors,
    };
  }

  const mints = configs.map((c) => c.mint);

  const [mintResult, curveResult, dexResult] = await Promise.all([
    fetchMintInfo(mints),
    fetchBondingCurves(mints),
    fetchDexPairs(mints),
  ]);
  errors.push(...mintResult.errors, ...curveResult.errors, ...dexResult.errors);

  // Only ask the holder index about coins that could still qualify — it is the
  // most expensive lookup and a coin that already failed a trustless gate does
  // not need it.
  const holderCandidates = configs.filter((config) => {
    const info = mintResult.info.get(config.mint);
    return (
      info !== undefined &&
      config.status === 'Active' &&
      config.adminRevoked &&
      config.shareholders
        .filter((s) => s.isUs)
        .reduce((sum, s) => sum + s.shareBps, 0) >= LISTING.minShareBpsToUs
    );
  });

  const { counts, errors: holderErrors } = await fetchHolderCounts(
    holderCandidates.flatMap((config) => {
      // No guessed default: without the mint's real owning program we cannot
      // build a correct token-account filter, and a wrong filter would produce
      // a plausible-looking undercount. Absent means unverified.
      const tokenProgram = mintResult.info.get(config.mint)?.tokenProgram;
      return tokenProgram ? [{ mint: config.mint, tokenProgram }] : [];
    }),
  );
  errors.push(...holderErrors);

  // Cashback fallback, only where the trustless read came back empty.
  const cashbackFallbacks = new Map<string, boolean | null>();
  const needsFallback = configs
    .filter((c) => !curveResult.curves.has(c.mint))
    .slice(0, 20);
  await Promise.all(
    needsFallback.map(async (config) => {
      cashbackFallbacks.set(config.mint, await fetchCashbackFallback(config.mint));
    }),
  );

  const tokens: TokenRow[] = configs.map((config) => {
    const curve = curveResult.curves.get(config.mint);
    const market = buildMarketData(
      dexResult.pairs.get(config.mint),
      mintResult.info.get(config.mint),
    );

    const ourShareBps = config.shareholders
      .filter((s) => s.isUs)
      .reduce((sum, s) => sum + s.shareBps, 0);

    let isCashbackCoin: boolean | null;
    let cashbackSource: TokenRow['cashbackSource'];
    if (curve) {
      isCashbackCoin = curve.isCashbackCoin;
      cashbackSource = 'bonding-curve';
    } else if (cashbackFallbacks.has(config.mint)) {
      isCashbackCoin = cashbackFallbacks.get(config.mint) ?? null;
      cashbackSource = isCashbackCoin === null ? 'unknown' : 'pump-api';
    } else {
      isCashbackCoin = null;
      cashbackSource = 'unknown';
    }

    const vaultMigrated = curve
      ? curve.creator === config.address
      : null;

    const holders = counts.has(config.mint) ? (counts.get(config.mint) as number) : null;

    const criteria = buildCriteria({
      config,
      market,
      holders,
      isCashbackCoin,
      vaultMigrated,
      ourShareBps,
    });

    const required = criteria.filter((c) => c.state !== 'pending');
    // A definitive failure outranks a missing measurement. A coin assigning us
    // 2500 bps, or sitting at a $4k market cap, is excluded on evidence we
    // already hold — no holder count could rescue it. Before this, `incomplete`
    // was computed independently of the fails, so with no holder index
    // configured EVERY coin rendered the softer "unverified" verdict, including
    // ones that had plainly failed a trustless gate.
    const failed = required.some((c) => c.state === 'fail');

    return {
      mint: config.mint,
      sharingConfig: config,
      market,
      holders,
      holdersVerified: holders !== null,
      isCashbackCoin,
      cashbackSource,
      vaultMigrated,
      ourShareBps,
      tier: ourShareBps >= LISTING.tiers.fullBps ? ('full' as const) : ('partial' as const),
      criteria,
      listed: !failed && required.every((c) => c.state === 'pass'),
      incomplete: !failed && required.some((c) => c.state === 'unverified'),
    };
  });

  // Listed coins first, then by market cap desc.
  tokens.sort((a, b) => {
    if (a.listed !== b.listed) return a.listed ? -1 : 1;
    return (b.market.mcapUsd ?? 0) - (a.market.mcapUsd ?? 0);
  });

  return {
    tokens,
    discovered: configs.length,
    enumerationComplete,
    holdersProvider: HOLDERS_AVAILABLE ? 'helius' : 'unavailable',
    marketDataMissing: dexResult.missing,
    errors,
  };
}

export async function getListings(): Promise<ListingsResult> {
  const envelope = await cached('listings', REVALIDATE_SECONDS * 1000, loadListings);
  return { ...envelope.data, fetchedAt: envelope.fetchedAt, stale: envelope.stale };
}

/** The machine-readable gate, straight from config/constants.json. */
export function criteriaSpec() {
  return {
    minMarketCapUsd: LISTING.minMarketCapUsd,
    minHolders: LISTING.minHolders,
    maxFreshWalletPct: LISTING.maxFreshWalletPct,
    freshWalletStatus: LISTING.freshWalletStatus,
    requireAdminRevoked: LISTING.requireAdminRevoked,
    requireStatusActive: LISTING.requireStatusActive,
    excludeCashbackCoins: LISTING.excludeCashbackCoins,
    minShareBpsToUs: LISTING.minShareBpsToUs,
    /**
     * Additive sibling of minShareBpsToUs, in percent, so consumers do not have
     * to divide. The bps field stays canonical and is never removed.
     */
    minSharePercentToUs: LISTING.minShareBpsToUs / 100,
    /**
     * The two listing tiers. `full` (all 10000 bps — sole recipient by
     * arithmetic) is the flagship and the only tier the podium crowns;
     * `partial` lists from the floor up. The keeper's disclosed 5% fee applies
     * to whatever arrives, either tier.
     */
    tiers: {
      fullBps: LISTING.tiers.fullBps,
      fullPercent: LISTING.tiers.fullBps / 100,
      partialMinBps: LISTING.tiers.partialMinBps,
      partialMinPercent: LISTING.tiers.partialMinBps / 100,
    },
    ourShareholderCount: OUR_WALLETS.length,
  };
}

/**
 * Static descriptors for every criterion the screener evaluates, including the
 * one that is specified but not yet enforced. Mirrors buildCriteria() — if you
 * add a gate there, add it here.
 */
export function criteriaDefinitions() {
  const probe = buildCriteria({
    config: {
      address: '',
      mint: '',
      admin: '',
      bump: 0,
      version: 0,
      status: 'Unknown',
      adminRevoked: false,
      shareholders: [],
    },
    market: {
      symbol: null,
      name: null,
      priceUsd: null,
      reportedMcapUsd: null,
      computedMcapUsd: null,
      mcapUsd: null,
      mcapMismatch: false,
      liquidityUsd: null,
      volume24hUsd: null,
      supply: null,
      decimals: null,
      pairUrl: null,
    },
    holders: null,
    isCashbackCoin: null,
    vaultMigrated: null,
    ourShareBps: 0,
  });

  return probe.map((c) => ({
    id: c.id,
    label: c.label,
    rule: c.rule,
    enforced: c.state !== 'pending',
    /** Where the value is read from — all trustless unless noted. */
    source:
      c.id === 'market_cap'
        ? 'dexscreener + mint account'
        : c.id === 'holders'
          ? 'token account index'
          : c.id === 'fresh_wallets'
            ? 'not yet implemented'
            : 'solana account data',
  }));
}
