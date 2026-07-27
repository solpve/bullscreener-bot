import {
  PUMP_SDK,
  ammCreatorVaultPda,
  bondingCurvePda,
  canonicalPumpPoolPdaWithQuote,
  isLegacyQuoteMint,
  quoteAta,
} from '@pump-fun/pump-sdk';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';
import { SIMULATION_PAYER, type KeeperConfig } from './config.js';
import type { DiscoveredCoin } from './discovery.js';
import { toSdkSharingConfig } from './discovery.js';
import { log } from './logger.js';
import { withRetry } from './rpc.js';
import { awaitOutcome, buildV0Tx, signAndSend, simulateForError } from './tx.js';

/**
 * Permissionless crank.
 *
 * Per coin: `transfer_creator_fees_to_pump_v2` (sweeps the PumpSwap AMM creator
 * vault into the bonding-curve creator vault) followed by
 * `distribute_creator_fees_v2` (pays every shareholder). The keeper signs ONLY
 * as fee payer — it has no authority over either instruction, which is the whole
 * trust story.
 *
 * NOTE (correction to docs/RESEARCH.md): those two instructions do NOT live on
 * the Pump Fees program. `transfer_creator_fees_to_pump_v2` is on the PumpSwap
 * AMM program and `distribute_creator_fees_v2` / `get_minimum_distributable_fee`
 * are on the Pump bonding-curve program. Only the SharingConfig *account* is
 * owned by Pump Fees (verified against idl/*.json and the live ANSEM config).
 */

const MAX_ACCOUNTS_PER_CALL = 100;

export interface CoinContext {
  coin: DiscoveredCoin;
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
  isGraduated: boolean;
  /** the AMM creator-vault ATA exists, so a sweep is worth including */
  ammVaultExists: boolean;
  bondingCurveExists: boolean;
}

export interface MinimumFee {
  minimumRequired: bigint;
  distributableFees: bigint;
  canDistribute: boolean;
}

export type CrankOutcome =
  | { status: 'skipped'; coin: DiscoveredCoin; reason: string; minimum: MinimumFee | null }
  | { status: 'dry-run'; coin: DiscoveredCoin; minimum: MinimumFee; instructionCount: number }
  | { status: 'sent'; coin: DiscoveredCoin; minimum: MinimumFee; sig: string; confirmed: boolean }
  | { status: 'error'; coin: DiscoveredCoin; reason: string; minimum: MinimumFee | null };

async function getMultipleAccounts(
  connection: Connection,
  keys: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += MAX_ACCOUNTS_PER_CALL) {
    const chunk = keys.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    const infos = await withRetry('getMultipleAccountsInfo', () =>
      connection.getMultipleAccountsInfo(chunk, 'confirmed'),
    );
    out.push(...infos);
  }
  return out;
}

/**
 * Resolve, in batched RPC calls, everything the crank needs per coin: quote
 * mint (+ its token program), whether the coin graduated, and whether the AMM
 * creator-vault ATA exists.
 */
export async function prepareCoins(
  connection: Connection,
  cfg: KeeperConfig,
  coins: readonly DiscoveredCoin[],
): Promise<CoinContext[]> {
  if (coins.length === 0) return [];

  const curveInfos = await getMultipleAccounts(
    connection,
    coins.map((c) => bondingCurvePda(c.mint)),
  );

  const drafts = coins.map((coin, i) => {
    const info = curveInfos[i] ?? null;
    let quoteMint = cfg.wsolMint;
    if (info !== null) {
      const decoded = PUMP_SDK.decodeBondingCurveNullable(info);
      if (decoded !== null && !decoded.quoteMint.equals(PublicKey.default)) {
        quoteMint = decoded.quoteMint;
      }
    }
    return { coin, quoteMint, bondingCurveExists: info !== null };
  });

  // Token program for any non-WSOL quote mint (WSOL is always classic SPL).
  const exoticQuotes = [
    ...new Set(
      drafts.filter((d) => !d.quoteMint.equals(cfg.wsolMint)).map((d) => d.quoteMint.toBase58()),
    ),
  ];
  const quoteProgramByMint = new Map<string, PublicKey>();
  if (exoticQuotes.length > 0) {
    const infos = await getMultipleAccounts(connection, exoticQuotes.map((m) => new PublicKey(m)));
    exoticQuotes.forEach((mint, i) => {
      const owner = infos[i]?.owner;
      if (owner) quoteProgramByMint.set(mint, owner);
    });
  }

  const poolKeys: PublicKey[] = [];
  const vaultKeys: PublicKey[] = [];
  for (const draft of drafts) {
    poolKeys.push(canonicalPumpPoolPdaWithQuote(draft.coin.mint, draft.quoteMint));
    const quoteTokenProgram =
      quoteProgramByMint.get(draft.quoteMint.toBase58()) ?? TOKEN_PROGRAM_ID;
    vaultKeys.push(
      quoteAta(ammCreatorVaultPda(draft.coin.address), draft.quoteMint, quoteTokenProgram),
    );
  }
  const [poolInfos, vaultInfos] = await Promise.all([
    getMultipleAccounts(connection, poolKeys),
    getMultipleAccounts(connection, vaultKeys),
  ]);

  return drafts.map((draft, i) => ({
    coin: draft.coin,
    quoteMint: draft.quoteMint,
    quoteTokenProgram: quoteProgramByMint.get(draft.quoteMint.toBase58()) ?? TOKEN_PROGRAM_ID,
    isGraduated: (poolInfos[i] ?? null) !== null,
    ammVaultExists: (vaultInfos[i] ?? null) !== null,
    bondingCurveExists: draft.bondingCurveExists,
  }));
}

async function transferIx(ctx: CoinContext, payer: PublicKey): Promise<TransactionInstruction> {
  return PUMP_SDK.transferCreatorFeesToPumpV2({
    payer,
    mint: ctx.coin.mint,
    quoteMint: ctx.quoteMint,
    quoteTokenProgram: ctx.quoteTokenProgram,
  });
}

async function distributeIx(ctx: CoinContext, payer: PublicKey): Promise<TransactionInstruction> {
  return PUMP_SDK.distributeCreatorFeesV2({
    mint: ctx.coin.mint,
    sharingConfig: toSdkSharingConfig(ctx.coin.config),
    sharingConfigAddress: ctx.coin.address,
    quoteMint: ctx.quoteMint,
    payer,
    // Legacy (native SOL / WSOL) quotes pay raw lamports out of the vault and
    // never touch an ATA, so there is nothing to initialise and no rent to pay.
    shouldInitializeAta: !isLegacyQuoteMint(ctx.quoteMint),
    quoteTokenProgram: ctx.quoteTokenProgram,
  });
}

function decodeMinimumFee(data: Buffer): MinimumFee {
  const ev = PUMP_SDK.decodeMinimumDistributableFee(data);
  return {
    minimumRequired: BigInt(ev.minimumRequired.toString()),
    distributableFees: BigInt(ev.distributableFees.toString()),
    canDistribute: Boolean(ev.canDistribute),
  };
}

/**
 * Dust precheck via simulation of `get_minimum_distributable_fee`.
 *
 * The AMM sweep is simulated first when the coin has an AMM vault, because a
 * graduated coin's fees are not visible to the bonding-curve vault until it
 * runs. If that combined simulation errors we retry without the sweep so one
 * broken AMM leg cannot hide a distributable bonding-curve balance.
 */
export async function precheck(
  connection: Connection,
  cfg: KeeperConfig,
  ctx: CoinContext,
  payer: PublicKey,
): Promise<{ minimum: MinimumFee | null; includeTransfer: boolean; error: string | null }> {
  const minFeeIx = await PUMP_SDK.getMinimumDistributableFee({
    mint: ctx.coin.mint,
    sharingConfig: toSdkSharingConfig(ctx.coin.config),
    sharingConfigAddress: ctx.coin.address,
  });

  const attempts: { includeTransfer: boolean; ixs: TransactionInstruction[] }[] = [];
  if (ctx.isGraduated && ctx.ammVaultExists) {
    attempts.push({ includeTransfer: true, ixs: [await transferIx(ctx, payer), minFeeIx] });
  }
  attempts.push({ includeTransfer: false, ixs: [minFeeIx] });

  let lastError: string | null = null;
  for (const attempt of attempts) {
    const { tx } = await buildV0Tx(connection, payer, attempt.ixs);
    const sim = await simulateForError(connection, tx);
    if (sim.err !== null) {
      lastError = sim.err;
      continue;
    }
    if (sim.returnData === null) {
      lastError = 'simulation returned no data for get_minimum_distributable_fee';
      continue;
    }
    try {
      return { minimum: decodeMinimumFee(sim.returnData), includeTransfer: attempt.includeTransfer, error: null };
    } catch (err) {
      lastError = `could not decode MinimumDistributableFeeEvent: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { minimum: null, includeTransfer: false, error: lastError };
}

/**
 * Whether a reported distributable balance is too small to be worth a crank.
 *
 * The program's own dust check (`canDistribute`) answers "may this
 * distribute?", not "is it worth a transaction?" — it happily passes with ~0
 * lamports in the vault, and each crank spends ~5k lamports of keeper float on
 * fees. Skipped fees are not forfeited: they stay in pump.fun's vaults and
 * distribute on a later pass once they clear the floor.
 */
export function belowCrankFloor(
  distributableFees: bigint,
  minCrankLamports: number | undefined,
): boolean {
  if (minCrankLamports === undefined || minCrankLamports <= 0) return false;
  return distributableFees < BigInt(minCrankLamports);
}

/**
 * Crank one coin. Returns without sending anything in DRY_RUN.
 *
 * Idempotency: both instructions are naturally idempotent — a second distribute
 * with nothing to distribute simply fails the dust check, which is why a
 * duplicate send is harmless (unlike the swap path).
 */
export async function crankCoin(
  connection: Connection,
  cfg: KeeperConfig,
  ctx: CoinContext,
  signer: Keypair | null,
): Promise<CrankOutcome> {
  const coin = ctx.coin;
  const payer = signer?.publicKey ?? SIMULATION_PAYER;

  if (!ctx.bondingCurveExists) {
    return { status: 'skipped', coin, reason: 'bonding curve account not found', minimum: null };
  }
  if (coin.config.status !== 'Active') {
    return { status: 'skipped', coin, reason: `sharing config status=${coin.config.status}`, minimum: null };
  }
  if (coin.ourBps === 0) {
    return { status: 'skipped', coin, reason: 'config routes 0 bps to the BULL wallet', minimum: null };
  }

  const pre = await precheck(connection, cfg, ctx, payer);
  if (pre.minimum === null) {
    return { status: 'error', coin, reason: pre.error ?? 'precheck failed', minimum: null };
  }
  if (!pre.minimum.canDistribute) {
    return {
      status: 'skipped',
      coin,
      reason: `below dust: ${pre.minimum.distributableFees} < ${pre.minimum.minimumRequired} lamports`,
      minimum: pre.minimum,
    };
  }
  if (belowCrankFloor(pre.minimum.distributableFees, cfg.constants.keeper.minCrankLamports)) {
    return {
      status: 'skipped',
      coin,
      reason:
        `not worth a crank: ${pre.minimum.distributableFees} distributable < ` +
        `${cfg.constants.keeper.minCrankLamports} lamport floor`,
      minimum: pre.minimum,
    };
  }

  const ixs: TransactionInstruction[] = [];
  if (pre.includeTransfer) ixs.push(await transferIx(ctx, payer));
  ixs.push(await distributeIx(ctx, payer));

  const { tx, lastValidBlockHeight } = await buildV0Tx(connection, payer, ixs);
  const sim = await simulateForError(connection, tx);
  if (sim.err !== null) {
    return { status: 'error', coin, reason: `crank simulation failed: ${sim.err}`, minimum: pre.minimum };
  }

  if (cfg.dryRun || signer === null) {
    log.info(
      `[dry-run] would crank ${coin.mint.toBase58()}: ${ixs.length} ix ` +
        `(${pre.includeTransfer ? 'amm sweep + ' : ''}distribute_creator_fees_v2), ` +
        `${pre.minimum.distributableFees} lamports distributable`,
    );
    return { status: 'dry-run', coin, minimum: pre.minimum, instructionCount: ixs.length };
  }

  const sig = await signAndSend(connection, tx, [signer]);
  const outcome = await awaitOutcome(connection, sig, lastValidBlockHeight);
  // Only a CONFIRMED crank is a distribution. "expired" means the blockhash died
  // with the signature never seen on chain — reporting it as sent would write a
  // distribution (and a rebate accrual) for lamports that never moved.
  if (outcome === 'failed' || outcome === 'expired') {
    return { status: 'error', coin, reason: `crank tx ${sig} ${outcome}`, minimum: pre.minimum };
  }
  return { status: 'sent', coin, minimum: pre.minimum, sig, confirmed: outcome === 'confirmed' };
}

/** Our share of a distribution, in lamports (floored, matching on-chain math). */
export function ourSlice(distributedLamports: bigint, ourBps: number): bigint {
  if (ourBps <= 0) return 0n;
  return (distributedLamports * BigInt(ourBps)) / 10_000n;
}
