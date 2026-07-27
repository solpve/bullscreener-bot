import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ConfigError, loadConfig, readConstants, OPS_PLACEHOLDER } from '../src/config.js';
import { runBuybackPass, SignerMismatchError, advanceCycle } from '../src/cycle.js';
import { Ledger } from '../src/ledger.js';
import { isNativeQuote, scanInflows } from '../src/attribution.js';
import { belowCrankFloor } from '../src/crank.js';
import type { KeeperConfig } from '../src/config.js';
import type { CycleState } from '../src/types.js';

const constants = readConstants();
const BULL = new PublicKey(constants.wallets.bull);
const WSOL = new PublicKey(constants.programs.wsolMint);

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bullscreener-safety-'));
  ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function cfgWith(over: Partial<KeeperConfig>): KeeperConfig {
  return {
    constants,
    rpcUrl: 'http://localhost:8899',
    keypairPath: undefined,
    dryRun: true,
    dryRunForced: true,
    bull: BULL,
    ops: null,
    ansemMint: new PublicKey(constants.ansem.mint),
    ansemDecimals: constants.ansem.decimals,
    wsolMint: WSOL,
    triggerLamports: 5_000_000_000n,
    reserveLamports: 50_000_000n,
    reserveAlertLamports: 20_000_000n,
    maxSolPerSwapLamports: 200_000_000_000n,
    bullBps: 9500,
    opsBps: 500,
    ...over,
  } as unknown as KeeperConfig;
}

/**
 * A connection that fails the test if anything tries to touch the chain in a way
 * that could send money. Reads that DRY_RUN legitimately performs are allowed.
 */
function tripwireConnection(): never {
  return {
    sendRawTransaction: () => {
      throw new Error('sendRawTransaction must never be called in DRY_RUN');
    },
    getLatestBlockhash: () => {
      throw new Error('getLatestBlockhash must never be called in DRY_RUN');
    },
    getSignatureStatuses: () => {
      throw new Error('getSignatureStatuses must never be called in DRY_RUN');
    },
    getAccountInfo: async () => null,
    getBalance: async () => 0,
  } as never;
}

function seed(state: CycleState, extra: Record<string, unknown> = {}): void {
  ledger.transition(null, { cycleId: 'c1', state: 'PENDING', planLamports: '5000000000', dryRun: false });
  if (state !== 'PENDING') {
    ledger.transition('PENDING', {
      cycleId: 'c1',
      state: 'SWAP_SENT',
      planLamports: '5000000000',
      swapSig: 'SWAPSIG',
      swapLastValidBlockHeight: 100,
      dryRun: false,
      ...extra,
    });
  }
  if (state === 'SWAP_CONFIRMED') {
    ledger.transition('SWAP_SENT', {
      cycleId: 'c1',
      state: 'SWAP_CONFIRMED',
      planLamports: '5000000000',
      dryRun: false,
    });
  }
}

describe('DRY_RUN never drives the cycle state machine', () => {
  it('does not throw or write when a PENDING cycle is open and no signer exists', async () => {
    seed('PENDING');
    const before = ledger.readAll().length;
    const deps = { connection: tripwireConnection(), cfg: cfgWith({}), ledger, signer: null };
    await expect(runBuybackPass(deps)).resolves.toBeUndefined();
    expect(ledger.readAll()).toHaveLength(before);
    expect(ledger.openCycle()!.state).toBe('PENDING');
  });

  it('does not sign or broadcast when a signer IS loaded but DRY_RUN is on', async () => {
    // The dangerous case: the operator has the BULL key configured and restarts
    // without DRY_RUN=false. Before the fix this signed and broadcast a real swap.
    seed('PENDING');
    const before = ledger.readAll().length;
    const bullSigner = Keypair.generate();
    const cfg = cfgWith({ dryRun: true, keypairPath: '/dev/null', bull: bullSigner.publicKey });
    const deps = { connection: tripwireConnection(), cfg, ledger, signer: bullSigner };
    await expect(runBuybackPass(deps)).resolves.toBeUndefined();
    expect(ledger.readAll()).toHaveLength(before);
  });

  it('leaves a SWAP_CONFIRMED cycle (burn owed) untouched in DRY_RUN', async () => {
    seed('SWAP_CONFIRMED');
    const before = ledger.readAll().length;
    const bullSigner = Keypair.generate();
    const cfg = cfgWith({ dryRun: true, bull: bullSigner.publicKey });
    const deps = { connection: tripwireConnection(), cfg, ledger, signer: bullSigner };
    await runBuybackPass(deps);
    expect(ledger.readAll()).toHaveLength(before);
    expect(ledger.openCycle()!.state).toBe('SWAP_CONFIRMED');
  });

  it('backstop: advancing a cycle directly still refuses to sign under DRY_RUN', async () => {
    seed('PENDING');
    const bullSigner = Keypair.generate();
    const cfg = cfgWith({ dryRun: true, bull: bullSigner.publicKey });
    const deps = { connection: tripwireConnection(), cfg, ledger, signer: bullSigner };
    await expect(advanceCycle(deps, ledger.openCycle()!)).rejects.toThrow(SignerMismatchError);
  });
});

describe('config safety gates', () => {
  it('forces DRY_RUN on when KEYPAIR_PATH is unset, even with DRY_RUN=false', () => {
    const cfg = loadConfig({ DRY_RUN: 'false' } as NodeJS.ProcessEnv);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.dryRunForced).toBe(true);
    expect(cfg.keypairPath).toBeUndefined();
  });

  it('reports dryRunForced whenever no key is available (DRY_RUN=false cannot help)', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.dryRunForced).toBe(true);
  });

  const placeholderConstants = () => ({
    ...constants,
    wallets: { ...constants.wallets, ops: OPS_PLACEHOLDER },
    // opsFee.recipient must track wallets.ops (loadConfig hard-errors on drift).
    opsFee: { ...constants.opsFee, recipient: OPS_PLACEHOLDER },
  });

  it('refuses live mode while wallets.ops is the placeholder', () => {
    expect(() =>
      loadConfig(
        { KEYPAIR_PATH: '/nonexistent/key.json', DRY_RUN: 'false' } as NodeJS.ProcessEnv,
        placeholderConstants(),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        { KEYPAIR_PATH: '/nonexistent/key.json', DRY_RUN: 'false' } as NodeJS.ProcessEnv,
        placeholderConstants(),
      ),
    ).toThrow(/REPLACE_WITH_OPS_WALLET/);
  });

  it('allows dry run with the placeholder in place (ops resolves null)', () => {
    const cfg = loadConfig(
      { KEYPAIR_PATH: '/nonexistent/key.json' } as NodeJS.ProcessEnv,
      placeholderConstants(),
    );
    expect(cfg.dryRun).toBe(true);
    expect(cfg.ops).toBeNull();
  });

  it('resolves the real ops wallet from shipped constants', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    if (constants.wallets.ops === OPS_PLACEHOLDER) {
      expect(cfg.ops).toBeNull();
    } else {
      expect(cfg.ops?.toBase58()).toBe(constants.wallets.ops);
      expect(cfg.opsBps).toBe(500);
    }
  });
});

describe('quote-mint guard on attribution', () => {
  const cfg = cfgWith({});

  it('treats the native (system-program) and WSOL quote mints as lamports', () => {
    // Live distribute events for SOL coins carry quote_mint = 1111…1111.
    expect(isNativeQuote(cfg, PublicKey.default)).toBe(true);
    expect(isNativeQuote(cfg, WSOL)).toBe(true);
  });

  it('rejects an SPL quote mint (distributed is not lamports there)', () => {
    expect(isNativeQuote(cfg, new PublicKey(constants.ansem.mint))).toBe(false);
  });

  it('records the credit as unattributed rather than inventing a token-denominated inflow', async () => {
    const splQuote = new PublicKey(constants.ansem.mint);
    // Build a DistributeCreatorFeesEvent payload with an SPL quote mint.
    const payload = Buffer.concat([
      Buffer.alloc(8), // timestamp
      new PublicKey('So11111111111111111111111111111111111111112').toBuffer(), // mint (any)
      PublicKey.default.toBuffer(), // bonding curve
      PublicKey.default.toBuffer(), // sharing config
      PublicKey.default.toBuffer(), // admin
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(1);
        return b;
      })(),
      BULL.toBuffer(),
      (() => {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(10_000);
        return b;
      })(),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(9_999_999_999n); // huge token amount, NOT lamports
        return b;
      })(),
      splQuote.toBuffer(),
    ]);
    const disc = Buffer.from([165, 55, 129, 112, 4, 179, 202, 40]);
    const logLine = `Program data: ${Buffer.concat([disc, payload]).toString('base64')}`;

    const connection = {
      getSignaturesForAddress: async () => [{ signature: 'SIG1', slot: 1, err: null }],
      getTransaction: async () => ({
        meta: {
          logMessages: [logLine],
          innerInstructions: [],
          preBalances: [0],
          postBalances: [1_234n > 0n ? 1234 : 0],
          loadedAddresses: undefined,
        },
        transaction: { message: { staticAccountKeys: [BULL], getAccountKeys: () => ({ keySegments: () => [[BULL]] }) } },
      }),
    } as never;

    const recorded = await scanInflows(connection, cfg, ledger, {
      delayMs: 0,
      cursorFile: path.join(dir, 'cursor.json'),
    });
    expect(recorded).toHaveLength(1);
    // The real 1234-lamport credit, tagged unknown — not 9,999,999,999 "lamports".
    expect(recorded[0]!.lamports).toBe('1234');
    expect(recorded[0]!.sourceMint).toBeNull();
    expect(recorded[0]!.attribution).toBe('unknown');
    // And no rebate liability was accrued from an unattributable inflow.
    expect(ledger.readAll().filter((e) => e.type === 'rebate_accrual')).toHaveLength(0);
    expect(ledger.readAll().filter((e) => e.type === 'crank')).toHaveLength(0);
  });
});

describe('ledger append is durable and append-only', () => {
  it('appends without clobbering lines written by anything else', () => {
    ledger.append({ type: 'burn', ts: 'x', cycleId: 'a', sig: 's1', amountRaw: '1', supplyAfter: null, dryRun: false });
    fs.appendFileSync(ledger.file, '{"type":"burn","ts":"y","cycleId":"b","sig":"s2","amountRaw":"2","supplyAfter":null,"dryRun":false}\n');
    ledger.append({ type: 'burn', ts: 'z', cycleId: 'c', sig: 's3', amountRaw: '3', supplyAfter: null, dryRun: false });
    const burns = ledger.readAll().filter((e) => e.type === 'burn');
    expect(burns.map((b) => (b as { sig: string }).sig)).toEqual(['s1', 's2', 's3']);
  });
});

describe('crank economics floor', () => {
  it('skips below the floor, cranks at or above it', () => {
    expect(belowCrankFloor(0n, 100_000)).toBe(true);
    expect(belowCrankFloor(99_999n, 100_000)).toBe(true);
    expect(belowCrankFloor(100_000n, 100_000)).toBe(false);
    expect(belowCrankFloor(5_000_000n, 100_000)).toBe(false);
  });

  it('never skips when the floor is unset or zero', () => {
    expect(belowCrankFloor(0n, undefined)).toBe(false);
    expect(belowCrankFloor(0n, 0)).toBe(false);
  });
});
