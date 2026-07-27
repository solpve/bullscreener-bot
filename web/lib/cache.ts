import 'server-only';

/**
 * Tiny in-process TTL cache with in-flight de-duplication and serve-stale.
 *
 * This sits underneath Next's ISR (`export const revalidate = 60`) rather than
 * replacing it: ISR keeps the rendered HTML fresh across requests, this keeps a
 * burst of concurrent renders (page + four API routes) from firing the same
 * getProgramAccounts five times and tripping the public RPC's rate limit.
 *
 * Serve-stale matters here specifically because the listings producer takes
 * ~12-15s on the public RPC (ten getProgramAccounts calls that must be
 * serialised). Without it, the first caller after every TTL expiry pays that
 * cost in full — measured at 14.4s on /api/v1/tokens. With it, only the very
 * first request of a process ever blocks; afterwards a stale entry is returned
 * immediately (flagged `stale: true`, which the UI renders as "refreshing")
 * while a single background refresh runs.
 *
 * Producers must never throw — they return degraded payloads instead — so this
 * has no error path to reason about beyond a defensive fallback.
 */

export interface CacheEnvelope<T> {
  data: T;
  fetchedAt: number;
  /** True when the entry is older than its TTL but was served anyway. */
  stale: boolean;
}

interface Entry<T> {
  data: T;
  fetchedAt: number;
  /** 0 until the first successful producer run has populated `data`. */
  hasData: boolean;
  inflight: Promise<T> | null;
}

const store = new Map<string, Entry<unknown>>();

/**
 * Upper bound on how long a stale entry may be served while refreshes keep
 * failing. Past this the next caller blocks on a fresh producer run rather than
 * silently serving hours-old numbers.
 */
const MAX_STALE_MS = 10 * 60_000;

function startRefresh<T>(
  key: string,
  entry: Entry<T> | undefined,
  producer: () => Promise<T>,
): Promise<T> {
  const inflight = (async () => {
    const data = await producer();
    store.set(key, {
      data,
      fetchedAt: Date.now(),
      hasData: true,
      inflight: null,
    } as Entry<unknown>);
    return data;
  })();

  const placeholder: Entry<T> = {
    data: entry?.data as T,
    fetchedAt: entry?.fetchedAt ?? 0,
    hasData: entry?.hasData ?? false,
    inflight,
  };
  store.set(key, placeholder as Entry<unknown>);

  // Never let a background refresh become an unhandled rejection, and never let
  // a failed refresh leave a permanently "in flight" entry that blocks retries.
  inflight.catch(() => {
    const current = store.get(key) as Entry<T> | undefined;
    if (current?.inflight === inflight) current.inflight = null;
  });

  return inflight;
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<CacheEnvelope<T>> {
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;

  if (entry?.hasData && now - entry.fetchedAt < ttlMs) {
    return { data: entry.data, fetchedAt: entry.fetchedAt, stale: false };
  }

  const staleButUsable =
    entry?.hasData === true && now - entry.fetchedAt < MAX_STALE_MS;

  // Expired but still usable: hand back what we have and refresh behind it.
  if (staleButUsable && entry) {
    if (!entry.inflight) startRefresh(key, entry, producer);
    return { data: entry.data, fetchedAt: entry.fetchedAt, stale: true };
  }

  // No usable value: we have to wait. Coalesce onto an existing run if one is
  // already going so a burst of cold requests still costs one producer call.
  const inflight = entry?.inflight ?? startRefresh(key, entry, producer);

  try {
    const data = await inflight;
    const settled = store.get(key) as Entry<T> | undefined;
    return {
      data,
      fetchedAt: settled?.fetchedAt || Date.now(),
      stale: false,
    };
  } catch {
    // Producers are contractually non-throwing, but if one ever does we serve
    // the last good value rather than 500-ing the page.
    if (entry?.hasData) {
      return { data: entry.data, fetchedAt: entry.fetchedAt, stale: true };
    }
    throw new Error(`cache producer failed for "${key}" with no prior value`);
  }
}
