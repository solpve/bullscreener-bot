import { Connection, PublicKey } from '@solana/web3.js';
import type { KeeperConfig } from './config.js';
import { log } from './logger.js';
import { withRetry } from './rpc.js';

export interface SwapPlan {
  /** balance minus the untouchable reserve, floored at 0 */
  availableLamports: bigint;
  /** ordered swap sizes; empty when nothing should fire */
  chunks: bigint[];
  totalLamports: bigint;
  /** balance is under keeper.reserveAlertSol — the keeper cannot pay fees much longer */
  reserveAlert: boolean;
}

/**
 * Pure trigger arithmetic.
 *
 * Fires when (balance - reserveSol) >= triggerSol. Larger balances are split
 * into chunks of at most maxSolPerSwap; a trailing remainder below triggerSol is
 * left in the wallet for the next cycle rather than swapped at a bad size.
 */
export function planSwaps(balanceLamports: bigint, cfg: KeeperConfig): SwapPlan {
  const available =
    balanceLamports > cfg.reserveLamports ? balanceLamports - cfg.reserveLamports : 0n;
  const chunks: bigint[] = [];
  let remaining = available;
  while (remaining >= cfg.triggerLamports) {
    const chunk = remaining > cfg.maxSolPerSwapLamports ? cfg.maxSolPerSwapLamports : remaining;
    chunks.push(chunk);
    remaining -= chunk;
  }
  return {
    availableLamports: available,
    chunks,
    totalLamports: chunks.reduce((a, b) => a + b, 0n),
    reserveAlert: balanceLamports < cfg.reserveAlertLamports,
  };
}

export async function fetchLamports(
  connection: Connection,
  address: PublicKey,
): Promise<bigint> {
  const balance = await withRetry('getBalance', () => connection.getBalance(address, 'confirmed'));
  return BigInt(balance);
}

export async function checkTrigger(
  connection: Connection,
  cfg: KeeperConfig,
): Promise<{ balanceLamports: bigint; plan: SwapPlan }> {
  const balanceLamports = await fetchLamports(connection, cfg.bull);
  const plan = planSwaps(balanceLamports, cfg);
  if (plan.reserveAlert) {
    log.warn(
      `BULL wallet balance ${Number(balanceLamports) / 1e9} SOL is below the reserve alert threshold ` +
        `${cfg.constants.keeper.reserveAlertSol} SOL — top it up or the keeper will stop paying fees`,
    );
  }
  return { balanceLamports, plan };
}
