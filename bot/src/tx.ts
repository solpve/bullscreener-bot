import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type SignatureStatus,
  type TransactionInstruction,
} from '@solana/web3.js';
import { log } from './logger.js';
import { withRetry } from './rpc.js';

export type SigOutcome = 'confirmed' | 'failed' | 'pending' | 'expired';

/**
 * Pure classifier for a previously-sent signature.
 *
 * The whole point: a stored signature is NEVER re-sent while it can still land.
 * "pending" means wait; only "expired" (blockhash's last valid block height has
 * passed and the network has never seen the signature) frees us to act.
 */
export function classifySignatureStatus(
  status: Pick<SignatureStatus, 'err' | 'confirmationStatus'> | null,
  currentBlockHeight: number,
  lastValidBlockHeight: number | undefined,
): SigOutcome {
  if (status !== null) {
    if (status.err !== null && status.err !== undefined) return 'failed';
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return 'confirmed';
    }
    return 'pending';
  }
  if (lastValidBlockHeight !== undefined && currentBlockHeight > lastValidBlockHeight) return 'expired';
  return 'pending';
}

export async function classifySignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number | undefined,
): Promise<SigOutcome> {
  const [statuses, blockHeight] = await Promise.all([
    withRetry('getSignatureStatuses', () =>
      connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    ),
    withRetry('getBlockHeight', () => connection.getBlockHeight('confirmed')),
  ]);
  return classifySignatureStatus(statuses.value[0] ?? null, blockHeight, lastValidBlockHeight);
}

export interface BuiltTx {
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
  blockhash: string;
}

export async function buildV0Tx(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<BuiltTx> {
  const { blockhash, lastValidBlockHeight } = await withRetry('getLatestBlockhash', () =>
    connection.getLatestBlockhash('confirmed'),
  );
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return { tx: new VersionedTransaction(message), lastValidBlockHeight, blockhash };
}

/** Simulate; returns null on success or the error string on failure. */
export async function simulateForError(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<{ err: string | null; logs: string[]; returnData: Buffer | null }> {
  const sim = await withRetry('simulateTransaction', () =>
    connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' }),
  );
  const raw = sim.value.returnData?.data;
  const returnData = raw ? Buffer.from(raw[0], 'base64') : null;
  return {
    err: sim.value.err ? JSON.stringify(sim.value.err) : null,
    logs: sim.value.logs ?? [],
    returnData,
  };
}

export async function signAndSend(
  connection: Connection,
  tx: VersionedTransaction,
  signers: Keypair[],
): Promise<string> {
  tx.sign(signers);
  const sig = await withRetry('sendRawTransaction', () =>
    connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    }),
  );
  log.info(`sent tx ${sig}`);
  return sig;
}

/**
 * Wait for a signature to reach a terminal outcome. Never resends; the caller
 * owns retry policy and must persist the signature BEFORE calling this.
 */
export async function awaitOutcome(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number | undefined,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SigOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await classifySignature(connection, signature, lastValidBlockHeight);
    if (outcome !== 'pending') return outcome;
    if (Date.now() >= deadline) return 'pending';
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
