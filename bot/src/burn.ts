import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { KeeperConfig } from './config.js';
import { log } from './logger.js';
import { withRetry } from './rpc.js';
import { awaitOutcome, buildV0Tx, signAndSend } from './tx.js';

/**
 * $ANSEM is a Token-2022 mint. Every ATA derivation, read and burn below passes
 * the Token-2022 program id EXPLICITLY (from constants). Using the classic
 * TOKEN_PROGRAM_ID anywhere in this path derives the wrong ATA and is a bug.
 *
 * The ATA is created ONCE and never closed: closing would refund 2,074,080
 * lamports of rent but breaks the "one permanent, publicly auditable burn
 * account" property and re-costs the rent on the next cycle.
 *
 * We burn with `burnChecked` — never a transfer to the incinerator, which does
 * not reduce supply and is not recognised by supply trackers.
 */

export function assertToken2022(cfg: KeeperConfig): void {
  if (!cfg.token2022Program.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `constants.programs.token2022 (${cfg.token2022Program.toBase58()}) is not the Token-2022 program id`,
    );
  }
}

export function ansemAta(cfg: KeeperConfig, owner: PublicKey): PublicKey {
  assertToken2022(cfg);
  return getAssociatedTokenAddressSync(
    cfg.ansemMint,
    owner,
    /* allowOwnerOffCurve */ false,
    cfg.token2022Program,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export function createAtaIdempotentIx(
  cfg: KeeperConfig,
  payer: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  assertToken2022(cfg);
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ansemAta(cfg, owner),
    owner,
    cfg.ansemMint,
    cfg.token2022Program,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/** Full raw balance of the ANSEM ATA; 0 when the account does not exist yet. */
export async function readAtaBalanceRaw(
  connection: Connection,
  cfg: KeeperConfig,
  owner: PublicKey,
): Promise<bigint> {
  const ata = ansemAta(cfg, owner);
  try {
    const account = await withRetry('getAccount(ansem ata)', () =>
      getAccount(connection, ata, 'confirmed', cfg.token2022Program),
    );
    return account.amount;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
      return 0n;
    }
    throw err;
  }
}

export function burnCheckedIx(
  cfg: KeeperConfig,
  owner: PublicKey,
  amountRaw: bigint,
): TransactionInstruction {
  assertToken2022(cfg);
  if (amountRaw <= 0n) throw new Error('refusing to build a burn instruction for 0 tokens');
  return createBurnCheckedInstruction(
    ansemAta(cfg, owner),
    cfg.ansemMint,
    owner,
    amountRaw,
    cfg.ansemDecimals,
    [],
    cfg.token2022Program,
  );
}

/** Raw total supply of the ANSEM mint, for the post-burn ledger entry. */
export async function fetchSupplyRaw(connection: Connection, cfg: KeeperConfig): Promise<bigint | null> {
  try {
    const supply = await withRetry('getTokenSupply(ansem)', () =>
      connection.getTokenSupply(cfg.ansemMint, 'confirmed'),
    );
    return BigInt(supply.value.amount);
  } catch (err) {
    log.warn('could not read ANSEM supply', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Create the ANSEM ATA if it is missing. Idempotent at both levels: we skip when
 * the account already exists, and the instruction itself is the idempotent
 * variant so a race cannot fail the tx.
 */
export async function ensureAta(
  connection: Connection,
  cfg: KeeperConfig,
  owner: PublicKey,
  signer: Keypair | null,
): Promise<{ ata: PublicKey; created: boolean; sig: string | null }> {
  const ata = ansemAta(cfg, owner);
  const info = await withRetry('getAccountInfo(ansem ata)', () => connection.getAccountInfo(ata, 'confirmed'));
  if (info !== null) {
    if (!info.owner.equals(cfg.token2022Program)) {
      throw new Error(
        `ANSEM ATA ${ata.toBase58()} is owned by ${info.owner.toBase58()}, expected Token-2022`,
      );
    }
    return { ata, created: false, sig: null };
  }
  if (cfg.dryRun || signer === null) {
    log.info(`[dry-run] would create Token-2022 ATA ${ata.toBase58()} for ${owner.toBase58()}`);
    return { ata, created: false, sig: null };
  }
  const { tx, lastValidBlockHeight } = await buildV0Tx(connection, signer.publicKey, [
    createAtaIdempotentIx(cfg, signer.publicKey, owner),
  ]);
  const sig = await signAndSend(connection, tx, [signer]);
  // Wait for it. Returning early would let the very next getAccountInfo still
  // see no account and pay for a second creation (harmless but wasteful), and
  // more importantly the caller treats a returned ATA as usable.
  const outcome = await awaitOutcome(connection, sig, lastValidBlockHeight);
  if (outcome !== 'confirmed') {
    throw new Error(`ANSEM ATA creation ${sig} ended as "${outcome}"; not proceeding`);
  }
  log.info(`created ANSEM Token-2022 ATA ${ata.toBase58()}`, sig);
  return { ata, created: true, sig };
}
