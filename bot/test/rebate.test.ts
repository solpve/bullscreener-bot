import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { utils } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import {
  EVENT_IX_TAG,
  bpsForShareholders,
  computeRebate,
  decodeDistributeEventPayload,
  distributeEventDiscriminator,
  extractDistributeEvents,
  lamportDelta,
  recordDistribution,
  totalFromSlice,
} from '../src/attribution.js';
import { readConstants } from '../src/config.js';
import { ourSlice } from '../src/crank.js';
import { Ledger } from '../src/ledger.js';
import { planSwaps } from '../src/trigger.js';
import { evaluateBreakers, deviationPct, impliedSolPerToken, parsePriceImpactPct } from '../src/jupiter.js';
import type { KeeperConfig } from '../src/config.js';
import type { RebateAccrualEvent } from '../src/types.js';

const constants = readConstants();
const BULL = new PublicKey(constants.wallets.bull);
const OTHER = new PublicKey('GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52');
const SOL = 1_000_000_000n;

function makeCfg(rebateOverride?: Partial<typeof constants.split.rebate>): KeeperConfig {
  const c = JSON.parse(JSON.stringify(constants)) as typeof constants;
  if (rebateOverride) Object.assign(c.split.rebate, rebateOverride);
  return {
    constants: c,
    bull: BULL,
    ops: null,
    opsBps: 500,
    bullBps: 9500,
    ansemDecimals: c.ansem.decimals,
    triggerLamports: BigInt(c.keeper.triggerSol) * SOL,
    reserveLamports: BigInt(Math.round(c.keeper.reserveSol * 1e9)),
    reserveAlertLamports: BigInt(Math.round(c.keeper.reserveAlertSol * 1e9)),
    maxSolPerSwapLamports: BigInt(c.keeper.maxSolPerSwap) * SOL,
  } as unknown as KeeperConfig;
}

/** Config exactly as shipped in config/constants.json. */
const cfgLike = makeCfg();
/** Same, but with the rebate policy switched on, to exercise the dormant path. */
const cfgRebateOn = makeCfg({ enabled: true });

describe('rebate math (constants.split.rebate)', () => {
  const base = {
    opsBps: 500,
    opsRetainedBps: constants.split.rebate.opsRetainedBpsAboveThreshold,
    thresholdUsd: constants.split.rebate.coinMcapThresholdUsd,
    enabled: true,
  };

  it('takes a $10M coin from 95/5 to an effective 99/1', () => {
    const r = computeRebate({ ...base, distributedLamports: 100n * SOL, mcapUsd: 10_000_000 });
    expect(r.eligible).toBe(true);
    expect(r.opsGrossLamports).toBe(5n * SOL); // 500 bps of 100 SOL
    expect(r.opsRetainedLamports).toBe(1n * SOL); // 100 bps kept
    expect(r.rebateLamports).toBe(4n * SOL); // 400 bps rebated to BULL
  });

  it('is exactly at-threshold inclusive', () => {
    const at = computeRebate({ ...base, distributedLamports: 100n * SOL, mcapUsd: base.thresholdUsd });
    expect(at.eligible).toBe(true);
    const under = computeRebate({ ...base, distributedLamports: 100n * SOL, mcapUsd: base.thresholdUsd - 1 });
    expect(under.eligible).toBe(false);
    expect(under.rebateLamports).toBe(0n);
    expect(under.opsRetainedLamports).toBe(under.opsGrossLamports);
  });

  it('never accrues on an unknown mcap', () => {
    const r = computeRebate({ ...base, distributedLamports: 100n * SOL, mcapUsd: null });
    expect(r.eligible).toBe(false);
    expect(r.rebateLamports).toBe(0n);
  });

  it('accrues nothing when the policy is disabled', () => {
    const r = computeRebate({ ...base, enabled: false, distributedLamports: 100n * SOL, mcapUsd: 1e9 });
    expect(r.eligible).toBe(false);
    expect(r.rebateLamports).toBe(0n);
  });

  it('handles zero and dust distributions without going negative', () => {
    expect(computeRebate({ ...base, distributedLamports: 0n, mcapUsd: 1e9 }).rebateLamports).toBe(0n);
    // 100 lamports * 500 / 10000 = 5 ; retained 100*100/10000 = 1 ; rebate 4
    const dust = computeRebate({ ...base, distributedLamports: 100n, mcapUsd: 1e9 });
    expect(dust.opsGrossLamports).toBe(5n);
    expect(dust.opsRetainedLamports).toBe(1n);
    expect(dust.rebateLamports).toBe(4n);
    // 19 lamports floors ops gross to 0 => not eligible, nothing owed
    expect(computeRebate({ ...base, distributedLamports: 19n, mcapUsd: 1e9 }).rebateLamports).toBe(0n);
  });

  it('clamps a retained bps larger than the ops share to zero rebate', () => {
    const r = computeRebate({ ...base, opsRetainedBps: 900, distributedLamports: 100n * SOL, mcapUsd: 1e9 });
    expect(r.rebateLamports).toBe(0n);
    expect(r.opsRetainedLamports).toBe(r.opsGrossLamports);
  });

  it('floors like the on-chain split (never over-accrues)', () => {
    const r = computeRebate({ ...base, distributedLamports: 12_345n, mcapUsd: 1e9 });
    expect(r.opsGrossLamports).toBe(617n); // floor(12345 * 500 / 10000)
    expect(r.opsRetainedLamports).toBe(123n); // floor(12345 * 100 / 10000)
    expect(r.rebateLamports).toBe(494n);
  });
});

describe('slice math', () => {
  it('computes our slice of a distribution', () => {
    expect(ourSlice(100n * SOL, 9500)).toBe(95n * SOL);
    expect(ourSlice(100n * SOL, 0)).toBe(0n);
    expect(ourSlice(0n, 9500)).toBe(0n);
  });

  it('reconstructs the total from our slice (lossy, hence "derived")', () => {
    expect(totalFromSlice(95n * SOL, 9500)).toBe(100n * SOL);
    expect(totalFromSlice(0n, 9500)).toBe(0n);
    expect(totalFromSlice(100n, 0)).toBe(0n);
  });

  it('sums duplicated shareholder entries for the same wallet', () => {
    expect(
      bpsForShareholders(
        [
          { address: BULL, shareBps: 5000 },
          { address: OTHER, shareBps: 500 },
          { address: BULL, shareBps: 4500 },
        ],
        BULL,
      ),
    ).toBe(9500);
    expect(bpsForShareholders([{ address: OTHER, shareBps: 10_000 }], BULL)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

function buildDistributeEvent(opts: {
  mint: PublicKey;
  shareholders: { address: PublicKey; shareBps: number }[];
  distributed: bigint;
}): Buffer {
  const disc = distributeEventDiscriminator();
  const body = Buffer.alloc(8 + 32 * 4 + 4 + opts.shareholders.length * 34 + 8 + 32);
  let o = 0;
  body.writeBigInt64LE(1_800_000_000n, o);
  o += 8;
  opts.mint.toBuffer().copy(body, o);
  o += 32;
  PublicKey.default.toBuffer().copy(body, o); // bonding_curve
  o += 32;
  PublicKey.default.toBuffer().copy(body, o); // sharing_config
  o += 32;
  PublicKey.default.toBuffer().copy(body, o); // admin
  o += 32;
  body.writeUInt32LE(opts.shareholders.length, o);
  o += 4;
  for (const sh of opts.shareholders) {
    sh.address.toBuffer().copy(body, o);
    o += 32;
    body.writeUInt16LE(sh.shareBps, o);
    o += 2;
  }
  body.writeBigUInt64LE(opts.distributed, o);
  o += 8;
  new PublicKey(constants.programs.wsolMint).toBuffer().copy(body, o);
  return Buffer.concat([disc, body]);
}

describe('DistributeCreatorFeesEvent parsing', () => {
  const mint = new PublicKey(constants.ansem.mint);
  const shareholders = [
    { address: BULL, shareBps: 9500 },
    { address: OTHER, shareBps: 500 },
  ];
  const encoded = buildDistributeEvent({ mint, shareholders, distributed: 3n * SOL });

  it('decodes the payload', () => {
    const info = decodeDistributeEventPayload(encoded.subarray(8));
    expect(info.mint.toBase58()).toBe(constants.ansem.mint);
    expect(info.distributedLamports).toBe(3n * SOL);
    expect(info.shareholders.map((s) => s.shareBps)).toEqual([9500, 500]);
    expect(info.quoteMint.toBase58()).toBe(constants.programs.wsolMint);
  });

  it('extracts from a "Program data:" log', () => {
    const events = extractDistributeEvents({
      meta: { logMessages: [`Program data: ${encoded.toString('base64')}`] },
    } as never);
    expect(events).toHaveLength(1);
    expect(events[0]!.distributedLamports).toBe(3n * SOL);
  });

  it('extracts from an emit_cpi! inner instruction', () => {
    const data = utils.bytes.bs58.encode(Buffer.concat([EVENT_IX_TAG, encoded]));
    const events = extractDistributeEvents({
      meta: { innerInstructions: [{ index: 0, instructions: [{ data }] }] },
    } as never);
    expect(events).toHaveLength(1);
    expect(events[0]!.mint.toBase58()).toBe(constants.ansem.mint);
  });

  it('does not double count the same event seen in both places', () => {
    const events = extractDistributeEvents({
      meta: {
        logMessages: [`Program data: ${encoded.toString('base64')}`],
        innerInstructions: [
          { index: 0, instructions: [{ data: utils.bytes.bs58.encode(Buffer.concat([EVENT_IX_TAG, encoded])) }] },
        ],
      },
    } as never);
    expect(events).toHaveLength(1);
  });

  it('ignores unrelated logs and instructions', () => {
    const events = extractDistributeEvents({
      meta: {
        logMessages: ['Program log: hello', 'Program data: AAAA'],
        innerInstructions: [{ index: 0, instructions: [{ data: '3Bxs4' }] }],
      },
    } as never);
    expect(events).toEqual([]);
  });

  it('rejects a truncated payload', () => {
    expect(() => decodeDistributeEventPayload(encoded.subarray(8, 40))).toThrow();
  });
});

describe('lamportDelta', () => {
  it('reads the credit for the BULL wallet', () => {
    const tx = {
      transaction: {
        message: {
          staticAccountKeys: [PublicKey.default, BULL],
          getAccountKeys: () => ({ keySegments: () => [[PublicKey.default, BULL]] }),
        },
      },
      meta: { preBalances: [10, 100], postBalances: [5, 4_100] },
    };
    expect(lamportDelta(tx as never, BULL)).toBe(4_000n);
  });

  it('reads a wallet that only appears via an address lookup table', () => {
    const tx = {
      transaction: {
        message: {
          staticAccountKeys: [PublicKey.default],
          getAccountKeys: () => ({ keySegments: () => [[PublicKey.default], [BULL]] }),
        },
      },
      meta: { preBalances: [10, 1], postBalances: [5, 501], loadedAddresses: { writable: [BULL], readonly: [] } },
    };
    expect(lamportDelta(tx as never, BULL)).toBe(500n);
  });

  it('falls back to static keys when lookup resolution throws', () => {
    const tx = {
      transaction: {
        message: {
          staticAccountKeys: [PublicKey.default, BULL],
          getAccountKeys: () => {
            throw new Error('address table lookups were not resolved');
          },
        },
      },
      meta: { preBalances: [10, 100], postBalances: [5, 700] },
    };
    expect(lamportDelta(tx as never, BULL)).toBe(600n);
  });

  it('returns 0 when the wallet is not in the transaction', () => {
    const tx = {
      transaction: {
        message: {
          staticAccountKeys: [PublicKey.default],
          getAccountKeys: () => ({ keySegments: () => [[PublicKey.default]] }),
        },
      },
      meta: { preBalances: [10], postBalances: [10] },
    };
    expect(lamportDelta(tx as never, BULL)).toBe(0n);
  });
});

describe('recordDistribution ledger writes', () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bullscreener-rebate-'));
    ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rec = {
    sig: 'SIG1',
    mint: constants.ansem.mint,
    distributedLamports: 100n * SOL,
    distributedSource: 'event' as const,
    ourBps: 9500,
    mcapUsd: 10_000_000,
    ownCrank: true,
    dryRun: false,
  };

  it('writes a crank + rebate_accrual pair (rebate policy ON)', () => {
    recordDistribution(ledger, cfgRebateOn, rec);
    const events = ledger.readAll();
    expect(events.filter((e) => e.type === 'crank')).toHaveLength(1);
    const accrual = events.find((e): e is RebateAccrualEvent => e.type === 'rebate_accrual')!;
    expect(accrual.eligible).toBe(true);
    expect(accrual.rebateLamports).toBe((4n * SOL).toString());
    expect(accrual.distributedSource).toBe('event');
  });

  it('accrues nothing under the SHIPPED constants (flat 95/5, rebate disabled)', () => {
    expect(constants.split.rebate.enabled).toBe(false);
    recordDistribution(ledger, cfgLike, rec);
    const accrual = ledger.readAll().find((e): e is RebateAccrualEvent => e.type === 'rebate_accrual')!;
    expect(accrual.eligible).toBe(false);
    expect(accrual.rebateLamports).toBe('0');
    // ops simply keeps its protocol-enforced 500 bps
    expect(accrual.opsRetainedLamports).toBe((5n * SOL).toString());
    // ...and the crank/attribution record is still written in full
    expect(ledger.readAll().filter((e) => e.type === 'crank')).toHaveLength(1);
  });

  it('is idempotent per (sig, mint) — replays never double count', () => {
    recordDistribution(ledger, cfgRebateOn, rec);
    recordDistribution(ledger, cfgRebateOn, rec);
    recordDistribution(ledger, cfgRebateOn, rec);
    expect(ledger.readAll().filter((e) => e.type === 'crank')).toHaveLength(1);
    expect(ledger.readAll().filter((e) => e.type === 'rebate_accrual')).toHaveLength(1);
  });

  it('records a second mint from the same transaction', () => {
    recordDistribution(ledger, cfgRebateOn, rec);
    recordDistribution(ledger, cfgRebateOn, { ...rec, mint: constants.programs.wsolMint });
    expect(ledger.readAll().filter((e) => e.type === 'rebate_accrual')).toHaveLength(2);
  });

  it('accrues zero for a below-threshold coin but still logs the crank', () => {
    recordDistribution(ledger, cfgRebateOn, { ...rec, mcapUsd: 100_000 });
    const accrual = ledger.readAll().find((e): e is RebateAccrualEvent => e.type === 'rebate_accrual')!;
    expect(accrual.eligible).toBe(false);
    expect(accrual.rebateLamports).toBe('0');
    expect(accrual.opsRetainedLamports).toBe((5n * SOL).toString());
  });
});

describe('trigger planning', () => {
  it('does not fire below the trigger', () => {
    expect(planSwaps(4n * SOL, cfgLike).chunks).toEqual([]);
    // trigger is on (balance - reserve), so exactly triggerSol is NOT enough
    expect(planSwaps(5n * SOL, cfgLike).chunks).toEqual([]);
  });

  it('fires once available crosses the trigger', () => {
    const plan = planSwaps(5n * SOL + cfgLike.reserveLamports, cfgLike);
    expect(plan.chunks).toEqual([5n * SOL]);
    expect(plan.availableLamports).toBe(5n * SOL);
  });

  it('always leaves the reserve behind', () => {
    const plan = planSwaps(10n * SOL, cfgLike);
    expect(plan.totalLamports).toBe(10n * SOL - cfgLike.reserveLamports);
  });

  it('caps each swap at maxSolPerSwap and loops for big balances', () => {
    const plan = planSwaps(450n * SOL + cfgLike.reserveLamports, cfgLike);
    expect(plan.chunks).toEqual([200n * SOL, 200n * SOL, 50n * SOL]);
  });

  it('leaves a sub-trigger remainder in the wallet rather than swapping it', () => {
    const plan = planSwaps(203n * SOL + cfgLike.reserveLamports, cfgLike);
    expect(plan.chunks).toEqual([200n * SOL]);
    expect(plan.availableLamports - plan.totalLamports).toBe(3n * SOL);
  });

  it('flags the reserve alert', () => {
    expect(planSwaps(10_000_000n, cfgLike).reserveAlert).toBe(true);
    expect(planSwaps(100n * SOL, cfgLike).reserveAlert).toBe(false);
  });

  it('never goes negative on a dust balance', () => {
    const plan = planSwaps(1n, cfgLike);
    expect(plan.availableLamports).toBe(0n);
    expect(plan.chunks).toEqual([]);
  });
});

describe('jupiter circuit breakers', () => {
  const decimals = constants.ansem.decimals;
  const ok = {
    inLamports: 5n * SOL,
    outRaw: 1_943_282_693n,
    outDecimals: decimals,
    maxPriceImpactPct: constants.keeper.maxPriceImpactPct,
    maxRefPriceDeviationPct: constants.keeper.maxRefPriceDeviationPct,
  };
  const reference = { solPerToken: 0.002557, source: 'test' };

  it('parses Jupiter fractional price impact into percent', () => {
    expect(parsePriceImpactPct({ priceImpactPct: '0.0017' })).toBeCloseTo(0.17, 6);
    expect(parsePriceImpactPct({ priceImpactPct: 0 })).toBe(0);
    expect(parsePriceImpactPct({ priceImpactPct: '-0.01' })).toBeCloseTo(1, 6);
    expect(parsePriceImpactPct({ priceImpactPct: 'nope' })).toBe(Number.POSITIVE_INFINITY);
  });

  it('computes the implied price and deviation', () => {
    const implied = impliedSolPerToken(5n * SOL, 1_943_282_693n, decimals)!;
    expect(implied).toBeCloseTo(0.002573, 6);
    expect(deviationPct(implied, 0.002557)).toBeLessThan(1);
  });

  it('passes a healthy quote', () => {
    const r = evaluateBreakers({ ...ok, priceImpactPct: 0.0005, reference });
    expect(r.ok).toBe(true);
  });

  it('trips on excessive price impact', () => {
    const r = evaluateBreakers({ ...ok, priceImpactPct: 2.5, reference });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/price impact/);
  });

  it('trips when the implied price is far from the reference', () => {
    const r = evaluateBreakers({ ...ok, priceImpactPct: 0.1, reference: { solPerToken: 0.001, source: 'test' } });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/deviates/);
  });

  it('fails CLOSED with no reference price', () => {
    const r = evaluateBreakers({ ...ok, priceImpactPct: 0.1, reference: null });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/failing closed/);
  });

  it('refuses a zero-output quote', () => {
    const r = evaluateBreakers({ ...ok, outRaw: 0n, priceImpactPct: 0.1, reference });
    expect(r.ok).toBe(false);
  });
});
