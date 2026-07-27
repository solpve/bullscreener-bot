import { utils } from '@coral-xyz/anchor';
import { Connection, Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import type { KeeperConfig } from './config.js';
import { burnCheckedIx, ensureAta, fetchSupplyRaw, readAtaBalanceRaw } from './burn.js';
import { buildSwapTransaction, prepareSwap, SwapAbort } from './jupiter.js';
import { Ledger, newCycleId, nowIso } from './ledger.js';
import { log } from './logger.js';
import { withRetry } from './rpc.js';
import { checkTrigger, fetchLamports } from './trigger.js';
import { awaitOutcome, buildV0Tx } from './tx.js';
import type { BurnEvent, CycleRecord, OpsFeeEvent, SwapEvent } from './types.js';

/**
 * Buyback cycle driver:
 * PENDING -> OPS_SENT -> SWAP_SENT -> SWAP_CONFIRMED -> BURN_SENT -> DONE.
 *
 * The lamports a cycle processes are split once, at the front:
 * `opsLamports = floor(planLamports * opsFee.bps / 10000)` is transferred to the
 * ops wallet as a plain SystemProgram transfer, and the remaining
 * `swapLamports = planLamports - opsLamports` is what gets swapped to ANSEM and
 * burned. The ops fee is NOT protocol-enforced and nothing here may claim it is:
 * it is a disclosed cut taken by this (open-source) keeper, and every one of
 * them is an ordinary on-chain transfer anyone can look up.
 *
 * The invariant that matters: a transaction signature is written to the ledger
 * BEFORE the transaction is broadcast, and a stored signature is always resolved
 * with getSignatureStatuses before anything else happens. A blockhash expires in
 * ~60-90s; a naive "retry on timeout" would pay ops twice, or buy twice with the
 * same SOL.
 *
 * DRY_RUN never writes cycle/ops_fee/swap/burn events — it logs intent only, so
 * the append-only ledger never contains a transaction that did not happen.
 */

export interface CycleDeps {
  connection: Connection;
  cfg: KeeperConfig;
  ledger: Ledger;
  signer: Keypair | null;
  /** how long a single pass waits on an in-flight signature (default 90s) */
  waitTimeoutMs?: number;
  /** poll interval while waiting (default 3s) */
  waitPollMs?: number;
}

function waitOpts(deps: CycleDeps): { timeoutMs: number; pollMs: number } {
  return { timeoutMs: deps.waitTimeoutMs ?? 90_000, pollMs: deps.waitPollMs ?? 3_000 };
}

export class SignerMismatchError extends Error {}

/**
 * Slack the balance guard allows once this cycle has already paid a transaction
 * fee out of the BULL wallet.
 *
 * The ops-fee transfer is a bare SystemProgram transfer (base fee 5,000 lamports,
 * no priority fee), so by the time the swap is built the wallet is short of
 * `swapLamports + reserve` by exactly that fee. Paying network fees is what the
 * reserve is *for*; without this allowance every cycle whose plan is the full
 * spendable balance — i.e. the normal case — would abort immediately after
 * paying ops. 0.001 SOL is ~200x the base fee and 2% of keeper.reserveSol.
 */
export const FEE_ALLOWANCE_LAMPORTS = 1_000_000n;

/**
 * Hard backstop: driving the cycle state machine is never a read-only operation.
 *
 * Every state either signs and broadcasts a transaction, or writes a ledger
 * event asserting that one landed. Both are lies in DRY_RUN. runBuybackPass
 * already refuses to resume in DRY_RUN, and requireBullSigner catches the
 * signing paths, but the *resolve* paths (OPS_SENT / SWAP_SENT / BURN_SENT) do
 * not sign — so they need this guard to be covered too. This is the exact class
 * of bug that shipped here once already: a resume path escaping dry run.
 */
function assertLiveMode(deps: CycleDeps): void {
  if (deps.cfg.dryRun) {
    throw new SignerMismatchError('DRY_RUN is on — refusing to drive the cycle state machine');
  }
}

function requireBullSigner(deps: CycleDeps): Keypair {
  // Hard backstop. runBuybackPass already refuses to drive the state machine in
  // DRY_RUN; if any future path gets here anyway we stop rather than sign.
  assertLiveMode(deps);
  if (deps.signer === null) throw new SignerMismatchError('no signer loaded');
  if (!deps.signer.publicKey.equals(deps.cfg.bull)) {
    throw new SignerMismatchError(
      `signer ${deps.signer.publicKey.toBase58()} is not the BULL wallet ${deps.cfg.bull.toBase58()}; ` +
        'refusing to run buyback cycles',
    );
  }
  return deps.signer;
}

export interface CycleAmounts {
  /** the disclosed ops fee for this cycle, floor()ed to whole lamports */
  opsLamports: bigint;
  /** what actually gets swapped to ANSEM and burned */
  swapLamports: bigint;
}

/**
 * Split one cycle's processed lamports into the ops cut and the swap amount.
 *
 * Pure, integer-only, and exact: `opsLamports + swapLamports === processed` for
 * every input, because the swap amount is defined as the remainder rather than
 * computed independently. BigInt division truncates toward zero and both
 * operands are non-negative, so this is a floor — the cut can only ever round
 * DOWN, never up.
 */
export function splitCycleAmounts(processedLamports: bigint, opsBps: number): CycleAmounts {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.trunc(opsBps))));
  const processed = processedLamports > 0n ? processedLamports : 0n;
  const opsLamports = (processed * bps) / 10_000n;
  return { opsLamports, swapLamports: processed - opsLamports };
}

/**
 * The amounts a cycle is actually working with.
 *
 * Once the ops transfer has been persisted the stored numbers win, so a cycle
 * resumed after `opsFee.bps` changed in constants.json still reconciles against
 * the transfer that was really sent.
 */
function cycleAmounts(cycle: CycleRecord, cfg: KeeperConfig): CycleAmounts {
  if (cycle.opsLamports !== undefined) {
    return {
      opsLamports: cycle.opsLamports,
      swapLamports: cycle.swapLamports ?? cycle.planLamports - cycle.opsLamports,
    };
  }
  return splitCycleAmounts(cycle.planLamports, cfg.opsBps);
}

function signatureOf(tx: VersionedTransaction): string {
  const sig = tx.signatures[0];
  if (!sig) throw new Error('transaction has no signature after signing');
  return utils.bytes.bs58.encode(Buffer.from(sig));
}

/** Actual ANSEM credited to the BULL ATA by a confirmed swap, from tx meta. */
async function actualSwapOut(deps: CycleDeps, signature: string): Promise<bigint | null> {
  try {
    const tx = await withRetry('getTransaction(swap)', () =>
      deps.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (tx === null) return null;
    const mint = deps.cfg.constants.ansem.mint;
    const owner = deps.cfg.bull.toBase58();
    type TokenBalance = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
    const pick = (list: readonly TokenBalance[] | null | undefined): bigint => {
      for (const b of list ?? []) {
        if (b.mint === mint && b.owner === owner) return BigInt(b.uiTokenAmount.amount);
      }
      return 0n;
    };
    const delta = pick(tx.meta?.postTokenBalances) - pick(tx.meta?.preTokenBalances);
    return delta > 0n ? delta : null;
  } catch (err) {
    log.warn('could not read swap token delta', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Take the disclosed operations fee, before anything is swapped.
 *
 * A plain SystemProgram transfer from BULL to the ops wallet. This is the whole
 * mechanism behind the public claim: the fee is not enforced by any program, it
 * is taken by published code and left visible on chain, one transfer per cycle.
 */
async function sendOpsCut(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  const signer = requireBullSigner(deps);
  const { cfg, connection, ledger } = deps;
  const { opsLamports, swapLamports } = splitCycleAmounts(cycle.planLamports, cfg.opsBps);

  // Nothing to pay: skip straight to the swap rather than sending a 0-lamport
  // transfer (which would burn a network fee to move nothing).
  if (opsLamports === 0n) {
    log.info(
      `cycle ${cycle.cycleId.slice(0, 8)}: ops fee rounds to 0 lamports at ${cfg.opsBps} bps — no transfer, swapping the full ${cycle.planLamports}`,
    );
    await sendSwap(deps, cycle);
    return;
  }

  if (cfg.ops === null) {
    // Unreachable in live mode (loadConfig refuses to start), but we would
    // rather abort the cycle than swap SOL the ops fee was never taken from.
    ledger.transition('PENDING', {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      reason: 'ops wallet is not configured — refusing to run a cycle whose fee has nowhere to go',
      dryRun: false,
    });
    return;
  }

  // Balance-derived safety net, checked against the FULL plan: the swap that
  // follows needs its share too, and no fee has left the wallet yet.
  const balance = await fetchLamports(connection, cfg.bull);
  if (balance < cycle.planLamports + cfg.reserveLamports) {
    ledger.transition('PENDING', {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      reason: `balance ${balance} < plan ${cycle.planLamports} + reserve ${cfg.reserveLamports}`,
      dryRun: false,
    });
    return;
  }

  const { tx, lastValidBlockHeight } = await buildV0Tx(connection, signer.publicKey, [
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: cfg.ops,
      lamports: opsLamports,
    }),
  ]);
  tx.sign([signer]);
  const sig = signatureOf(tx);

  // Persist BEFORE broadcasting, same discipline as the swap and the burn.
  ledger.transition('PENDING', {
    cycleId: cycle.cycleId,
    state: 'OPS_SENT',
    planLamports: cycle.planLamports.toString(),
    opsSig: sig,
    opsLastValidBlockHeight: lastValidBlockHeight,
    opsLamports: opsLamports.toString(),
    swapLamports: swapLamports.toString(),
    dryRun: false,
  });

  await withRetry('sendRawTransaction(opsFee)', () =>
    connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    }),
  );
  log.info(
    `cycle ${cycle.cycleId.slice(0, 8)}: ops fee ${opsLamports} lamports (${cfg.opsBps} bps of ${cycle.planLamports}) -> ${cfg.ops.toBase58()} in ${sig}`,
  );
}

/**
 * Resolve the ops transfer, then — and only then — send the swap.
 *
 * The transfer is never re-sent. Confirmed moves the cycle forward; failed or
 * expired aborts it, which is safe because in both cases the lamports are still
 * in the BULL wallet and the balance trigger simply re-fires.
 */
async function resolveOpsCut(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  assertLiveMode(deps);
  const { cfg, connection, ledger } = deps;
  if (cycle.opsSig === undefined) {
    ledger.transition('OPS_SENT', {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      reason: 'OPS_SENT without a stored signature (corrupt ledger)',
      dryRun: false,
    });
    return;
  }

  const outcome = await awaitOutcome(connection, cycle.opsSig, cycle.opsLastValidBlockHeight, waitOpts(deps));
  if (outcome === 'pending') {
    log.info(`cycle ${cycle.cycleId.slice(0, 8)}: ops fee ${cycle.opsSig} still pending`);
    return;
  }
  if (outcome === 'failed' || outcome === 'expired') {
    ledger.transition('OPS_SENT', {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      reason: `ops fee transfer ${outcome}; the SOL never moved — the balance trigger will re-fire`,
      dryRun: false,
    });
    return;
  }

  // Dedupe by signature: a crash between this append and the swap transition
  // would otherwise replay it and double-count the fee we report having taken.
  const sig = cycle.opsSig;
  const { opsLamports } = cycleAmounts(cycle, cfg);
  if (!ledger.has((e) => e.type === 'ops_fee' && e.sig === sig)) {
    const opsEvent: OpsFeeEvent = {
      type: 'ops_fee',
      ts: nowIso(),
      cycleId: cycle.cycleId,
      sig,
      lamports: opsLamports.toString(),
      processedLamports: cycle.planLamports.toString(),
      bps: cfg.opsBps,
      recipient: cfg.ops?.toBase58() ?? cfg.constants.opsFee.recipient,
      dryRun: false,
    };
    ledger.append(opsEvent);
  }

  await sendSwap(deps, cycle);
}

async function sendSwap(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  const signer = requireBullSigner(deps);
  const { cfg, connection, ledger } = deps;
  // PENDING (ops cut rounded to zero) or OPS_SENT (cut confirmed). Either way
  // the transition we are about to write starts from where the cycle is now.
  const from = cycle.state;
  const { opsLamports, swapLamports } = cycleAmounts(cycle, cfg);

  // Balance-derived second safety net: never swap SOL we no longer have. If the
  // ops transfer already landed it also spent a base fee, and the reserve is
  // allowed to absorb that — see FEE_ALLOWANCE_LAMPORTS.
  const paidOpsFee = cycle.opsSig !== undefined;
  const reserveFloor =
    paidOpsFee && cfg.reserveLamports > FEE_ALLOWANCE_LAMPORTS
      ? cfg.reserveLamports - FEE_ALLOWANCE_LAMPORTS
      : paidOpsFee
        ? 0n
        : cfg.reserveLamports;
  const balance = await fetchLamports(connection, cfg.bull);
  if (balance < swapLamports + reserveFloor) {
    ledger.transition(from, {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      opsLamports: opsLamports.toString(),
      swapLamports: swapLamports.toString(),
      reason: `balance ${balance} < swap ${swapLamports} + reserve ${reserveFloor}`,
      dryRun: false,
    });
    return;
  }

  let prepared;
  try {
    prepared = await prepareSwap(cfg, swapLamports);
  } catch (err) {
    const reason = err instanceof SwapAbort ? `circuit breaker: ${err.message}` : `quote failed: ${String(err)}`;
    ledger.transition(from, {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      opsLamports: opsLamports.toString(),
      swapLamports: swapLamports.toString(),
      reason,
      dryRun: false,
    });
    log.warn(`cycle ${cycle.cycleId.slice(0, 8)} aborted before sending: ${reason}`);
    return;
  }

  const built = await buildSwapTransaction(cfg, prepared.quote, signer.publicKey.toBase58());
  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
  tx.sign([signer]);
  const sig = signatureOf(tx);

  // Persist BEFORE broadcasting. A crash after this line is recoverable; a crash
  // before it would leave an unknown signature in flight.
  ledger.transition(from, {
    cycleId: cycle.cycleId,
    state: 'SWAP_SENT',
    planLamports: cycle.planLamports.toString(),
    opsLamports: opsLamports.toString(),
    swapLamports: swapLamports.toString(),
    swapSig: sig,
    swapLastValidBlockHeight: built.lastValidBlockHeight,
    swapOutRaw: prepared.outRaw.toString(),
    priceImpactPct: prepared.breakers.priceImpactPct,
    dryRun: false,
  });

  await withRetry('sendRawTransaction(swap)', () =>
    connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    }),
  );
  log.info(`cycle ${cycle.cycleId.slice(0, 8)}: swap ${sig} broadcast`);
}

async function resolveSwap(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  assertLiveMode(deps);
  const { cfg, connection, ledger } = deps;
  if (cycle.swapSig === undefined) {
    ledger.transition('SWAP_SENT', {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      reason: 'SWAP_SENT without a stored signature (corrupt ledger)',
      dryRun: false,
    });
    return;
  }

  // Waits, never resends. Timing out just leaves the cycle in SWAP_SENT for the
  // next pass to resolve.
  const outcome = await awaitOutcome(connection, cycle.swapSig, cycle.swapLastValidBlockHeight, waitOpts(deps));
  if (outcome === 'pending') {
    log.info(`cycle ${cycle.cycleId.slice(0, 8)}: swap ${cycle.swapSig} still pending`);
    return;
  }
  if (outcome === 'failed' || outcome === 'expired') {
    ledger.transition('SWAP_SENT', {
      cycleId: cycle.cycleId,
      state: 'ABORTED',
      planLamports: cycle.planLamports.toString(),
      reason: `swap ${outcome}; SOL was not spent — the balance trigger will re-fire`,
      dryRun: false,
    });
    return;
  }

  const actual = await actualSwapOut(deps, cycle.swapSig);
  const outRaw = actual ?? cycle.swapOutRaw ?? 0n;
  // Dedupe by signature: a crash between the append and the transition below
  // would otherwise replay this and double-count the swap.
  const sig = cycle.swapSig;
  if (!ledger.has((e) => e.type === 'swap' && e.sig === sig)) {
    const swapEvent: SwapEvent = {
      type: 'swap',
      ts: nowIso(),
      cycleId: cycle.cycleId,
      sig,
      inLamports: cycle.planLamports.toString(),
      outRaw: outRaw.toString(),
      priceImpact: cycle.priceImpactPct ?? 0,
      dryRun: false,
    };
    ledger.append(swapEvent);
  }
  ledger.transition('SWAP_SENT', {
    cycleId: cycle.cycleId,
    state: 'SWAP_CONFIRMED',
    planLamports: cycle.planLamports.toString(),
    swapOutRaw: outRaw.toString(),
    reason: actual === null ? 'confirmed (out amount from quote)' : undefined,
    dryRun: false,
  });
}

async function sendBurn(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  const signer = requireBullSigner(deps);
  const { cfg, connection, ledger } = deps;

  // Burn the FULL ATA balance, always. This is what makes the burn idempotent
  // and self-healing: leftovers from an aborted cycle get swept here.
  const amount = await readAtaBalanceRaw(connection, cfg, cfg.bull);
  if (amount === 0n) {
    ledger.transition('SWAP_CONFIRMED', {
      cycleId: cycle.cycleId,
      state: 'DONE',
      planLamports: cycle.planLamports.toString(),
      reason: 'ATA balance is 0 — nothing to burn',
      dryRun: false,
    });
    return;
  }

  const { tx, lastValidBlockHeight } = await buildV0Tx(connection, signer.publicKey, [
    burnCheckedIx(cfg, cfg.bull, amount),
  ]);
  tx.sign([signer]);
  const sig = signatureOf(tx);

  ledger.transition('SWAP_CONFIRMED', {
    cycleId: cycle.cycleId,
    state: 'BURN_SENT',
    planLamports: cycle.planLamports.toString(),
    burnSig: sig,
    burnLastValidBlockHeight: lastValidBlockHeight,
    burnAmountRaw: amount.toString(),
    dryRun: false,
  });

  await withRetry('sendRawTransaction(burn)', () =>
    connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    }),
  );
  log.info(`cycle ${cycle.cycleId.slice(0, 8)}: burn ${sig} broadcast for ${amount} raw ANSEM`);
  // Resolution happens on the next loop turn via resolveBurn(), so the stored
  // signature is always the thing we check — never an in-memory assumption.
}

async function finishBurn(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  const { cfg, connection, ledger } = deps;
  const sig = cycle.burnSig;
  // Never record a burn we cannot point at on chain: the public burn counter
  // sums these events. (Unreachable — resolveBurn checks burnSig first.)
  if (sig === undefined) throw new Error('finishBurn called without a burn signature');
  // Dedupe by signature: a crash between the append and the transition below
  // would otherwise replay this and inflate the burn total.
  if (!ledger.has((e) => e.type === 'burn' && e.sig === sig)) {
    const supplyAfter = await fetchSupplyRaw(connection, cfg);
    const burnEvent: BurnEvent = {
      type: 'burn',
      ts: nowIso(),
      cycleId: cycle.cycleId,
      sig,
      amountRaw: (cycle.burnAmountRaw ?? 0n).toString(),
      supplyAfter: supplyAfter === null ? null : supplyAfter.toString(),
      dryRun: false,
    };
    ledger.append(burnEvent);
  }
  ledger.transition('BURN_SENT', {
    cycleId: cycle.cycleId,
    state: 'DONE',
    planLamports: cycle.planLamports.toString(),
    dryRun: false,
  });
  log.info(`cycle ${cycle.cycleId.slice(0, 8)}: burned ${cycle.burnAmountRaw ?? 0n} raw ANSEM`);
}

async function resolveBurn(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  assertLiveMode(deps);
  const { cfg, connection, ledger } = deps;
  if (cycle.burnSig === undefined) {
    ledger.transition('BURN_SENT', {
      cycleId: cycle.cycleId,
      state: 'SWAP_CONFIRMED',
      planLamports: cycle.planLamports.toString(),
      reason: 'BURN_SENT without a stored signature; re-burning full ATA balance',
      dryRun: false,
    });
    return;
  }

  const outcome = await awaitOutcome(connection, cycle.burnSig, cycle.burnLastValidBlockHeight, waitOpts(deps));
  if (outcome === 'confirmed') {
    await finishBurn(deps, cycle);
    return;
  }
  if (outcome === 'pending') {
    log.info(`cycle ${cycle.cycleId.slice(0, 8)}: burn ${cycle.burnSig} still pending`);
    return;
  }

  // failed | expired: re-burning is safe because we always burn the full ATA
  // balance — if the burn actually landed there is simply nothing left.
  const remaining = await readAtaBalanceRaw(connection, cfg, cfg.bull);
  if (remaining === 0n) {
    ledger.transition('BURN_SENT', {
      cycleId: cycle.cycleId,
      state: 'DONE',
      planLamports: cycle.planLamports.toString(),
      reason: `burn ${outcome} but ATA is empty — treating as complete`,
      dryRun: false,
    });
    return;
  }
  ledger.transition('BURN_SENT', {
    cycleId: cycle.cycleId,
    state: 'SWAP_CONFIRMED',
    planLamports: cycle.planLamports.toString(),
    reason: `burn ${outcome}; ${remaining} raw ANSEM still held — retrying`,
    dryRun: false,
  });
}

/** Advance the single open cycle by at most one externally-visible step. */
export async function advanceCycle(deps: CycleDeps, cycle: CycleRecord): Promise<void> {
  switch (cycle.state) {
    case 'PENDING':
      await sendOpsCut(deps, cycle);
      return;
    case 'OPS_SENT':
      await resolveOpsCut(deps, cycle);
      return;
    case 'SWAP_SENT':
      await resolveSwap(deps, cycle);
      return;
    case 'SWAP_CONFIRMED':
      await sendBurn(deps, cycle);
      return;
    case 'BURN_SENT':
      await resolveBurn(deps, cycle);
      return;
    case 'DONE':
    case 'ABORTED':
      return;
  }
}

/**
 * Advance the open cycle until it finishes or stops making progress (i.e. it is
 * waiting on the chain). Bounded so a bug cannot spin forever.
 */
async function driveOpenCycle(deps: CycleDeps): Promise<void> {
  for (let guard = 0; guard < 10; guard++) {
    const open = deps.ledger.openCycle();
    if (open === null) return;
    const marker = `${open.state}:${open.updatedAt}`;
    await advanceCycle(deps, open);
    const after = deps.ledger.openCycle();
    if (after === null) return;
    if (`${after.state}:${after.updatedAt}` === marker) return; // no progress; waiting on chain
  }
  log.warn('cycle driver hit its iteration guard; will continue next pass');
}

async function dryRunPass(deps: CycleDeps): Promise<void> {
  const { cfg, connection } = deps;
  const { balanceLamports, plan } = await checkTrigger(connection, cfg);
  if (plan.chunks.length === 0) {
    log.info(
      `[dry-run] BULL balance ${Number(balanceLamports) / 1e9} SOL, available ${Number(plan.availableLamports) / 1e9} SOL` +
        ` — below the ${cfg.constants.keeper.triggerSol} SOL trigger; no cycle would start`,
    );
    return;
  }
  log.info(
    `[dry-run] would run ${plan.chunks.length} buyback cycle(s): ${plan.chunks.map((c) => `${Number(c) / 1e9} SOL`).join(', ')}`,
  );
  for (const chunk of plan.chunks) {
    try {
      const { opsLamports, swapLamports } = splitCycleAmounts(chunk, cfg.opsBps);
      const prepared = await prepareSwap(cfg, swapLamports);
      log.info(
        `[dry-run] would transfer ${Number(opsLamports) / 1e9} SOL ops fee (${cfg.opsBps} bps) -> ops wallet, ` +
          `then swap ${Number(swapLamports) / 1e9} SOL -> ~${Number(prepared.outRaw) / 10 ** cfg.ansemDecimals} ` +
          `${cfg.constants.ansem.symbol}, then burnChecked the FULL Token-2022 ATA balance (never closing the ATA)`,
      );
    } catch (err) {
      log.warn(`[dry-run] swap would be refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * One buyback pass.
 *
 * Order matters: resume first (an in-flight signature must be resolved before
 * anything else), then sweep orphaned tokens, then look at the balance. The
 * balance is re-read for every chunk, so a large inflow drains over several
 * capped swaps within a single pass.
 *
 * The DRY_RUN check comes FIRST, before the resume step. Resuming is not a
 * read-only operation: an open cycle in PENDING/SWAP_CONFIRMED is advanced by
 * signing and broadcasting a swap or a burn. Driving the state machine in
 * DRY_RUN would therefore send real transactions (with a signer loaded) or throw
 * SignerMismatchError (without one) — both wrong.
 */
export async function runBuybackPass(
  deps: CycleDeps,
  opts: { maxCycles?: number } = {},
): Promise<void> {
  const { cfg, connection, ledger } = deps;
  const maxCycles = opts.maxCycles ?? 3;

  if (cfg.dryRun || deps.signer === null) {
    const open = ledger.openCycle();
    if (open !== null) {
      // Mirror live behaviour: an open cycle blocks new ones. Report it, do not
      // touch it, and do not write a single ledger event.
      log.warn(
        `[dry-run] cycle ${open.cycleId.slice(0, 8)} is open in ${open.state}` +
          `${open.swapSig ? ` (swap ${open.swapSig})` : ''}${open.burnSig ? ` (burn ${open.burnSig})` : ''}` +
          ' — a live run would resolve it first; nothing is being signed, sent or recorded',
      );
      return;
    }
    await dryRunPass(deps);
    return;
  }

  requireBullSigner(deps);

  // 1. Resume.
  await driveOpenCycle(deps);
  if (ledger.openCycle() !== null) return; // still in flight

  // 2. Orphan sweep — tokens sitting in the ATA with no open cycle (the swap
  //    landed but its cycle was aborted). Burn them before buying more.
  const orphan = await readAtaBalanceRaw(connection, cfg, cfg.bull);
  if (orphan > 0n) {
    log.warn(`sweeping ${orphan} raw ANSEM left in the ATA by a previous cycle`);
    ledger.transition(null, {
      cycleId: newCycleId(),
      state: 'SWAP_CONFIRMED',
      planLamports: '0',
      swapOutRaw: orphan.toString(),
      reason: 'orphan sweep',
      dryRun: false,
    });
    await driveOpenCycle(deps);
    if (ledger.openCycle() !== null) return;
  }

  // 3. New cycles from the balance trigger.
  for (let i = 0; i < maxCycles; i++) {
    const { plan } = await checkTrigger(connection, cfg);
    const chunk = plan.chunks[0];
    if (chunk === undefined) return;

    await ensureAta(connection, cfg, cfg.bull, deps.signer);
    ledger.transition(null, {
      cycleId: newCycleId(),
      state: 'PENDING',
      planLamports: chunk.toString(),
      reason: plan.chunks.length > 1 ? `chunk 1 of ${plan.chunks.length} remaining` : undefined,
      dryRun: false,
    });
    await driveOpenCycle(deps);
    if (ledger.openCycle() !== null) return; // waiting on chain
  }
}

/** Pre-create the ANSEM Token-2022 ATA (idempotent). */
export async function initAta(deps: CycleDeps): Promise<void> {
  const { ata, created } = await ensureAta(deps.connection, deps.cfg, deps.cfg.bull, deps.signer);
  log.info(`ANSEM Token-2022 ATA ${ata.toBase58()}${created ? ' (created)' : ''}`);
}
