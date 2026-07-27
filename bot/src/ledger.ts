import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEDGER_PATH, ensureStateDir } from './config.js';
import { jsonSafe, log } from './logger.js';
import type { CycleEvent, CycleRecord, CycleState, LedgerEvent } from './types.js';

export const TERMINAL_STATES: readonly CycleState[] = ['DONE', 'ABORTED'];

/** States a brand-new cycle may be created in. */
export const INITIAL_STATES: readonly CycleState[] = [
  'PENDING',
  // Orphan sweep: tokens already sit in the ATA from an aborted/unknown cycle,
  // so the cycle starts life at "swap already done, burn owed".
  'SWAP_CONFIRMED',
];

/**
 * Legal buyback-cycle transitions.
 *
 * OPS_SENT is the disclosed operations fee: a plain SystemProgram transfer of
 * `floor(planLamports * opsFee.bps / 10000)` from the BULL wallet to the ops
 * wallet, sent BEFORE the swap and confirmed before the swap is signed. It gets
 * its own state for exactly the same reason the swap does — the signature is
 * persisted before broadcast so a crash can resolve it instead of re-sending.
 *
 * PENDING -> SWAP_SENT skips the ops stage, and is reachable only when the cut
 * floors to zero lamports (opsFee.bps = 0, or a plan too small to round up to a
 * lamport). There is nothing to transfer, so there is nothing to confirm.
 *
 * BURN_SENT -> SWAP_CONFIRMED is the burn retry edge: burning always reads the
 * FULL ATA balance, so re-burning is idempotent (a landed burn leaves 0 to
 * burn). SWAP_CONFIRMED -> DONE covers the same idempotency from the other side:
 * the ATA is already empty, so the burn this cycle owed has nothing left to do.
 *
 * There is deliberately NO SWAP_SENT -> SWAP_SENT or -> PENDING edge: re-sending
 * a swap without first resolving the stored signature would double spend. The
 * same holds for OPS_SENT: no self-edge and no way back to PENDING, because
 * re-sending the fee transfer would pay ops twice for one cycle.
 */
export const ALLOWED_TRANSITIONS: Record<CycleState, readonly CycleState[]> = {
  PENDING: ['OPS_SENT', 'SWAP_SENT', 'ABORTED'],
  OPS_SENT: ['SWAP_SENT', 'ABORTED'],
  SWAP_SENT: ['SWAP_CONFIRMED', 'ABORTED'],
  SWAP_CONFIRMED: ['BURN_SENT', 'DONE', 'ABORTED'],
  BURN_SENT: ['DONE', 'SWAP_CONFIRMED', 'ABORTED'],
  DONE: [],
  ABORTED: [],
};

export function isTerminal(state: CycleState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** `from === null` means "creating a new cycle". */
export function canTransition(from: CycleState | null, to: CycleState): boolean {
  if (from === null) return INITIAL_STATES.includes(to);
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: CycleState | null, to: CycleState) {
    super(`illegal cycle transition ${from ?? '<new>'} -> ${to}`);
  }
}

export function assertTransition(from: CycleState | null, to: CycleState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newCycleId(): string {
  return randomUUID();
}

function toBigInt(v: string | undefined): bigint | undefined {
  return v === undefined ? undefined : BigInt(v);
}

/** Fold a stream of cycle events into the latest record per cycleId. */
export function foldCycles(events: readonly LedgerEvent[]): Map<string, CycleRecord> {
  const out = new Map<string, CycleRecord>();
  for (const ev of events) {
    if (ev.type !== 'cycle') continue;
    const prev = out.get(ev.cycleId);
    const record: CycleRecord = {
      cycleId: ev.cycleId,
      state: ev.state,
      planLamports: BigInt(ev.planLamports),
      updatedAt: ev.ts,
      dryRun: ev.dryRun,
      // Merge forward: later transitions do not have to repeat earlier fields.
      opsSig: ev.opsSig ?? prev?.opsSig,
      opsLastValidBlockHeight: ev.opsLastValidBlockHeight ?? prev?.opsLastValidBlockHeight,
      opsLamports: toBigInt(ev.opsLamports) ?? prev?.opsLamports,
      swapLamports: toBigInt(ev.swapLamports) ?? prev?.swapLamports,
      swapSig: ev.swapSig ?? prev?.swapSig,
      swapLastValidBlockHeight: ev.swapLastValidBlockHeight ?? prev?.swapLastValidBlockHeight,
      swapOutRaw: toBigInt(ev.swapOutRaw) ?? prev?.swapOutRaw,
      priceImpactPct: ev.priceImpactPct ?? prev?.priceImpactPct,
      burnSig: ev.burnSig ?? prev?.burnSig,
      burnLastValidBlockHeight: ev.burnLastValidBlockHeight ?? prev?.burnLastValidBlockHeight,
      burnAmountRaw: toBigInt(ev.burnAmountRaw) ?? prev?.burnAmountRaw,
      reason: ev.reason ?? prev?.reason,
    };
    out.set(ev.cycleId, record);
  }
  return out;
}

/**
 * The one cycle that still needs work, or null.
 *
 * More than one open cycle should be impossible (we only ever create a cycle
 * when none is open); if it happens we resume the OLDEST and warn, because
 * resuming the newest would strand the older signature forever.
 */
export function openCycle(cycles: Map<string, CycleRecord>): CycleRecord | null {
  const open = [...cycles.values()].filter((c) => !isTerminal(c.state));
  if (open.length === 0) return null;
  open.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
  if (open.length > 1) {
    log.warn(`ledger has ${open.length} open cycles; resuming the oldest`, open.map((c) => c.cycleId));
  }
  return open[0] ?? null;
}

/** Append-only JSONL ledger. One writer (the keeper process) at a time. */
export class Ledger {
  readonly file: string;

  constructor(file: string = LEDGER_PATH) {
    this.file = file;
  }

  /**
   * Append one event and fsync before returning.
   *
   * The fsync is load-bearing, not paranoia: sendSwap/sendBurn persist the
   * transaction signature BEFORE broadcasting precisely so a crash cannot leave
   * an unknown signature in flight. Without the fsync the line can still be in
   * the OS page cache when the machine dies, and the restarted keeper would
   * re-quote and re-broadcast — the double-spend the state machine exists to
   * prevent. O_APPEND also keeps the write from interleaving with another
   * writer's line.
   */
  append(event: LedgerEvent): void {
    ensureStateDir(path.dirname(this.file));
    const line = `${JSON.stringify(event, jsonSafe)}\n`;
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  readAll(): LedgerEvent[] {
    if (!fs.existsSync(this.file)) return [];
    const out: LedgerEvent[] = [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        out.push(JSON.parse(trimmed) as LedgerEvent);
      } catch {
        // A torn final line can only be the last one (append-only writes).
        log.warn(`ledger line ${i + 1} is not valid JSON; skipping`);
      }
    }
    return out;
  }

  cycles(): Map<string, CycleRecord> {
    return foldCycles(this.readAll());
  }

  openCycle(): CycleRecord | null {
    return openCycle(this.cycles());
  }

  /**
   * Record a cycle transition, validating it against the state machine first.
   * `expectedFrom` is the state we believe the cycle is in (null = new cycle).
   */
  transition(
    expectedFrom: CycleState | null,
    event: Omit<CycleEvent, 'type' | 'ts'>,
  ): CycleEvent {
    assertTransition(expectedFrom, event.state);
    const full: CycleEvent = { type: 'cycle', ts: nowIso(), ...event };
    this.append(full);
    log.info(`cycle ${full.cycleId.slice(0, 8)}: ${expectedFrom ?? '<new>'} -> ${full.state}${full.reason ? ` (${full.reason})` : ''}`);
    return full;
  }

  has(predicate: (ev: LedgerEvent) => boolean): boolean {
    return this.readAll().some(predicate);
  }
}
