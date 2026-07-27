import { Connection } from '@solana/web3.js';
import { KILLSWITCH_PATH, killswitchEngaged, type KeeperConfig } from './config.js';
import { ansemAta, fetchSupplyRaw, readAtaBalanceRaw } from './burn.js';
import type { Ledger } from './ledger.js';
import { formatRebateReport, summarizeRebates } from './rebates.js';
import type { BurnEvent, CrankEvent, InflowEvent, SwapEvent } from './types.js';

function fmtToken(raw: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = raw / d;
  const frac = (raw % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? whole.toLocaleString('en-US') : `${whole.toLocaleString('en-US')}.${frac}`;
}

/**
 * Human-readable summary of the ledger + live state.
 *
 * The burn counter here is the sum of OUR burn instructions only. Tokens burned
 * by other parties before launch are shown separately as "not ours" and are
 * never folded into the headline number.
 */
export async function printStatus(
  cfg: KeeperConfig,
  ledger: Ledger,
  connection: Connection | null,
): Promise<void> {
  const events = ledger.readAll();
  const inflows = events.filter((e): e is InflowEvent => e.type === 'inflow');
  const cranks = events.filter((e): e is CrankEvent => e.type === 'crank');
  const swaps = events.filter((e): e is SwapEvent => e.type === 'swap' && !e.dryRun);
  const burns = events.filter((e): e is BurnEvent => e.type === 'burn' && !e.dryRun);

  const inflowTotal = inflows.reduce((a, e) => a + BigInt(e.lamports), 0n);
  const swapTotalIn = swaps.reduce((a, e) => a + BigInt(e.inLamports), 0n);
  const burnedRaw = burns.reduce((a, e) => a + BigInt(e.amountRaw), 0n);

  const lines: string[] = [];
  lines.push('bullscreener keeper — status');
  lines.push('');
  lines.push(`  mode           : ${cfg.dryRun ? 'DRY RUN (nothing is signed or sent)' : 'LIVE'}`);
  if (cfg.dryRunForced) {
    lines.push('                   (DRY_RUN was forced on because KEYPAIR_PATH is unset)');
  }
  lines.push(`  rpc            : ${cfg.rpcUrl}`);
  lines.push(`  bull wallet    : ${cfg.bull.toBase58()}`);
  lines.push(`  ops wallet     : ${cfg.ops?.toBase58() ?? 'NOT SET (placeholder — live mode is blocked)'}`);
  lines.push(`  ansem mint     : ${cfg.ansemMint.toBase58()} (Token-2022)`);
  lines.push(`  ansem ata      : ${ansemAta(cfg, cfg.bull).toBase58()}`);
  lines.push(`  ledger         : ${ledger.file}`);
  lines.push(`  killswitch     : ${killswitchEngaged() ? `ENGAGED (${KILLSWITCH_PATH})` : 'not engaged'}`);
  lines.push('');
  lines.push('Ledger');
  lines.push(`  inflows        : ${inflows.length} events, ${(Number(inflowTotal) / 1e9).toFixed(6)} SOL`);
  lines.push(`  cranks         : ${cranks.length} distributions (${cranks.filter((c) => c.ownCrank).length} cranked by us)`);
  lines.push(`  swaps          : ${swaps.length}, ${(Number(swapTotalIn) / 1e9).toFixed(6)} SOL spent`);
  lines.push(`  burns (OURS)   : ${burns.length}, ${fmtToken(burnedRaw, cfg.ansemDecimals)} ${cfg.constants.ansem.symbol}`);

  const open = ledger.openCycle();
  lines.push('');
  lines.push('Cycle');
  if (open === null) {
    lines.push('  no open cycle');
  } else {
    lines.push(`  id             : ${open.cycleId}`);
    lines.push(`  state          : ${open.state}`);
    lines.push(`  planned        : ${(Number(open.planLamports) / 1e9).toFixed(6)} SOL`);
    if (open.swapSig) lines.push(`  swap sig       : ${open.swapSig}`);
    if (open.burnSig) lines.push(`  burn sig       : ${open.burnSig}`);
    if (open.reason) lines.push(`  note           : ${open.reason}`);
    lines.push(`  updated        : ${open.updatedAt}`);
  }

  if (connection !== null) {
    lines.push('');
    lines.push('Chain');
    try {
      const balance = await connection.getBalance(cfg.bull, 'confirmed');
      lines.push(`  bull balance   : ${(balance / 1e9).toFixed(6)} SOL (reserve ${cfg.constants.keeper.reserveSol}, trigger ${cfg.constants.keeper.triggerSol})`);
    } catch (err) {
      lines.push(`  bull balance   : unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
    try {
      const held = await readAtaBalanceRaw(connection, cfg, cfg.bull);
      lines.push(`  unburned ANSEM : ${fmtToken(held, cfg.ansemDecimals)}`);
    } catch {
      lines.push('  unburned ANSEM : unavailable');
    }
    const supply = await fetchSupplyRaw(connection, cfg);
    if (supply !== null) {
      const launch = BigInt(cfg.constants.ansem.launchSupplyRaw);
      const everBurned = launch > supply ? launch - supply : 0n;
      const notOurs = everBurned > burnedRaw ? everBurned - burnedRaw : 0n;
      lines.push(`  supply now     : ${fmtToken(supply, cfg.ansemDecimals)}`);
      lines.push(`  burned by all  : ${fmtToken(everBurned, cfg.ansemDecimals)} (launch supply minus current)`);
      lines.push(`  ... not ours   : ${fmtToken(notOurs, cfg.ansemDecimals)} — pre-existing/third-party burns, never claimed`);
    }
  }

  lines.push('');
  lines.push(formatRebateReport(cfg, summarizeRebates(ledger)));
  console.log(lines.join('\n'));
}
