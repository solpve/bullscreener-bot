import fs from 'node:fs';
import { Connection, Keypair, SystemProgram } from '@solana/web3.js';
import { OPS_PLACEHOLDER, type KeeperConfig } from './config.js';
import type { Ledger } from './ledger.js';
import { nowIso } from './ledger.js';
import { log } from './logger.js';
import { awaitOutcome, buildV0Tx, signAndSend } from './tx.js';
import type { RebateAccrualEvent, RebatePaidEvent } from './types.js';

/**
 * Ops-side rebate settlement.
 *
 * The 95/5 split is protocol-enforced and irreversible per coin. The rebate that
 * takes high-mcap coins to an effective 99/1 is an OFF-protocol promise, so it
 * is (a) accrued automatically in the ledger by attribution.ts and (b) PAID only
 * by an explicit `npm run rebates -- --send`. It is never automatic, and the
 * keeper's BULL key can never move ops funds — settlement needs a separate
 * OPS_KEYPAIR_PATH.
 */

export interface RebateSummary {
  accrued: RebateAccrualEvent[];
  paidSigs: Set<string>;
  unpaid: RebateAccrualEvent[];
  totalAccruedLamports: bigint;
  totalPaidLamports: bigint;
  totalUnpaidLamports: bigint;
  perMint: Map<string, { accrued: bigint; unpaid: bigint; count: number }>;
}

export function summarizeRebates(ledger: Ledger): RebateSummary {
  const events = ledger.readAll();
  const accrued = events.filter((e): e is RebateAccrualEvent => e.type === 'rebate_accrual');
  const paidSigs = new Set<string>();
  let totalPaidLamports = 0n;
  for (const e of events) {
    if (e.type !== 'rebate_paid') continue;
    const paid = e as RebatePaidEvent;
    if (paid.dryRun) continue;
    totalPaidLamports += BigInt(paid.lamports);
    for (const s of paid.settles) paidSigs.add(s);
  }

  const perMint = new Map<string, { accrued: bigint; unpaid: bigint; count: number }>();
  let totalAccruedLamports = 0n;
  let totalUnpaidLamports = 0n;
  const unpaid: RebateAccrualEvent[] = [];

  for (const a of accrued) {
    const amount = BigInt(a.rebateLamports);
    if (amount === 0n) continue;
    totalAccruedLamports += amount;
    const isPaid = paidSigs.has(a.sig);
    if (!isPaid) {
      unpaid.push(a);
      totalUnpaidLamports += amount;
    }
    const row = perMint.get(a.mint) ?? { accrued: 0n, unpaid: 0n, count: 0 };
    row.accrued += amount;
    if (!isPaid) row.unpaid += amount;
    row.count += 1;
    perMint.set(a.mint, row);
  }

  return {
    accrued,
    paidSigs,
    unpaid,
    totalAccruedLamports,
    totalPaidLamports,
    totalUnpaidLamports,
    perMint,
  };
}

function loadOpsKeypair(): Keypair {
  const path = (process.env['OPS_KEYPAIR_PATH'] ?? '').trim();
  if (path === '') throw new Error('OPS_KEYPAIR_PATH is not set');
  let secret: Uint8Array;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8').trim());
    if (!Array.isArray(parsed)) throw new Error('not a byte array');
    secret = Uint8Array.from(parsed as number[]);
  } catch {
    throw new Error('failed to read a JSON byte-array keypair from $OPS_KEYPAIR_PATH');
  }
  return Keypair.fromSecretKey(secret);
}

export function formatRebateReport(cfg: KeeperConfig, summary: RebateSummary): string {
  const sol = (v: bigint): string => (Number(v) / 1e9).toFixed(9);
  const rebate = cfg.constants.split.rebate;
  const lines: string[] = [];
  lines.push('Rebate ledger');
  lines.push(
    rebate.enabled
      ? `  policy: ENABLED — above $${rebate.coinMcapThresholdUsd.toLocaleString('en-US')} mcap, ops keeps ` +
        `${rebate.opsRetainedBpsAboveThreshold} of its ${cfg.opsBps} bps and rebates the rest to BULL`
      : `  policy: DISABLED in config/constants.json — flat ${cfg.bullBps}/${cfg.opsBps} bps, nothing is owed or advertised`,
  );
  lines.push(`  accrual events : ${summary.accrued.length}`);
  lines.push(`  accrued total  : ${sol(summary.totalAccruedLamports)} SOL`);
  lines.push(`  paid total     : ${sol(summary.totalPaidLamports)} SOL`);
  lines.push(`  outstanding    : ${sol(summary.totalUnpaidLamports)} SOL`);
  if (summary.perMint.size > 0) {
    lines.push('  by mint:');
    const rows = [...summary.perMint.entries()].sort((a, b) => (b[1].unpaid > a[1].unpaid ? 1 : -1));
    for (const [mint, row] of rows) {
      lines.push(`    ${mint}  accrued ${sol(row.accrued)} SOL  outstanding ${sol(row.unpaid)} SOL  (${row.count} distributions)`);
    }
  }
  return lines.join('\n');
}

/**
 * Report, and optionally settle, outstanding rebates.
 *
 * Settlement is refused unless: --send was passed, DRY_RUN is off, the ops
 * wallet placeholder has been replaced, and OPS_KEYPAIR_PATH holds that exact
 * wallet's key.
 */
export async function runRebates(
  connection: Connection,
  cfg: KeeperConfig,
  ledger: Ledger,
  opts: { send: boolean },
): Promise<void> {
  const summary = summarizeRebates(ledger);
  console.log(formatRebateReport(cfg, summary));

  if (!opts.send) {
    if (summary.totalUnpaidLamports > 0n) {
      console.log('\nRun `npm run rebates -- --send` (with OPS_KEYPAIR_PATH set and DRY_RUN=false) to settle.');
    }
    return;
  }

  if (summary.totalUnpaidLamports === 0n) {
    console.log('\nNothing outstanding — no rebate transaction to send.');
    return;
  }
  if (cfg.dryRun) {
    console.log(
      `\n[dry-run] would send ${Number(summary.totalUnpaidLamports) / 1e9} SOL from the ops wallet to ` +
        `${cfg.bull.toBase58()} settling ${summary.unpaid.length} accrual(s). Set DRY_RUN=false to actually send.`,
    );
    return;
  }
  if (cfg.ops === null) {
    throw new Error(`cannot settle rebates while constants.wallets.ops is "${OPS_PLACEHOLDER}"`);
  }

  const opsSigner = loadOpsKeypair();
  if (!opsSigner.publicKey.equals(cfg.ops)) {
    throw new Error(
      `$OPS_KEYPAIR_PATH holds ${opsSigner.publicKey.toBase58()}, but constants.wallets.ops is ${cfg.ops.toBase58()}`,
    );
  }

  const lamports = summary.totalUnpaidLamports;
  const { tx, lastValidBlockHeight } = await buildV0Tx(connection, opsSigner.publicKey, [
    SystemProgram.transfer({
      fromPubkey: opsSigner.publicKey,
      toPubkey: cfg.bull,
      lamports,
    }),
  ]);
  const sig = await signAndSend(connection, tx, [opsSigner]);
  const outcome = await awaitOutcome(connection, sig, lastValidBlockHeight);
  if (outcome !== 'confirmed') {
    log.error(`rebate transfer ${sig} ended as "${outcome}" — NOT recording it as paid; re-run to retry`);
    return;
  }

  const paid: RebatePaidEvent = {
    type: 'rebate_paid',
    ts: nowIso(),
    sig,
    lamports: lamports.toString(),
    settles: summary.unpaid.map((a) => a.sig),
    dryRun: false,
  };
  ledger.append(paid);
  console.log(`\nSettled ${Number(lamports) / 1e9} SOL to ${cfg.bull.toBase58()} in ${sig}`);
}
