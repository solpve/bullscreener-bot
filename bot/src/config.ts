import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Constants } from './types.js';

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BOT_DIR = path.resolve(SRC_DIR, '..');
export const REPO_ROOT = path.resolve(BOT_DIR, '..');
export const CONSTANTS_PATH = path.join(REPO_ROOT, 'config', 'constants.json');
export const STATE_DIR = path.join(BOT_DIR, 'state');
export const LEDGER_PATH = path.join(STATE_DIR, 'ledger.jsonl');
export const CURSOR_PATH = path.join(STATE_DIR, 'inflow-cursor.json');
export const KILLSWITCH_PATH = path.join(BOT_DIR, 'KILLSWITCH');
export const ENV_PATH = path.join(BOT_DIR, '.env');

export const OPS_PLACEHOLDER = 'REPLACE_WITH_OPS_WALLET';
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * The only value `constants.opsFee.enforcement` may hold.
 *
 * The ops fee is taken by THIS keeper, in the open, as a plain SystemProgram
 * transfer. It is not enforced by any program, and the config is not allowed to
 * say otherwise — a different value here would be a trust claim the code cannot
 * back.
 */
export const OPS_FEE_ENFORCEMENT = 'keeper';

/** The flagship (full-send) template: BULL as sole shareholder. Project-lane coins route >= listing.minShareBpsToUs on-chain instead. */
export const SOLE_SHAREHOLDER_BPS = 10_000;

/** Funded mainnet account the pump SDK uses as a simulation payer. */
export const SIMULATION_PAYER = new PublicKey('UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw');

/**
 * Minimal .env loader (no dependency). Existing process.env always wins so an
 * explicitly exported variable cannot be silently overridden by a stale file.
 */
export function loadEnvFile(file = ENV_PATH): void {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function readConstants(file = CONSTANTS_PATH): Constants {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw) as Constants;
}

function solToLamports(sol: number): bigint {
  // Round through a fixed-point string to dodge float drift on e.g. 0.05 SOL.
  return BigInt(Math.round(sol * 1e9));
}

export interface KeeperConfig {
  constants: Constants;
  rpcUrl: string;
  /** undefined => no key available => DRY_RUN forced on */
  keypairPath: string | undefined;
  dryRun: boolean;
  /** true when DRY_RUN was forced on because no KEYPAIR_PATH was provided */
  dryRunForced: boolean;

  bull: PublicKey;
  /** null while constants.wallets.ops is still the placeholder */
  ops: PublicKey | null;
  ansemMint: PublicKey;
  ansemDecimals: number;
  wsolMint: PublicKey;
  pumpProgram: PublicKey;
  pumpAmmProgram: PublicKey;
  pumpFeesProgram: PublicKey;
  token2022Program: PublicKey;

  triggerLamports: bigint;
  reserveLamports: bigint;
  reserveAlertLamports: bigint;
  maxSolPerSwapLamports: bigint;

  /** Flagship-template bps (always 10000). Per-coin routed shares live in DiscoveredCoin.ourBps. */
  bullBps: number;
  /**
   * bps of each cycle's processed lamports this keeper moves to the ops wallet
   * before swapping. NOT an on-chain share of anything: see constants.opsFee.
   */
  opsBps: number;
}

export class ConfigError extends Error {}

/**
 * Validate single-address routing and return the BULL wallet's flagship bps.
 *
 * split.shareholders is the FLAGSHIP (full-route tier) ask: exactly one
 * shareholder, BULL at 10000 bps. Project-tier coins (listing.tiers) commit
 * >= 2000 bps alongside their own wallets — that lives on-chain per coin, not
 * here. A second entry in this template would mean the shipped config no
 * longer describes the flagship commit, so it is a hard error.
 */
function soleShareholderBps(constants: Constants): number {
  const shareholders = constants.split.shareholders;
  if (shareholders.length !== 1) {
    throw new ConfigError(
      'constants.split.shareholders must hold exactly one entry (single-address routing); ' +
        `found ${shareholders.length}`,
    );
  }
  const only = shareholders[0];
  if (only === undefined || only.wallet !== 'bull') {
    throw new ConfigError('constants.split.shareholders[0].wallet must be "bull"');
  }
  if (only.bps !== SOLE_SHAREHOLDER_BPS) {
    throw new ConfigError(
      `constants.split.shareholders[0].bps must be ${SOLE_SHAREHOLDER_BPS} (100% of routed creator fees); ` +
        `found ${only.bps}`,
    );
  }
  return only.bps;
}

/**
 * Guard every claim the constants make about the ops fee.
 *
 * The public copy says the fee is disclosed, taken by open-source code, and
 * visible on-chain every cycle. That is only true while the config says the
 * keeper takes it, the bps is a real percentage, and the payout target is the
 * same wallet the rest of the repo calls "ops".
 */
function assertOpsFeeSane(constants: Constants): void {
  const opsFee = constants.opsFee;
  if (opsFee.enforcement !== OPS_FEE_ENFORCEMENT) {
    throw new ConfigError(
      `constants.opsFee.enforcement must be "${OPS_FEE_ENFORCEMENT}": the fee is taken by this keeper, ` +
        'not by any program, and no other value is a claim the code can back',
    );
  }
  if (!Number.isInteger(opsFee.bps) || opsFee.bps < 0 || opsFee.bps > 10_000) {
    throw new ConfigError(`constants.opsFee.bps must be an integer in [0, 10000]; found ${String(opsFee.bps)}`);
  }
  if (constants.split.rebate.enabled) {
    throw new ConfigError(
      'constants.split.rebate is superseded by single-address routing (it assumed ops was an on-chain ' +
        'shareholder) and must stay disabled; set split.rebate.enabled back to false',
    );
  }
}

/**
 * Build the keeper config.
 *
 * Safety rules encoded here (see bot/README.md "Security notes"):
 *  - DRY_RUN is FORCED true whenever KEYPAIR_PATH is unset.
 *  - DRY_RUN defaults to true even when a keypair is present; going live is an
 *    explicit `DRY_RUN=false`.
 *  - The on-chain split must be exactly one shareholder (BULL at 10000 bps).
 *  - Live mode REFUSES to start while wallets.ops is still the placeholder,
 *    because the keeper would have nowhere to send the disclosed ops fee.
 *  - opsFee.recipient must be the same wallet as wallets.ops, so the payout
 *    target can never drift away from the address the repo documents.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  constantsOverride?: Constants, // test-only: exercise config gates against synthetic constants
): KeeperConfig {
  const constants = constantsOverride ?? readConstants();
  // Flagship-template bps only (always 10000). Real per-coin routed shares
  // live in DiscoveredCoin.ourBps — project-lane coins route 2000–9999.
  const bullBps = soleShareholderBps(constants);
  assertOpsFeeSane(constants);

  const rawKeypairPath = (env['KEYPAIR_PATH'] ?? '').trim();
  const keypairPath = rawKeypairPath === '' ? undefined : rawKeypairPath;

  const rawDryRun = (env['DRY_RUN'] ?? '').trim().toLowerCase();
  const dryRunRequested = rawDryRun === 'false' || rawDryRun === '0' || rawDryRun === 'no' ? false : true;
  const dryRun = keypairPath === undefined ? true : dryRunRequested;
  // "Forced" = dry run is not the operator's choice to reverse. Without a
  // KEYPAIR_PATH, DRY_RUN=false cannot go live, so saying "set DRY_RUN=false to
  // go live" would be a lie regardless of what DRY_RUN currently is.
  const dryRunForced = keypairPath === undefined;

  const opsRaw = constants.wallets.ops;
  const opsIsPlaceholder = opsRaw === OPS_PLACEHOLDER;
  if (!dryRun && opsIsPlaceholder) {
    throw new ConfigError(
      `refusing to start in live mode: config/constants.json wallets.ops is still "${OPS_PLACEHOLDER}". ` +
        'Set the real ops wallet before running live.',
    );
  }
  // The ops fee is a keeper payout target, not a shareholder, so it is spelled
  // out twice in constants.json. Drift between the two would mean the wallet the
  // docs name and the wallet the code pays are different addresses.
  if (constants.opsFee.recipient !== opsRaw) {
    throw new ConfigError(
      'constants.opsFee.recipient must be the same wallet as constants.wallets.ops; they have drifted apart',
    );
  }

  const rpcUrl = (env['RPC_URL'] ?? '').trim() || constants.endpoints.defaultRpc;

  const cfg: KeeperConfig = {
    constants,
    rpcUrl,
    keypairPath,
    dryRun,
    dryRunForced,
    bull: new PublicKey(constants.wallets.bull),
    ops: opsIsPlaceholder ? null : new PublicKey(opsRaw),
    ansemMint: new PublicKey(constants.ansem.mint),
    ansemDecimals: constants.ansem.decimals,
    wsolMint: new PublicKey(constants.programs.wsolMint),
    pumpProgram: new PublicKey(constants.programs.pump),
    pumpAmmProgram: new PublicKey(constants.programs.pumpAmm),
    pumpFeesProgram: new PublicKey(constants.programs.pumpFees),
    token2022Program: new PublicKey(constants.programs.token2022),
    triggerLamports: solToLamports(constants.keeper.triggerSol),
    reserveLamports: solToLamports(constants.keeper.reserveSol),
    reserveAlertLamports: solToLamports(constants.keeper.reserveAlertSol),
    maxSolPerSwapLamports: solToLamports(constants.keeper.maxSolPerSwap),
    bullBps,
    opsBps: constants.opsFee.bps,
  };

  // $ANSEM is Token-2022. If constants ever disagree with itself, stop now
  // rather than derive a classic-SPL ATA later.
  if (constants.ansem.tokenProgram !== constants.programs.token2022) {
    throw new ConfigError('constants.ansem.tokenProgram must equal constants.programs.token2022 (Token-2022)');
  }
  if (cfg.reserveLamports >= cfg.triggerLamports) {
    throw new ConfigError('keeper.reserveSol must be smaller than keeper.triggerSol');
  }
  if (cfg.maxSolPerSwapLamports < cfg.triggerLamports) {
    throw new ConfigError('keeper.maxSolPerSwap must be >= keeper.triggerSol');
  }
  const minCrank = constants.keeper.minCrankLamports;
  if (minCrank !== undefined && (!Number.isInteger(minCrank) || minCrank < 0)) {
    throw new ConfigError('keeper.minCrankLamports must be a non-negative integer when set');
  }

  return cfg;
}

/**
 * Load the signing keypair.
 *
 * Never logs, returns or embeds key bytes; on failure the message references the
 * KEYPAIR_PATH env var by name only — never the resolved path or file content.
 */
export function loadKeypair(cfg: KeeperConfig): Keypair {
  if (cfg.keypairPath === undefined) {
    throw new ConfigError('KEYPAIR_PATH is not set — no signer available');
  }
  let secret: Uint8Array;
  try {
    const text = fs.readFileSync(cfg.keypairPath, 'utf8').trim();
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not a byte array');
    secret = Uint8Array.from(parsed as number[]);
  } catch {
    throw new ConfigError('failed to read a JSON byte-array keypair from $KEYPAIR_PATH');
  }
  try {
    return Keypair.fromSecretKey(secret);
  } catch {
    throw new ConfigError('the file at $KEYPAIR_PATH is not a valid ed25519 keypair');
  }
}

/** Signer to use for simulations when we do not (or must not) have a real one. */
export function simulationPayer(signer: Keypair | null): PublicKey {
  return signer?.publicKey ?? SIMULATION_PAYER;
}

export function killswitchEngaged(file = KILLSWITCH_PATH): boolean {
  return fs.existsSync(file);
}

export function ensureStateDir(dir = STATE_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
}
