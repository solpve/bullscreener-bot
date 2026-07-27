import 'server-only';
import { RPC_URL } from './constants';

/**
 * Minimal Solana JSON-RPC client tuned for a public endpoint.
 *
 * Design constraints:
 *  - The public mainnet-beta endpoint 429s aggressively, so every read is
 *    batched into as few HTTP round-trips as possible and retried with jittered
 *    backoff.
 *  - Nothing here throws. Callers get a per-call Result and degrade the UI.
 *    A screener that white-screens because an RPC hiccuped is worse than one
 *    that says "refreshing".
 */

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface RpcCall {
  method: string;
  params: unknown[];
}

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
/** Never sit on a Retry-After longer than this — a page render is waiting. */
const MAX_RETRY_AFTER_MS = 4_000;
/** Public RPC rejects oversized batches; keep well under it. */
export const MAX_BATCH_SIZE = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}

interface JsonRpcEnvelope {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Public RPCs answer 429 with a Retry-After in seconds; honour it when sane. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function postOnce(
  body: unknown,
  url: string,
): Promise<
  | { status: number; json: unknown }
  | { status: number; text: string; retryAfterMs: number | null }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Deliberately not `cache: 'no-store'`: that would opt every page out of
      // ISR and force a full re-render per request. POSTs are never entered
      // into Next's data cache anyway, and freshness is owned by lib/cache.ts.
    });
    if (!res.ok) {
      return {
        status: res.status,
        text: await res.text().catch(() => ''),
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      };
    }
    return { status: res.status, json: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends up to MAX_BATCH_SIZE calls in one HTTP request.
 * Returns one RpcResult per input call, in input order.
 */
export async function rpcBatch<T = unknown>(
  calls: RpcCall[],
  url: string = RPC_URL,
): Promise<RpcResult<T>[]> {
  if (calls.length === 0) return [];

  const payload = calls.map((call, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: call.method,
    params: call.params,
  }));

  // Some providers reject an array-shaped body outright — Helius's free tier
  // answers "Batch requests are only available for paid plans" even to a batch
  // of ONE, which silently degraded every single-call read (getBalance,
  // getTokenSupply) to "unknown". A lone call is therefore sent as a bare
  // JSON-RPC request object, which every provider accepts; the response
  // normaliser below already handles either shape.
  const body: unknown = payload.length === 1 ? payload[0] : payload;

  let lastError = 'unknown rpc failure';
  /** Set from a 429's Retry-After; overrides the exponential backoff once. */
  let nextDelayMs: number | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(nextDelayMs ?? backoffMs(attempt - 1));
    nextDelayMs = null;
    try {
      const res = await postOnce(body, url);
      if ('text' in res) {
        // Keep a slice of the body: a bare status code is not enough to tell a
        // rate limit apart from a rejected request shape when this degrades in
        // production, and these strings surface in the errors[] array.
        const detail = res.text.replace(/\s+/g, ' ').trim().slice(0, 160);
        lastError = detail
          ? `rpc http ${res.status}: ${detail}`
          : `rpc http ${res.status}`;
        // 429 / 5xx are worth another attempt; 4xx client errors are not.
        if (res.status !== 429 && res.status < 500) break;
        nextDelayMs = res.retryAfterMs;
        continue;
      }

      const raw = res.json;
      const envelopes: JsonRpcEnvelope[] = Array.isArray(raw)
        ? (raw as JsonRpcEnvelope[])
        : [raw as JsonRpcEnvelope];

      // Batch responses may come back out of order — index by id.
      const byId = new Map<number, JsonRpcEnvelope>();
      for (const env of envelopes) {
        if (env && typeof env.id === 'number') byId.set(env.id, env);
      }

      const out: RpcResult<T>[] = calls.map((call, i) => {
        // A single-call request has exactly one possible answer, so fall back to
        // matching it positionally. Providers do rewrite the id on the way back
        // — Helius's edge answers getHealth with the string "1" regardless of
        // what was sent — and an id-only lookup would turn a perfectly good
        // response into a spurious "no response" for every read.
        const env =
          byId.get(i) ?? (calls.length === 1 ? envelopes[0] : undefined);
        if (!env) return { ok: false as const, error: `${call.method}: no response` };
        if (env.error) {
          return { ok: false as const, error: `${call.method}: ${env.error.message}` };
        }
        return { ok: true as const, value: env.result as T };
      });

      // A whole-batch rate limit usually surfaces as an error on every entry.
      const allRateLimited =
        out.length > 0 &&
        out.every((r) => !r.ok && /rate|429|too many/i.test(r.error));
      if (allRateLimited && attempt < MAX_ATTEMPTS - 1) {
        lastError = out[0] && !out[0].ok ? out[0].error : 'rate limited';
        continue;
      }

      return out;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return calls.map((call) => ({
    ok: false as const,
    error: `${call.method}: ${lastError}`,
  }));
}

/** Convenience wrapper for a single call. */
export async function rpc<T = unknown>(
  method: string,
  params: unknown[],
  url?: string,
): Promise<RpcResult<T>> {
  const [result] = await rpcBatch<T>([{ method, params }], url);
  return result ?? { ok: false, error: `${method}: no response` };
}

/**
 * Splits calls into batches and runs them with bounded concurrency so we never
 * open more than `concurrency` sockets against a public endpoint at once.
 */
export async function rpcChunked<T = unknown>(
  calls: RpcCall[],
  { concurrency = 2, batchSize = MAX_BATCH_SIZE, spacingMs = 0, url }: {
    concurrency?: number;
    batchSize?: number;
    /** Idle gap between consecutive batches in a worker, to stay under per-method limits. */
    spacingMs?: number;
    url?: string;
  } = {},
): Promise<RpcResult<T>[]> {
  if (calls.length === 0) return [];

  const batches: RpcCall[][] = [];
  for (let i = 0; i < calls.length; i += batchSize) {
    batches.push(calls.slice(i, i + batchSize));
  }

  const results: RpcResult<T>[][] = new Array(batches.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    let first = true;
    for (;;) {
      const index = cursor++;
      const batch = batches[index];
      if (!batch) return;
      if (!first && spacingMs > 0) await sleep(spacingMs);
      first = false;
      results[index] = await rpcBatch<T>(batch, url);
    }
  }

  // At least one worker, always: a caller passing 0 (or a negative) would
  // otherwise spawn none, leave `results` full of holes, and get a SHORTER
  // array back than it passed in. Callers zip the output against their own
  // input by index (chunks[i] -> results[i]), so a length mismatch would not
  // fail loudly — it would silently attach one mint's data to another mint.
  const workers = Math.max(1, Math.min(concurrency, batches.length));
  await Promise.all(Array.from({ length: workers }, worker));

  // Same contract, defensively: exactly one RpcResult per input call, in input
  // order, no holes. rpcBatch never throws today; this makes that assumption
  // impossible to violate silently if it ever changes.
  const out: RpcResult<T>[] = [];
  batches.forEach((batch, i) => {
    const batchResults = results[i];
    if (batchResults && batchResults.length === batch.length) {
      out.push(...batchResults);
      return;
    }
    for (const call of batch) {
      out.push({ ok: false as const, error: `${call.method}: batch produced no result` });
    }
  });

  return out;
}

/** Base64 account data helper shared by the decoders. */
export interface RpcAccount {
  owner: string;
  lamports: number;
  data: [string, string];
  executable: boolean;
  rentEpoch?: number;
}

export function accountBytes(account: RpcAccount | null | undefined): Buffer | null {
  if (!account) return null;
  const encoded = account.data?.[0];
  if (typeof encoded !== 'string') return null;
  try {
    return Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
}
