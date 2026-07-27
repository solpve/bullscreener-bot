import 'server-only';
import {
  ANSEM,
  ANSEM_LAUNCH_SUPPLY,
  BULL_WALLET,
  PRE_EXISTING_BURNED_ANSEM,
  PROGRAMS,
  REVALIDATE_SECONDS,
} from './constants';
import { cached } from './cache';
import { rpc, rpcChunked, type RpcCall } from './rpc';
import { getListings } from './listings';
import type { ActivityResult, BurnRecord, InflowRecord, StatsResult } from './types';

/**
 * Burn + inflow history, derived by walking the BULL wallet's signatures and
 * parsing raw transactions. No database, no indexer, no trust.
 *
 * The burn counter deliberately counts only Burn/BurnChecked instructions whose
 * authority is our wallet. It is NOT the supply delta: 57,784.42 ANSEM was
 * burned by unrelated parties before this project existed, and claiming that
 * would be a lie. That baseline is disclosed separately and never added in.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;
const SIGNATURES_PER_PAGE = 1_000;
/** Hard caps so a public RPC read can never run unbounded. Surfaced as `truncated`. */
const MAX_SIGNATURE_PAGES = 3;
const MAX_TX_DETAIL = 400;

interface SignatureEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface ParsedInstruction {
  programId?: string;
  program?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
}

interface TxResponse {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[];
  } | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string } | string>;
      instructions: ParsedInstruction[];
    };
  };
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

function keyAt(keys: TxResponse['transaction']['message']['accountKeys'], i: number): string | null {
  const entry = keys[i];
  if (typeof entry === 'string') return entry;
  return entry?.pubkey ?? null;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return 0n;
}

/** Sums the ANSEM raw amount burned by OUR authority in a single transaction. */
function burnedInTx(tx: TxResponse): bigint {
  const all: ParsedInstruction[] = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []),
  ];

  let total = 0n;
  for (const ix of all) {
    if (ix.programId !== PROGRAMS.token2022) continue;
    const type = ix.parsed?.type;
    if (type !== 'burnChecked' && type !== 'burn') continue;
    const info = ix.parsed?.info;
    if (!info) continue;
    if (info.mint !== ANSEM.mint) continue;
    // Only our burns count.
    if (info.authority !== BULL_WALLET) continue;

    if (type === 'burnChecked') {
      const amount = (info.tokenAmount as { amount?: unknown } | undefined)?.amount;
      total += toBigInt(amount);
    } else {
      total += toBigInt(info.amount);
    }
  }
  return total;
}

function ansemDeltaRaw(tx: TxResponse): bigint {
  const sum = (balances: TokenBalance[] | undefined): bigint => {
    let acc = 0n;
    for (const b of balances ?? []) {
      if (b.mint !== ANSEM.mint) continue;
      if (b.owner !== BULL_WALLET) continue;
      acc += toBigInt(b.uiTokenAmount?.amount);
    }
    return acc;
  };
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

function lamportDelta(tx: TxResponse): number {
  const keys = tx.transaction.message.accountKeys ?? [];
  if (!BULL_WALLET) return 0;
  let index = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keyAt(keys, i) === BULL_WALLET) {
      index = i;
      break;
    }
  }
  if (index < 0 || !tx.meta) return 0;
  const pre = tx.meta.preBalances?.[index];
  const post = tx.meta.postBalances?.[index];
  if (typeof pre !== 'number' || typeof post !== 'number') return 0;
  return post - pre;
}

async function collectSignatures(): Promise<{
  signatures: SignatureEntry[];
  truncated: boolean;
  /** False when any page of the walk errored — an empty list is then not proof of absence. */
  ok: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const signatures: SignatureEntry[] = [];
  if (!BULL_WALLET) {
    return { signatures, truncated: false, ok: false, errors };
  }

  let before: string | undefined;
  let truncated = false;
  let ok = true;

  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const params: Record<string, unknown> = { limit: SIGNATURES_PER_PAGE };
    if (before) params.before = before;

    const result = await rpc<SignatureEntry[]>('getSignaturesForAddress', [
      BULL_WALLET,
      params,
    ]);

    if (!result.ok) {
      // Fixed string, never `result.error`: providers can echo the queried
      // pubkey back in error bodies, and errors[] reaches client HTML via the
      // status ribbon — interpolating here would puncture the address embargo.
      console.error(`stats: signature walk failed (${result.error})`);
      errors.push('rpc: signature walk failed');
      // Whatever we already have is still usable; flag it as partial.
      truncated = signatures.length > 0;
      // We did not finish looking. Zero here means "unknown", never "none".
      ok = false;
      break;
    }

    const page_ = result.value ?? [];
    signatures.push(...page_);
    if (page_.length < SIGNATURES_PER_PAGE) break;

    const last = page_[page_.length - 1];
    if (!last?.signature) break;
    before = last.signature;

    if (page === MAX_SIGNATURE_PAGES - 1) truncated = true;
  }

  return { signatures, truncated, ok, errors };
}

async function loadActivity(): Promise<ActivityResult> {
  const empty: ActivityResult = {
    burns: [],
    inflows: [],
    totalSolReceived: 0,
    totalAnsemBurned: 0,
    burnTxCount: 0,
    scanComplete: false,
    truncated: false,
    scannedSignatures: 0,
    parsedTransactions: 0,
    errors: [],
  };

  if (!BULL_WALLET) {
    return { ...empty, errors: ['constants: BULL wallet is not a valid pubkey'] };
  }

  const {
    signatures,
    truncated: sigTruncated,
    ok: sigScanOk,
    errors,
  } = await collectSignatures();

  // Newest first from the RPC. Drop failed transactions — they moved nothing.
  const successful = signatures.filter((s) => s.err === null || s.err === undefined);
  if (successful.length === 0) {
    return {
      ...empty,
      // Zero signatures is a real, honest zero ONLY if the walk actually ran.
      scanComplete: sigScanOk,
      truncated: sigTruncated,
      scannedSignatures: signatures.length,
      errors,
    };
  }

  const detailTruncated = successful.length > MAX_TX_DETAIL;
  const target = successful.slice(0, MAX_TX_DETAIL);

  const calls: RpcCall[] = target.map((s) => ({
    method: 'getTransaction',
    params: [
      s.signature,
      {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      },
    ],
  }));

  // Up to 40 batched getTransaction round-trips. The public RPC will 429 a
  // burst that size, and a 429 here silently drops burns from the totals, so
  // pace it the same way the getProgramAccounts scan is paced.
  const results = await rpcChunked<TxResponse | null>(calls, {
    batchSize: 10,
    concurrency: 2,
    spacingMs: 120,
  });

  interface Record_ {
    signature: string;
    slot: number;
    blockTime: number | null;
    solDelta: number;
    ansemDelta: bigint;
    burnedRaw: bigint;
  }

  const records: Record_[] = [];
  let failures = 0;

  results.forEach((result, i) => {
    const sig = target[i];
    if (!sig) return;
    if (!result.ok || !result.value || !result.value.meta) {
      failures++;
      return;
    }
    const tx = result.value;
    if (tx.meta?.err) return;
    records.push({
      signature: sig.signature,
      slot: tx.slot ?? sig.slot,
      blockTime: tx.blockTime ?? sig.blockTime,
      solDelta: lamportDelta(tx),
      ansemDelta: ansemDeltaRaw(tx),
      burnedRaw: burnedInTx(tx),
    });
  });

  if (failures > 0) {
    errors.push(`rpc: ${failures} transaction(s) could not be fetched`);
  }

  // Walk oldest -> newest so each burn can be paired with the buy that fed it.
  records.reverse();

  const burns: BurnRecord[] = [];
  const inflows: InflowRecord[] = [];
  const pendingSwaps: { signature: string; sol: number }[] = [];
  let totalSolReceivedLamports = 0;
  let totalBurnedRaw = 0n;

  for (const record of records) {
    if (record.solDelta > 0) {
      totalSolReceivedLamports += record.solDelta;
      inflows.push({
        signature: record.signature,
        blockTime: record.blockTime,
        slot: record.slot,
        sol: record.solDelta / LAMPORTS_PER_SOL,
      });
    }

    // A buy: SOL left the wallet and ANSEM arrived.
    if (record.solDelta < 0 && record.ansemDelta > 0n) {
      pendingSwaps.push({
        signature: record.signature,
        sol: -record.solDelta / LAMPORTS_PER_SOL,
      });
    }

    if (record.burnedRaw > 0n) {
      totalBurnedRaw += record.burnedRaw;
      const swap = pendingSwaps.pop() ?? null;
      burns.push({
        signature: record.signature,
        blockTime: record.blockTime,
        slot: record.slot,
        ansemBurned: Number(record.burnedRaw) / 10 ** ANSEM.decimals,
        solIn: swap?.sol ?? null,
        solInAttributed: swap !== null,
        swapSignature: swap?.signature ?? null,
      });
    }
  }

  // Present newest first.
  burns.reverse();
  inflows.reverse();

  return {
    burns,
    inflows,
    totalSolReceived: totalSolReceivedLamports / LAMPORTS_PER_SOL,
    totalAnsemBurned: Number(totalBurnedRaw) / 10 ** ANSEM.decimals,
    burnTxCount: burns.length,
    // A transaction we could not fetch may well have contained a burn, so any
    // detail failure makes the totals a strict lower bound — exactly what
    // `truncated` already means. Reporting `truncated: false` next to a
    // silently-short total was the bug: a 429 on one batch of 10 dropped up to
    // ten burns out of the sum with nothing in the payload saying so.
    truncated: sigTruncated || detailTruncated || failures > 0,
    scanComplete: sigScanOk && failures === 0,
    scannedSignatures: signatures.length,
    parsedTransactions: records.length,
    errors,
  };
}

async function loadAnsemSupply(): Promise<number | null> {
  const result = await rpc<{ value?: { uiAmountString?: string; amount?: string; decimals?: number } }>(
    'getTokenSupply',
    [ANSEM.mint],
  );
  if (!result.ok) return null;
  const value = result.value?.value;
  if (!value) return null;
  if (typeof value.uiAmountString === 'string') {
    const n = Number(value.uiAmountString);
    if (Number.isFinite(n)) return n;
  }
  if (typeof value.amount === 'string' && typeof value.decimals === 'number') {
    const n = Number(value.amount) / 10 ** value.decimals;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function getActivity(): Promise<ActivityResult & { fetchedAt: number; stale: boolean }> {
  const envelope = await cached('activity', REVALIDATE_SECONDS * 1000, loadActivity);
  return { ...envelope.data, fetchedAt: envelope.fetchedAt, stale: envelope.stale };
}

export async function getAnsemSupply(): Promise<number | null> {
  const envelope = await cached('ansem-supply', REVALIDATE_SECONDS * 1000, loadAnsemSupply);
  return envelope.data;
}

export async function getStats(): Promise<StatsResult> {
  const [activity, supply, listings] = await Promise.all([
    getActivity(),
    getAnsemSupply(),
    getListings(),
  ]);

  return {
    solReceived: activity.totalSolReceived,
    ansemBurnedByUs: activity.totalAnsemBurned,
    burnTxCount: activity.burnTxCount,
    listedCoins: listings.tokens.filter((t) => t.listed).length,
    discoveredConfigs: listings.discovered,
    enumerationComplete: listings.enumerationComplete,
    historyComplete: activity.scanComplete,
    ansemSupply: supply,
    ansemLaunchSupply: ANSEM_LAUNCH_SUPPLY,
    preExistingBurned: PRE_EXISTING_BURNED_ANSEM,
    truncated: activity.truncated,
    errors: [...activity.errors, ...listings.errors],
    fetchedAt: Math.min(activity.fetchedAt, listings.fetchedAt),
    stale: activity.stale || listings.stale,
  };
}
