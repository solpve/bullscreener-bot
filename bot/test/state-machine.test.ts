import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  IllegalTransitionError,
  Ledger,
  assertTransition,
  canTransition,
  foldCycles,
  isTerminal,
  openCycle,
} from '../src/ledger.js';
import { PublicKey } from '@solana/web3.js';
import { advanceCycle, SignerMismatchError, splitCycleAmounts } from '../src/cycle.js';
import { loadConfig, readConstants } from '../src/config.js';
import { classifySignatureStatus } from '../src/tx.js';
import type { CycleEvent, CycleRecord, CycleState, LedgerEvent, SwapEvent } from '../src/types.js';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bullscreener-ledger-'));
  ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let clock = 0;
function cycleEvent(partial: Partial<CycleEvent> & { cycleId: string; state: CycleState }): CycleEvent {
  clock += 1;
  return {
    type: 'cycle',
    ts: new Date(1_800_000_000_000 + clock * 1000).toISOString(),
    planLamports: '5000000000',
    dryRun: false,
    ...partial,
  };
}

describe('transition table', () => {
  it('allows only the documented edges', () => {
    expect(ALLOWED_TRANSITIONS.PENDING).toEqual(['OPS_SENT', 'SWAP_SENT', 'ABORTED']);
    expect(ALLOWED_TRANSITIONS.OPS_SENT).toEqual(['SWAP_SENT', 'ABORTED']);
    expect(ALLOWED_TRANSITIONS.SWAP_SENT).toEqual(['SWAP_CONFIRMED', 'ABORTED']);
    expect(ALLOWED_TRANSITIONS.SWAP_CONFIRMED).toEqual(['BURN_SENT', 'DONE', 'ABORTED']);
    expect(ALLOWED_TRANSITIONS.BURN_SENT).toEqual(['DONE', 'SWAP_CONFIRMED', 'ABORTED']);
    expect(ALLOWED_TRANSITIONS.DONE).toEqual([]);
    expect(ALLOWED_TRANSITIONS.ABORTED).toEqual([]);
  });

  it('never allows re-entering SWAP_SENT (would double-swap)', () => {
    expect(canTransition('SWAP_SENT', 'SWAP_SENT')).toBe(false);
    expect(canTransition('SWAP_CONFIRMED', 'SWAP_SENT')).toBe(false);
    expect(canTransition('SWAP_CONFIRMED', 'PENDING')).toBe(false);
    expect(canTransition('BURN_SENT', 'SWAP_SENT')).toBe(false);
  });

  it('allows the burn retry edge (burning the full ATA is idempotent)', () => {
    expect(canTransition('BURN_SENT', 'SWAP_CONFIRMED')).toBe(true);
  });

  it('allows SWAP_CONFIRMED -> DONE when the ATA is already empty', () => {
    expect(canTransition('SWAP_CONFIRMED', 'DONE')).toBe(true);
  });

  it('only allows PENDING or SWAP_CONFIRMED as an initial state', () => {
    expect(canTransition(null, 'PENDING')).toBe(true);
    expect(canTransition(null, 'SWAP_CONFIRMED')).toBe(true); // orphan sweep
    expect(canTransition(null, 'SWAP_SENT')).toBe(false);
    expect(canTransition(null, 'DONE')).toBe(false);
  });

  it('treats DONE and ABORTED as terminal', () => {
    expect(isTerminal('DONE')).toBe(true);
    expect(isTerminal('ABORTED')).toBe(true);
    expect(isTerminal('SWAP_SENT')).toBe(false);
  });

  it('throws on an illegal transition', () => {
    expect(() => assertTransition('DONE', 'BURN_SENT')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('PENDING', 'DONE')).toThrow(IllegalTransitionError);
  });

  it('rejects an illegal transition at the ledger boundary and writes nothing', () => {
    expect(() =>
      ledger.transition('DONE', { cycleId: 'c1', state: 'SWAP_SENT', planLamports: '1', dryRun: false }),
    ).toThrow(IllegalTransitionError);
    expect(ledger.readAll()).toHaveLength(0);
  });
});

describe('fold + open cycle', () => {
  it('merges fields forward across transitions', () => {
    const events: LedgerEvent[] = [
      cycleEvent({ cycleId: 'c1', state: 'PENDING' }),
      cycleEvent({ cycleId: 'c1', state: 'SWAP_SENT', swapSig: 'SIG_SWAP', swapLastValidBlockHeight: 100, swapOutRaw: '777' }),
      cycleEvent({ cycleId: 'c1', state: 'SWAP_CONFIRMED' }),
      cycleEvent({ cycleId: 'c1', state: 'BURN_SENT', burnSig: 'SIG_BURN', burnAmountRaw: '777' }),
    ];
    const rec = foldCycles(events).get('c1')!;
    expect(rec.state).toBe('BURN_SENT');
    // swapSig survives even though the later events never repeat it.
    expect(rec.swapSig).toBe('SIG_SWAP');
    expect(rec.swapLastValidBlockHeight).toBe(100);
    expect(rec.swapOutRaw).toBe(777n);
    expect(rec.burnSig).toBe('SIG_BURN');
    expect(rec.burnAmountRaw).toBe(777n);
  });

  it('returns null when every cycle is terminal', () => {
    const events: LedgerEvent[] = [
      cycleEvent({ cycleId: 'c1', state: 'PENDING' }),
      cycleEvent({ cycleId: 'c1', state: 'ABORTED' }),
      cycleEvent({ cycleId: 'c2', state: 'PENDING' }),
      cycleEvent({ cycleId: 'c2', state: 'SWAP_SENT', swapSig: 's' }),
      cycleEvent({ cycleId: 'c2', state: 'SWAP_CONFIRMED' }),
      cycleEvent({ cycleId: 'c2', state: 'BURN_SENT', burnSig: 'b' }),
      cycleEvent({ cycleId: 'c2', state: 'DONE' }),
    ];
    expect(openCycle(foldCycles(events))).toBeNull();
  });

  it('resumes the OLDEST cycle if more than one is somehow open', () => {
    const events: LedgerEvent[] = [
      cycleEvent({ cycleId: 'old', state: 'SWAP_SENT', swapSig: 'a' }),
      cycleEvent({ cycleId: 'new', state: 'PENDING' }),
    ];
    expect(openCycle(foldCycles(events))!.cycleId).toBe('old');
  });
});

describe('crash resume', () => {
  it('resumes a crash after PENDING was written but before the swap was signed', () => {
    ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '5000000000', dryRun: false });
    const resumed = new Ledger(ledger.file).openCycle()!;
    expect(resumed.state).toBe('PENDING');
    expect(resumed.swapSig).toBeUndefined();
    expect(resumed.planLamports).toBe(5_000_000_000n);
    // From PENDING the only forward move is to send the swap.
    expect(canTransition(resumed.state, 'SWAP_SENT')).toBe(true);
  });

  it('resumes a crash between persisting the swap sig and broadcasting it', () => {
    ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '5000000000', dryRun: false });
    ledger.transition('PENDING', {
      cycleId: 'c1',
      state: 'SWAP_SENT',
      planLamports: '5000000000',
      swapSig: 'SWAPSIG',
      swapLastValidBlockHeight: 250,
      swapOutRaw: '1000000',
      dryRun: false,
    });

    const resumed = new Ledger(ledger.file).openCycle()!;
    expect(resumed.state).toBe('SWAP_SENT');
    // The signature is recoverable, which is what makes "check before resend" possible.
    expect(resumed.swapSig).toBe('SWAPSIG');
    expect(resumed.swapLastValidBlockHeight).toBe(250);
    expect(canTransition(resumed.state, 'SWAP_SENT')).toBe(false);
  });

  it('resumes a crash after the swap confirmed but before the burn was sent', () => {
    ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '1', dryRun: false });
    ledger.transition('PENDING', { cycleId: 'c1', state: 'SWAP_SENT', planLamports: '1', swapSig: 's', dryRun: false });
    ledger.transition('SWAP_SENT', { cycleId: 'c1', state: 'SWAP_CONFIRMED', planLamports: '1', swapOutRaw: '42', dryRun: false });

    const resumed = new Ledger(ledger.file).openCycle()!;
    expect(resumed.state).toBe('SWAP_CONFIRMED');
    expect(resumed.swapOutRaw).toBe(42n);
  });

  it('resumes a crash after the burn sig was persisted', () => {
    ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '1', dryRun: false });
    ledger.transition('PENDING', { cycleId: 'c1', state: 'SWAP_SENT', planLamports: '1', swapSig: 's', dryRun: false });
    ledger.transition('SWAP_SENT', { cycleId: 'c1', state: 'SWAP_CONFIRMED', planLamports: '1', dryRun: false });
    ledger.transition('SWAP_CONFIRMED', {
      cycleId: 'c1',
      state: 'BURN_SENT',
      planLamports: '1',
      burnSig: 'BURNSIG',
      burnLastValidBlockHeight: 900,
      burnAmountRaw: '12345',
      dryRun: false,
    });

    const resumed = new Ledger(ledger.file).openCycle()!;
    expect(resumed.state).toBe('BURN_SENT');
    expect(resumed.burnSig).toBe('BURNSIG');
    expect(resumed.burnAmountRaw).toBe(12345n);
    // Retry is allowed here precisely because we re-read the full ATA balance.
    expect(canTransition(resumed.state, 'SWAP_CONFIRMED')).toBe(true);
  });

  it('survives a torn final line', () => {
    ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '7', dryRun: false });
    fs.appendFileSync(ledger.file, '{"type":"cycle","cycleId":"c1","sta');
    const resumed = new Ledger(ledger.file).openCycle()!;
    expect(resumed.state).toBe('PENDING');
    expect(resumed.planLamports).toBe(7n);
  });

  it('an aborted cycle frees the keeper to start a new one', () => {
    ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '1', dryRun: false });
    ledger.transition('PENDING', { cycleId: 'c1', state: 'SWAP_SENT', planLamports: '1', swapSig: 's', dryRun: false });
    ledger.transition('SWAP_SENT', {
      cycleId: 'c1',
      state: 'ABORTED',
      planLamports: '1',
      reason: 'swap expired',
      dryRun: false,
    });
    expect(ledger.openCycle()).toBeNull();
  });
});

describe('advanceCycle: resuming SWAP_SENT against the chain', () => {
  const constants = readConstants();
  const BULL = new PublicKey(constants.wallets.bull);
  const cfg = { constants, bull: BULL, ansemDecimals: constants.ansem.decimals } as never;

  function fakeConnection(opts: {
    status: { err: unknown; confirmationStatus: string } | null;
    blockHeight: number;
    postAmount?: string;
  }): never {
    return {
      getSignatureStatuses: async () => ({ value: [opts.status] }),
      getBlockHeight: async () => opts.blockHeight,
      getTransaction: async () => ({
        meta: {
          preTokenBalances: [],
          postTokenBalances:
            opts.postAmount === undefined
              ? []
              : [
                  {
                    mint: constants.ansem.mint,
                    owner: BULL.toBase58(),
                    uiTokenAmount: { amount: opts.postAmount },
                  },
                ],
        },
      }),
    } as never;
  }

  function seedSwapSent(): void {
    ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '5000000000', dryRun: false });
    ledger.transition('PENDING', {
      cycleId: 'c1',
      state: 'SWAP_SENT',
      planLamports: '5000000000',
      swapSig: 'SWAPSIG',
      swapLastValidBlockHeight: 100,
      swapOutRaw: '1000000',
      priceImpactPct: 0.25,
      dryRun: false,
    });
  }

  it('confirms, records the ACTUAL token delta, and moves to SWAP_CONFIRMED', async () => {
    seedSwapSent();
    const deps = {
      connection: fakeConnection({ status: { err: null, confirmationStatus: 'confirmed' }, blockHeight: 50, postAmount: '1999999' }),
      cfg,
      ledger,
      signer: null,
      waitTimeoutMs: 50,
      waitPollMs: 10,
    };
    await advanceCycle(deps, ledger.openCycle()!);

    const swaps = ledger.readAll().filter((e): e is SwapEvent => e.type === 'swap');
    expect(swaps).toHaveLength(1);
    // 1999999 actual, not the 1000000 quoted
    expect(swaps[0]!.outRaw).toBe('1999999');
    expect(swaps[0]!.priceImpact).toBe(0.25);
    expect(ledger.openCycle()!.state).toBe('SWAP_CONFIRMED');
  });

  it('does not duplicate the swap event if the transition is replayed', async () => {
    seedSwapSent();
    const deps = {
      connection: fakeConnection({ status: { err: null, confirmationStatus: 'confirmed' }, blockHeight: 50, postAmount: '5' }),
      cfg,
      ledger,
      signer: null,
      waitTimeoutMs: 50,
      waitPollMs: 10,
    };
    await advanceCycle(deps, ledger.openCycle()!);
    // Simulate a crash right after the append: replay from SWAP_SENT.
    const replay = { ...ledger.openCycle()!, state: 'SWAP_SENT' as const };
    await advanceCycle(deps, replay);
    expect(ledger.readAll().filter((e) => e.type === 'swap')).toHaveLength(1);
  });

  it('aborts (never resends) once the blockhash has expired with no signature on chain', async () => {
    seedSwapSent();
    const deps = {
      connection: fakeConnection({ status: null, blockHeight: 101 }),
      cfg,
      ledger,
      signer: null,
      waitTimeoutMs: 50,
      waitPollMs: 10,
    };
    await advanceCycle(deps, ledger.openCycle()!);
    expect(ledger.openCycle()).toBeNull();
    const last = ledger.cycles().get('c1')!;
    expect(last.state).toBe('ABORTED');
    expect(last.reason).toMatch(/expired/);
    expect(ledger.readAll().filter((e) => e.type === 'swap')).toHaveLength(0);
  });

  it('aborts when the swap landed with an error', async () => {
    seedSwapSent();
    const deps = {
      connection: fakeConnection({ status: { err: { InstructionError: [3, 'x'] }, confirmationStatus: 'confirmed' }, blockHeight: 50 }),
      cfg,
      ledger,
      signer: null,
      waitTimeoutMs: 50,
      waitPollMs: 10,
    };
    await advanceCycle(deps, ledger.openCycle()!);
    expect(ledger.cycles().get('c1')!.state).toBe('ABORTED');
  });

  it('stays in SWAP_SENT while the signature could still land', async () => {
    seedSwapSent();
    const deps = {
      connection: fakeConnection({ status: null, blockHeight: 99 }),
      cfg,
      ledger,
      signer: null,
      waitTimeoutMs: 50,
      waitPollMs: 10,
    };
    await advanceCycle(deps, ledger.openCycle()!);
    expect(ledger.openCycle()!.state).toBe('SWAP_SENT');
    expect(ledger.openCycle()!.swapSig).toBe('SWAPSIG');
  });
});

describe('classifySignatureStatus — the anti-double-swap guard', () => {
  it('confirmed when the cluster has it confirmed', () => {
    expect(classifySignatureStatus({ err: null, confirmationStatus: 'confirmed' }, 10, 100)).toBe('confirmed');
    expect(classifySignatureStatus({ err: null, confirmationStatus: 'finalized' }, 10, 100)).toBe('confirmed');
  });

  it('failed when the tx landed with an error', () => {
    expect(classifySignatureStatus({ err: { InstructionError: [0, 'x'] }, confirmationStatus: 'confirmed' }, 10, 100)).toBe('failed');
  });

  it('pending while only processed', () => {
    expect(classifySignatureStatus({ err: null, confirmationStatus: 'processed' }, 10, 100)).toBe('pending');
  });

  it('pending — NOT expired — when unknown but the blockhash is still valid', () => {
    expect(classifySignatureStatus(null, 99, 100)).toBe('pending');
    expect(classifySignatureStatus(null, 100, 100)).toBe('pending');
  });

  it('expired only once the last valid block height has passed', () => {
    expect(classifySignatureStatus(null, 101, 100)).toBe('expired');
  });

  it('stays pending forever when we have no lastValidBlockHeight (never guesses)', () => {
    expect(classifySignatureStatus(null, 10_000_000, undefined)).toBe('pending');
  });
});

describe('splitCycleAmounts — the disclosed ops cut', () => {
  it('is exact for every input: ops + swap === processed', () => {
    const cases: Array<[bigint, number]> = [
      [5_000_000_000n, 500],
      [1n, 500],
      [0n, 500],
      [999n, 500],
      [890_880n, 500],
      [123_456_789_123n, 500],
      [5_000_000_000n, 0],
      [5_000_000_000n, 10_000],
    ];
    for (const [processed, bps] of cases) {
      const { opsLamports, swapLamports } = splitCycleAmounts(processed, bps);
      expect(opsLamports + swapLamports).toBe(processed);
      expect(opsLamports >= 0n).toBe(true);
      expect(swapLamports >= 0n).toBe(true);
    }
  });

  it('floors — the cut only ever rounds DOWN', () => {
    // 999 * 500 / 10000 = 49.95 -> 49
    expect(splitCycleAmounts(999n, 500).opsLamports).toBe(49n);
    // 5 SOL at 5% is exactly 0.25 SOL
    expect(splitCycleAmounts(5_000_000_000n, 500).opsLamports).toBe(250_000_000n);
  });

  it('tiny cycles round the cut to zero and swap everything', () => {
    const { opsLamports, swapLamports } = splitCycleAmounts(19n, 500);
    expect(opsLamports).toBe(0n);
    expect(swapLamports).toBe(19n);
  });

  it('clamps hostile bps instead of minting lamports', () => {
    expect(splitCycleAmounts(1_000n, -500).opsLamports).toBe(0n);
    expect(splitCycleAmounts(1_000n, 20_000).opsLamports).toBe(1_000n);
    expect(splitCycleAmounts(-5n as bigint, 500)).toEqual({ opsLamports: 0n, swapLamports: 0n });
  });
});

describe('advanceCycle dispatch covers every state', () => {
  // The dispatcher once shipped without an OPS_SENT case: a cycle that paid the
  // ops fee would stall forever, unreachable by any pass. This pins the wiring:
  // every non-terminal state must reach a handler — in DRY_RUN every handler
  // throws the SignerMismatchError backstop, which is exactly the proof the
  // state was dispatched rather than silently ignored.
  const states: CycleState[] = ['PENDING', 'OPS_SENT', 'SWAP_SENT', 'SWAP_CONFIRMED', 'BURN_SENT'];
  for (const state of states) {
    it(`refuses to drive ${state} in DRY_RUN (dispatched, then stopped by the backstop)`, async () => {
      const deps = {
        cfg: { ...loadConfig({} as NodeJS.ProcessEnv), dryRun: true },
        connection: null as never,
        ledger: null as never,
        signer: null,
      };
      const cycle = {
        cycleId: 'test-cycle',
        state,
        planLamports: 5_000_000_000n,
        updatedAt: new Date().toISOString(),
        dryRun: false,
      } as CycleRecord;
      await expect(advanceCycle(deps as never, cycle)).rejects.toThrow(SignerMismatchError);
    });
  }

  it('terminal states are no-ops', async () => {
    for (const state of ['DONE', 'ABORTED'] as CycleState[]) {
      const cycle = {
        cycleId: 'test-cycle',
        state,
        planLamports: 0n,
        updatedAt: new Date().toISOString(),
        dryRun: false,
      } as CycleRecord;
      await expect(
        advanceCycle({ cfg: null, connection: null, ledger: null, signer: null } as never, cycle),
      ).resolves.toBeUndefined();
    }
  });
});
