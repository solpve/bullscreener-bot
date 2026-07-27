import { Keypair } from '@solana/web3.js';
import { ConfigError, loadConfig, loadEnvFile, loadKeypair } from './config.js';
import type { CycleDeps } from './cycle.js';
import { Ledger } from './ledger.js';
import { log } from './logger.js';
import { runKeeperLoop, runOnce } from './keeper.js';
import { makeConnection } from './rpc.js';
import { runRebates } from './rebates.js';
import { printStatus } from './status.js';

const USAGE = `bullscreener keeper

  npm run keeper    crank + trigger loop (crankIntervalSec / pollIntervalSec)
  npm run once      one full pass: crank -> observe inflows -> buyback + burn
  npm run status    human-readable ledger + on-chain summary
  npm run rebates   report accrued ops rebates (add -- --send to settle)

Environment:
  RPC_URL          Solana RPC (default: constants.endpoints.defaultRpc)
  KEYPAIR_PATH     path to the BULL wallet keypair JSON. UNSET => DRY_RUN is forced on.
  DRY_RUN          "false" to go live; anything else (or unset) stays in dry run.
  OPS_KEYPAIR_PATH ops wallet key, only for \`rebates -- --send\`
  JUPITER_API_KEY  optional Jupiter portal key
  LOG_LEVEL        debug | info | warn | error
`;

async function main(): Promise<number> {
  loadEnvFile();
  const command = (process.argv[2] ?? 'status').replace(/^--/, '');
  if (command === 'help' || command === 'h') {
    console.log(USAGE);
    return 0;
  }

  const cfg = loadConfig();

  let signer: Keypair | null = null;
  if (cfg.keypairPath !== undefined) {
    signer = loadKeypair(cfg);
    if (!signer.publicKey.equals(cfg.bull)) {
      log.warn(
        `signer ${signer.publicKey.toBase58()} is NOT the BULL wallet ${cfg.bull.toBase58()} — ` +
          'cranking is still possible (permissionless) but buyback cycles will refuse to run',
      );
    }
  }
  if (cfg.dryRun) {
    log.warn(
      cfg.dryRunForced
        ? 'DRY RUN forced: KEYPAIR_PATH is unset. Nothing will be signed or sent.'
        : 'DRY RUN: nothing will be signed or sent. Set DRY_RUN=false to go live.',
    );
  } else {
    log.warn('LIVE MODE: transactions will be signed and broadcast.');
  }

  const connection = makeConnection(cfg);
  const ledger = new Ledger();
  const deps: CycleDeps = { connection, cfg, ledger, signer };

  switch (command) {
    case 'keeper': {
      const state = { aborted: false };
      const stop = (sig: string): void => {
        log.info(`received ${sig}; finishing the current pass then exiting`);
        state.aborted = true;
      };
      process.on('SIGINT', () => stop('SIGINT'));
      process.on('SIGTERM', () => stop('SIGTERM'));
      await runKeeperLoop(deps, { signal: state });
      return 0;
    }
    case 'once':
      await runOnce(deps);
      return 0;
    case 'status':
      await printStatus(cfg, ledger, connection);
      return 0;
    case 'rebates': {
      const send = process.argv.slice(3).includes('--send');
      await runRebates(connection, cfg, ledger, { send });
      return 0;
    }
    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError) {
      log.error(`configuration error: ${err.message}`);
    } else {
      log.error('fatal', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    }
    process.exitCode = 1;
  });
