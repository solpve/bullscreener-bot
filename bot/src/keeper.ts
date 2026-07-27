import { fetchDistributeEvents, isNativeQuote, recordDistribution, scanInflows } from './attribution.js';
import { killswitchEngaged, type KeeperConfig } from './config.js';
import { crankCoin, prepareCoins } from './crank.js';
import type { CycleDeps } from './cycle.js';
import { runBuybackPass } from './cycle.js';
import { fetchMarketCapUsd } from './dexscreener.js';
import { discoverSharingConfigs } from './discovery.js';
import { log } from './logger.js';
import { sleep } from './rpc.js';

/**
 * Crank every discovered coin once.
 *
 * Errors on one coin never stop the pass — a single broken config must not stop
 * the fee stream for everyone else.
 */
export async function crankPass(deps: CycleDeps, opts: { delayMs?: number } = {}): Promise<void> {
  const { cfg, connection, ledger, signer } = deps;
  const delayMs = opts.delayMs ?? 300;

  const coins = await discoverSharingConfigs(connection, cfg);
  if (coins.length === 0) {
    log.info('crank: no sharing configs route to the BULL wallet yet');
    return;
  }

  const contexts = await prepareCoins(connection, cfg, coins);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const ctx of contexts) {
    const mint = ctx.coin.mint.toBase58();
    try {
      const outcome = await crankCoin(connection, cfg, ctx, signer);
      switch (outcome.status) {
        case 'skipped':
          skipped++;
          log.debug(`crank skip ${mint}: ${outcome.reason}`);
          break;
        case 'error':
          failed++;
          log.warn(`crank error ${mint}: ${outcome.reason}`);
          break;
        case 'dry-run':
          skipped++;
          break;
        case 'sent': {
          sent++;
          if (!outcome.confirmed) {
            // Still only "processed" when we stopped waiting. Recording it now
            // would be a distribution we cannot yet prove landed; the inflow
            // scanner picks the credit up from the chain on a later pass.
            log.warn(`crank ${mint}: ${outcome.sig} not confirmed yet — not recording a distribution`);
            break;
          }
          if (!isNativeQuote(cfg, ctx.quoteMint)) {
            // Fees paid in an SPL quote token never credit the BULL wallet's SOL
            // balance; `distributed` is not lamports and must not enter the ledger.
            log.warn(`crank ${mint}: non-SOL quote ${ctx.quoteMint.toBase58()} — not recording a lamport distribution`);
            break;
          }
          const { events } = await fetchDistributeEvents(connection, outcome.sig);
          const ev = events.find((e) => e.mint.equals(ctx.coin.mint));
          // Fall back to the simulated distributable amount when the event is
          // not retrievable yet; it is tagged so the ledger stays honest.
          const distributed = ev?.distributedLamports ?? outcome.minimum.distributableFees;
          const mcapUsd = await fetchMarketCapUsd(cfg, mint).catch(() => null);
          recordDistribution(ledger, cfg, {
            sig: outcome.sig,
            mint,
            distributedLamports: distributed,
            distributedSource: ev ? 'event' : 'derived',
            ourBps: ctx.coin.ourBps,
            mcapUsd,
            ownCrank: true,
            dryRun: false,
          });
          log.info(`crank sent ${mint}: ${distributed} lamports distributed (${outcome.sig})`);
          break;
        }
      }
    } catch (err) {
      failed++;
      log.warn(`crank threw for ${mint}`, err instanceof Error ? err.message : String(err));
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  log.info(`crank pass done: ${sent} sent, ${skipped} skipped, ${failed} failed of ${contexts.length}`);
}

/** Read-only observation of on-chain inflows. Safe (and useful) in DRY_RUN. */
export async function inflowPass(deps: CycleDeps): Promise<void> {
  try {
    await scanInflows(deps.connection, deps.cfg, deps.ledger);
  } catch (err) {
    log.warn('inflow scan failed', err instanceof Error ? err.message : String(err));
  }
}

/** One full pass: crank -> observe inflows -> buyback/burn. */
export async function runOnce(deps: CycleDeps): Promise<void> {
  if (killswitchEngaged()) {
    log.warn('KILLSWITCH file present — doing nothing');
    return;
  }
  await crankPass(deps);
  await inflowPass(deps);
  await runBuybackPass(deps);
}

export interface LoopHandle {
  stop(): void;
}

/**
 * The keeper loop.
 *
 * Two cadences from constants.keeper: the buyback trigger check runs every
 * pollIntervalSec, the crank every crankIntervalSec. The KILLSWITCH file idles
 * the loop without exiting, so a running keeper can be parked and resumed
 * without a redeploy.
 */
export async function runKeeperLoop(
  deps: CycleDeps,
  opts: { signal?: { aborted: boolean } } = {},
): Promise<void> {
  const cfg: KeeperConfig = deps.cfg;
  const pollMs = cfg.constants.keeper.pollIntervalSec * 1000;
  const crankMs = cfg.constants.keeper.crankIntervalSec * 1000;
  let nextCrankAt = 0;
  let killswitchLogged = false;

  log.info(
    `keeper loop starting (${cfg.dryRun ? 'DRY RUN' : 'LIVE'}): poll ${cfg.constants.keeper.pollIntervalSec}s, crank ${cfg.constants.keeper.crankIntervalSec}s`,
  );

  for (;;) {
    if (opts.signal?.aborted) {
      log.info('keeper loop stopping');
      return;
    }

    if (killswitchEngaged()) {
      if (!killswitchLogged) {
        log.warn('KILLSWITCH file present — idling (remove bot/KILLSWITCH to resume)');
        killswitchLogged = true;
      }
      await sleep(pollMs);
      continue;
    }
    killswitchLogged = false;

    try {
      if (Date.now() >= nextCrankAt) {
        nextCrankAt = Date.now() + crankMs;
        await crankPass(deps);
      }
      await inflowPass(deps);
      await runBuybackPass(deps);
    } catch (err) {
      log.error('keeper pass failed', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    }

    await sleep(pollMs);
  }
}
