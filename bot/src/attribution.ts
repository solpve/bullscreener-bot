import fs from 'node:fs';
import path from 'node:path';
import { utils } from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { CURSOR_PATH, REPO_ROOT, ensureStateDir, type KeeperConfig } from './config.js';
import { fetchMarketCapUsd } from './dexscreener.js';
import type { Ledger } from './ledger.js';
import { nowIso } from './ledger.js';
import { log } from './logger.js';
import { sleep, withRetry } from './rpc.js';
import type { CrankEvent, InflowEvent, RebateAccrualEvent } from './types.js';

/**
 * Attribution + rebate accounting.
 *
 * Two sources of truth, in order of preference:
 *  1. our own crank submitted the distribute -> we know the mint directly;
 *  2. someone else cranked -> parse `DistributeCreatorFeesEvent` out of the
 *     transaction that credited the BULL wallet.
 *
 * Anything we cannot prove is recorded with sourceMint = null. We never guess.
 */

const PUMP_IDL_PATH = path.join(REPO_ROOT, 'idl', 'pump.json');

/** Anchor's `emit_cpi!` tag that prefixes event data in a self-CPI. */
export const EVENT_IX_TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);

let cachedDiscriminator: Buffer | null = null;

/** DistributeCreatorFeesEvent discriminator, read from the vendored IDL. */
export function distributeEventDiscriminator(idlPath = PUMP_IDL_PATH): Buffer {
  if (cachedDiscriminator !== null) return cachedDiscriminator;
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8')) as {
    events?: { name: string; discriminator: number[] }[];
  };
  const ev = idl.events?.find((e) => e.name === 'DistributeCreatorFeesEvent');
  if (!ev) throw new Error(`DistributeCreatorFeesEvent missing from ${idlPath}`);
  cachedDiscriminator = Buffer.from(ev.discriminator);
  return cachedDiscriminator;
}

export interface DistributeInfo {
  mint: PublicKey;
  bondingCurve: PublicKey;
  sharingConfig: PublicKey;
  admin: PublicKey;
  shareholders: { address: PublicKey; shareBps: number }[];
  distributedLamports: bigint;
  quoteMint: PublicKey;
}

/**
 * Hand-rolled borsh decode of DistributeCreatorFeesEvent (layout from
 * idl/pump.json): i64 timestamp, pubkey mint, pubkey bonding_curve,
 * pubkey sharing_config, pubkey admin, vec<Shareholder>, u64 distributed,
 * pubkey quote_mint. `payload` must NOT include the 8-byte discriminator.
 */
export function decodeDistributeEventPayload(payload: Buffer): DistributeInfo {
  let o = 0;
  const pubkey = (): PublicKey => {
    const k = new PublicKey(payload.subarray(o, o + 32));
    o += 32;
    return k;
  };
  if (payload.length < 8 + 32 * 4 + 4) throw new Error('distribute event payload too short');
  o += 8; // timestamp
  const mint = pubkey();
  const bondingCurve = pubkey();
  const sharingConfig = pubkey();
  const admin = pubkey();
  const vecLen = payload.readUInt32LE(o);
  o += 4;
  if (vecLen > 64) throw new Error(`implausible shareholder count ${vecLen}`);
  if (payload.length < o + vecLen * 34 + 8 + 32) throw new Error('distribute event payload truncated');
  const shareholders: { address: PublicKey; shareBps: number }[] = [];
  for (let i = 0; i < vecLen; i++) {
    const address = pubkey();
    const shareBps = payload.readUInt16LE(o);
    o += 2;
    shareholders.push({ address, shareBps });
  }
  const distributedLamports = payload.readBigUInt64LE(o);
  o += 8;
  const quoteMint = pubkey();
  return { mint, bondingCurve, sharingConfig, admin, shareholders, distributedLamports, quoteMint };
}

function tryDecode(bytes: Buffer, disc: Buffer): DistributeInfo | null {
  if (bytes.length < 8) return null;
  if (!bytes.subarray(0, 8).equals(disc)) return null;
  try {
    return decodeDistributeEventPayload(bytes.subarray(8));
  } catch {
    return null;
  }
}

/**
 * Pull every DistributeCreatorFeesEvent out of a transaction. Handles both
 * anchor emission styles: `Program data:` logs and `emit_cpi!` self-CPI inner
 * instructions.
 */
export function extractDistributeEvents(
  tx: Pick<VersionedTransactionResponse, 'meta'>,
  disc: Buffer = distributeEventDiscriminator(),
): DistributeInfo[] {
  const out: DistributeInfo[] = [];
  const seen = new Set<string>();
  const push = (info: DistributeInfo | null): void => {
    if (info === null) return;
    const key = `${info.sharingConfig.toBase58()}:${info.distributedLamports}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(info);
  };

  for (const line of tx.meta?.logMessages ?? []) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m || m[1] === undefined) continue;
    push(tryDecode(Buffer.from(m[1], 'base64'), disc));
  }

  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const data = (ix as { data?: string }).data;
      if (typeof data !== 'string' || data === '') continue;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(utils.bytes.bs58.decode(data));
      } catch {
        continue;
      }
      if (bytes.length >= 8 && bytes.subarray(0, 8).equals(EVENT_IX_TAG)) {
        push(tryDecode(bytes.subarray(8), disc));
      } else {
        push(tryDecode(bytes, disc));
      }
    }
  }

  return out;
}

export async function fetchDistributeEvents(
  connection: Connection,
  signature: string,
): Promise<{ tx: VersionedTransactionResponse | null; events: DistributeInfo[] }> {
  const tx = await withRetry('getTransaction', () =>
    connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }),
  );
  if (tx === null) return { tx: null, events: [] };
  return { tx, events: extractDistributeEvents(tx) };
}

/**
 * True when a distribution paid out raw lamports (so `distributed` is directly
 * comparable to the BULL wallet's SOL balance delta).
 *
 * Verified live: a SOL-quoted coin emits `quote_mint = 1111…1111`
 * (PublicKey.default); the WSOL mint is accepted for the same reason. Any other
 * quote mint is paid to shareholders through an SPL token account, so
 * `distributed` is denominated in THAT token — folding it into lamport
 * arithmetic would invent inflows and rebate liabilities out of nothing.
 */
export function isNativeQuote(cfg: KeeperConfig, quoteMint: PublicKey): boolean {
  return quoteMint.equals(PublicKey.default) || quoteMint.equals(cfg.wsolMint);
}

export function bpsForShareholders(
  shareholders: readonly { address: PublicKey; shareBps: number }[],
  wallet: PublicKey,
): number {
  let total = 0;
  for (const sh of shareholders) if (sh.address.equals(wallet)) total += sh.shareBps;
  return total;
}

// ---------------------------------------------------------------------------
// Rebate math (pure)
// ---------------------------------------------------------------------------

export interface RebateInput {
  /** total lamports paid to ALL shareholders by the distribution */
  distributedLamports: bigint;
  /** ops share of the protocol-enforced split, in bps (constants.split) */
  opsBps: number;
  /** bps-equivalent ops keeps above the mcap threshold (constants.split.rebate) */
  opsRetainedBps: number;
  /** coin mcap at distribution time; null = unknown => NOT eligible */
  mcapUsd: number | null;
  thresholdUsd: number;
  enabled: boolean;
}

export interface RebateResult {
  eligible: boolean;
  /** lamports ops received from this distribution */
  opsGrossLamports: bigint;
  /** lamports ops keeps */
  opsRetainedLamports: bigint;
  /** lamports ops owes back to the BULL wallet */
  rebateLamports: bigint;
}

/**
 * constants.split.rebate: for distributions attributable to a coin whose mcap is
 * at or above `coinMcapThresholdUsd`, ops keeps `opsRetainedBpsAboveThreshold`
 * bps-equivalent of the distribution and rebates the rest to BULL (95/5 -> 99/1
 * at the current constants).
 *
 * Unknown mcap is NOT eligible: we never accrue a liability we cannot evidence.
 * All arithmetic is integer lamports, floored, mirroring on-chain behaviour.
 */
export function computeRebate(input: RebateInput): RebateResult {
  const bps = BigInt(Math.max(0, Math.trunc(input.opsBps)));
  const opsGrossLamports =
    input.distributedLamports > 0n ? (input.distributedLamports * bps) / 10_000n : 0n;

  const eligible =
    input.enabled &&
    input.mcapUsd !== null &&
    Number.isFinite(input.mcapUsd) &&
    input.mcapUsd >= input.thresholdUsd &&
    opsGrossLamports > 0n;

  if (!eligible) {
    return { eligible: false, opsGrossLamports, opsRetainedLamports: opsGrossLamports, rebateLamports: 0n };
  }

  // Clamp: a retained bps above the ops share can never create a negative rebate.
  const retainedBps = BigInt(Math.min(Math.max(0, Math.trunc(input.opsRetainedBps)), Math.trunc(input.opsBps)));
  const opsRetainedLamports = (input.distributedLamports * retainedBps) / 10_000n;
  return {
    eligible: true,
    opsGrossLamports,
    opsRetainedLamports,
    rebateLamports: opsGrossLamports - opsRetainedLamports,
  };
}

/**
 * Reconstruct the full distribution total from one shareholder's slice, for the
 * case where we saw the inflow but not the event. Lossy (the on-chain split
 * floors each slice), so callers must tag the result as `derived`.
 */
export function totalFromSlice(sliceLamports: bigint, sliceBps: number): bigint {
  if (sliceBps <= 0) return 0n;
  return (sliceLamports * 10_000n) / BigInt(sliceBps);
}

// ---------------------------------------------------------------------------
// Ledger recording
// ---------------------------------------------------------------------------

export interface DistributionRecord {
  sig: string;
  mint: string;
  distributedLamports: bigint;
  distributedSource: 'event' | 'derived';
  ourBps: number;
  mcapUsd: number | null;
  ownCrank: boolean;
  dryRun: boolean;
}

/**
 * Append the `crank` + `rebate_accrual` pair for one distribution, deduped by
 * (sig, mint) so replays and overlapping scans cannot double-count.
 */
export function recordDistribution(
  ledger: Ledger,
  cfg: KeeperConfig,
  rec: DistributionRecord,
): { crank: CrankEvent | null; accrual: RebateAccrualEvent | null } {
  const existing = ledger.readAll();
  const haveCrank = existing.some(
    (e) => e.type === 'crank' && e.sig === rec.sig && e.mint === rec.mint,
  );
  const haveAccrual = existing.some(
    (e) => e.type === 'rebate_accrual' && e.sig === rec.sig && e.mint === rec.mint,
  );

  let crank: CrankEvent | null = null;
  if (!haveCrank) {
    crank = {
      type: 'crank',
      ts: nowIso(),
      mint: rec.mint,
      sig: rec.sig,
      distributedLamports: rec.distributedLamports.toString(),
      bullLamports: ((rec.distributedLamports * BigInt(Math.max(0, rec.ourBps))) / 10_000n).toString(),
      mcapUsd: rec.mcapUsd,
      ownCrank: rec.ownCrank,
      dryRun: rec.dryRun,
    };
    ledger.append(crank);
  }

  let accrual: RebateAccrualEvent | null = null;
  if (!haveAccrual) {
    const rebate = computeRebate({
      distributedLamports: rec.distributedLamports,
      opsBps: cfg.opsBps,
      opsRetainedBps: cfg.constants.split.rebate.opsRetainedBpsAboveThreshold,
      mcapUsd: rec.mcapUsd,
      thresholdUsd: cfg.constants.split.rebate.coinMcapThresholdUsd,
      enabled: cfg.constants.split.rebate.enabled,
    });
    accrual = {
      type: 'rebate_accrual',
      ts: nowIso(),
      mint: rec.mint,
      sig: rec.sig,
      distributedLamports: rec.distributedLamports.toString(),
      distributedSource: rec.distributedSource,
      mcapUsd: rec.mcapUsd,
      eligible: rebate.eligible,
      opsGrossLamports: rebate.opsGrossLamports.toString(),
      opsRetainedLamports: rebate.opsRetainedLamports.toString(),
      rebateLamports: rebate.rebateLamports.toString(),
    };
    ledger.append(accrual);
  }

  return { crank, accrual };
}

// ---------------------------------------------------------------------------
// Inflow scanning
// ---------------------------------------------------------------------------

interface Cursor {
  lastSignature?: string;
}

export function readCursor(file = CURSOR_PATH): Cursor {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Cursor;
  } catch {
    return {};
  }
}

export function writeCursor(cursor: Cursor, file = CURSOR_PATH): void {
  ensureStateDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(cursor), 'utf8');
}

/**
 * Lamport delta for `address` in a transaction (positive = credit).
 *
 * Account order in pre/postBalances is static keys, then writable lookup-table
 * keys, then readonly ones — which is exactly `keySegments().flat()`. Resolving
 * lookups can throw for a v0 message whose `loadedAddresses` meta is missing, so
 * we fall back to the static keys instead of failing the whole scan.
 */
export function lamportDelta(tx: VersionedTransactionResponse, address: PublicKey): bigint {
  let keys: PublicKey[];
  try {
    keys = tx.transaction.message
      .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined })
      .keySegments()
      .flat();
  } catch {
    keys = tx.transaction.message.staticAccountKeys ?? [];
  }
  const index = keys.findIndex((k) => k.equals(address));
  if (index < 0) return 0n;
  const pre = tx.meta?.preBalances?.[index];
  const post = tx.meta?.postBalances?.[index];
  if (pre === undefined || post === undefined) return 0n;
  return BigInt(post) - BigInt(pre);
}

/**
 * Poll the BULL wallet for new credits and attribute each one.
 *
 * Distributions we can parse produce one inflow per distribute event (sliced by
 * our bps) plus a rebate accrual; whatever is left over is recorded once as an
 * unattributed inflow. The signature cursor lives in state/ so a restart does
 * not rescan history.
 */
const SIG_PAGE_LIMIT = 1000;
const SIG_MAX_PAGES = 10;

/**
 * Every signature newer than the cursor, newest first.
 *
 * Pages backwards with `before` instead of taking a single window: one page can
 * saturate at 1000 entries, and a single-shot read would hand back only the
 * newest 1000 — advancing the cursor into that window would silently skip every
 * inflow between the cursor and the window and lose it for good.
 */
async function fetchSignaturesSinceCursor(
  connection: Connection,
  address: PublicKey,
  until: string | undefined,
): Promise<ConfirmedSignatureInfo[]> {
  if (until === undefined) {
    // Cold start: do not replay all of history, just anchor the cursor nearby.
    return withRetry('getSignaturesForAddress(bull)', () =>
      connection.getSignaturesForAddress(address, { limit: 25 }, 'confirmed'),
    );
  }
  const all: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < SIG_MAX_PAGES; page++) {
    const query = before === undefined
      ? { until, limit: SIG_PAGE_LIMIT }
      : { until, before, limit: SIG_PAGE_LIMIT };
    const batch = await withRetry('getSignaturesForAddress(bull)', () =>
      connection.getSignaturesForAddress(address, query, 'confirmed'),
    );
    all.push(...batch);
    if (batch.length < SIG_PAGE_LIMIT) return all;
    before = batch[batch.length - 1]?.signature;
    if (before === undefined) return all;
  }
  log.error(
    `inflow scan: more than ${SIG_MAX_PAGES * SIG_PAGE_LIMIT} signatures since the cursor; ` +
      'the oldest ones are outside the scan window and will not be attributed',
  );
  return all;
}

export async function scanInflows(
  connection: Connection,
  cfg: KeeperConfig,
  ledger: Ledger,
  opts: { maxTransactions?: number; delayMs?: number; cursorFile?: string } = {},
): Promise<InflowEvent[]> {
  const maxTransactions = opts.maxTransactions ?? 50;
  const delayMs = opts.delayMs ?? 150;
  const cursorFile = opts.cursorFile ?? CURSOR_PATH;
  const cursor = readCursor(cursorFile);

  const sigs = await fetchSignaturesSinceCursor(connection, cfg.bull, cursor.lastSignature);
  if (sigs.length === 0) return [];

  // Oldest first so a crash mid-scan leaves the cursor behind, never ahead.
  const ordered = [...sigs].reverse().filter((s) => s.err === null).slice(0, maxTransactions);
  const history = ledger.readAll();
  const alreadySeen = new Set(
    history.filter((e): e is InflowEvent => e.type === 'inflow').map((e) => e.sig),
  );
  const ownCrankSigs = new Set(
    history.filter((e): e is CrankEvent => e.type === 'crank' && e.ownCrank).map((e) => e.sig),
  );

  const recorded: InflowEvent[] = [];
  /** newest signature fully handled this pass — the cursor never runs ahead of it */
  let lastProcessed: string | undefined;

  for (const entry of ordered) {
    if (alreadySeen.has(entry.signature)) {
      lastProcessed = entry.signature;
      continue;
    }

    const { tx, events } = await fetchDistributeEvents(connection, entry.signature);
    if (tx === null) {
      // Stop here rather than skipping: advancing past an unreadable tx would
      // lose the inflow permanently.
      log.warn(`inflow scan: transaction ${entry.signature} not retrievable yet; will retry next pass`);
      break;
    }
    const delta = lamportDelta(tx, cfg.bull);
    if (delta <= 0n) {
      lastProcessed = entry.signature;
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }

    let attributed = 0n;
    for (const ev of events) {
      const ourBps = bpsForShareholders(ev.shareholders, cfg.bull);
      if (ourBps === 0) continue;
      if (!isNativeQuote(cfg, ev.quoteMint)) {
        // `distributed` is in the quote token, not lamports. Attributing it
        // would both invent SOL we never received and cancel out the residual
        // record for the SOL we actually did.
        log.warn(
          `inflow scan: ignoring ${ev.mint.toBase58()} distribution in ${entry.signature} — ` +
            `non-SOL quote mint ${ev.quoteMint.toBase58()}`,
        );
        continue;
      }
      const slice = (ev.distributedLamports * BigInt(ourBps)) / 10_000n;
      attributed += slice;
      const mint = ev.mint.toBase58();
      const mcapUsd = await fetchMarketCapUsd(cfg, mint).catch(() => null);
      const inflow: InflowEvent = {
        type: 'inflow',
        ts: nowIso(),
        sig: entry.signature,
        slot: entry.slot,
        lamports: slice.toString(),
        sourceMint: mint,
        attribution: ownCrankSigs.has(entry.signature) ? 'own_crank' : 'distribute_event',
      };
      ledger.append(inflow);
      recorded.push(inflow);
      recordDistribution(ledger, cfg, {
        sig: entry.signature,
        mint,
        distributedLamports: ev.distributedLamports,
        distributedSource: 'event',
        ourBps,
        mcapUsd,
        ownCrank: ownCrankSigs.has(entry.signature),
        dryRun: false,
      });
    }

    const residual = delta - attributed;
    if (residual > 0n) {
      const inflow: InflowEvent = {
        type: 'inflow',
        ts: nowIso(),
        sig: entry.signature,
        slot: entry.slot,
        lamports: residual.toString(),
        sourceMint: null,
        attribution: 'unknown',
      };
      ledger.append(inflow);
      recorded.push(inflow);
    }

    lastProcessed = entry.signature;
    if (delayMs > 0) await sleep(delayMs);
  }

  if (lastProcessed !== undefined) writeCursor({ lastSignature: lastProcessed }, cursorFile);
  if (recorded.length > 0) log.info(`inflow scan: recorded ${recorded.length} credit(s)`);
  return recorded;
}
