import { Connection, type Commitment } from '@solana/web3.js';
import type { KeeperConfig } from './config.js';
import { log } from './logger.js';

export function makeConnection(cfg: KeeperConfig, commitment: Commitment = 'confirmed'): Connection {
  return new Connection(cfg.rpcUrl, { commitment, disableRetryOnRateLimit: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests|rate limit/i.test(msg);
}

/**
 * Retry wrapper for public-RPC flakiness. Retries on 429 / transient network
 * errors with exponential backoff; anything else rethrows immediately so real
 * program errors are not papered over.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 800;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = isRateLimit(err) || /fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|502|503|504/i.test(msg);
      if (!transient || attempt === attempts) break;
      const delay = base * 2 ** (attempt - 1);
      log.warn(`${label}: transient RPC failure (attempt ${attempt}/${attempts}), retrying in ${delay}ms`, msg);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
