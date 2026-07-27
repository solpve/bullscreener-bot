import { Connection, PublicKey } from '@solana/web3.js';
import { feeSharingConfigPda } from '@pump-fun/pump-sdk';
import type { KeeperConfig } from './config.js';
import type { Constants } from './types.js';
import { log } from './logger.js';
import { sleep, withRetry } from './rpc.js';

/**
 * SharingConfig account layout (verified on-chain 2026-07-26 against the ANSEM
 * config 9ENSWnedBEAvVB7jJKZrLRZ9vuVuJdBE7uJt2oAsG1jr, and against
 * idl/pump_fees.json):
 *
 *   0   8   discriminator [216,74,9,0,56,140,93,75]
 *   8   1   bump
 *   9   1   version
 *   10  1   status (0 = Paused, 1 = Active)
 *   11  32  mint
 *   43  32  admin
 *   75  1   admin_revoked
 *   76  4   shareholders vec length (u32 LE)
 *   80  34*n shareholders: 32-byte pubkey + u16 LE share_bps
 *
 * The account is rent-padded to 1024 bytes; trailing bytes are zero.
 */
const OFF_BUMP = 8;
const OFF_VERSION = 9;
const OFF_STATUS = 10;
const OFF_MINT = 11;
const OFF_ADMIN = 43;
const OFF_ADMIN_REVOKED = 75;
const OFF_VEC_LEN = 76;

export type SharingConfigStatus = 'Paused' | 'Active' | 'Unknown';

export interface DecodedShareholder {
  address: PublicKey;
  shareBps: number;
}

export interface DecodedSharingConfig {
  bump: number;
  version: number;
  statusRaw: number;
  status: SharingConfigStatus;
  mint: PublicKey;
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: DecodedShareholder[];
}

export class SharingConfigDecodeError extends Error {}

type Layout = Constants['sharingConfigLayout'];

function statusFromRaw(raw: number): SharingConfigStatus {
  if (raw === 0) return 'Paused';
  if (raw === 1) return 'Active';
  return 'Unknown';
}

/**
 * Pure decoder. `data` may be a dataSlice-truncated buffer as long as it covers
 * the full shareholder vec.
 */
export function decodeSharingConfigData(data: Uint8Array, layout: Layout): DecodedSharingConfig {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const shareholder0Offset = layout.shareholder0Offset;
  const shareholderSize = layout.shareholderSize;

  if (buf.length < shareholder0Offset) {
    throw new SharingConfigDecodeError(
      `account too small: ${buf.length} bytes, need at least ${shareholder0Offset}`,
    );
  }
  for (let i = 0; i < layout.discriminator.length; i++) {
    if (buf[i] !== layout.discriminator[i]) {
      throw new SharingConfigDecodeError('discriminator mismatch — not a SharingConfig account');
    }
  }

  const vecLen = buf.readUInt32LE(OFF_VEC_LEN);
  if (vecLen > layout.maxShareholders) {
    throw new SharingConfigDecodeError(
      `shareholder vec length ${vecLen} exceeds max ${layout.maxShareholders}`,
    );
  }
  const needed = shareholder0Offset + vecLen * shareholderSize;
  if (buf.length < needed) {
    throw new SharingConfigDecodeError(
      `truncated shareholder vec: have ${buf.length} bytes, need ${needed}`,
    );
  }

  const shareholders: DecodedShareholder[] = [];
  for (let i = 0; i < vecLen; i++) {
    const base = shareholder0Offset + i * shareholderSize;
    shareholders.push({
      address: new PublicKey(buf.subarray(base, base + 32)),
      shareBps: buf.readUInt16LE(base + 32),
    });
  }

  const statusRaw = buf.readUInt8(OFF_STATUS);
  return {
    bump: buf.readUInt8(OFF_BUMP),
    version: buf.readUInt8(OFF_VERSION),
    statusRaw,
    status: statusFromRaw(statusRaw),
    mint: new PublicKey(buf.subarray(OFF_MINT, OFF_MINT + 32)),
    admin: new PublicKey(buf.subarray(OFF_ADMIN, OFF_ADMIN + 32)),
    adminRevoked: buf.readUInt8(OFF_ADMIN_REVOKED) === 1,
    shareholders,
  };
}

/** Total bytes we need from each account to decode a full shareholder vec. */
export function sliceLength(layout: Layout): number {
  return layout.shareholder0Offset + layout.maxShareholders * layout.shareholderSize;
}

/** bps routed to `wallet` by this config (0 when absent). */
export function bpsFor(config: DecodedSharingConfig, wallet: PublicKey): number {
  let total = 0;
  for (const sh of config.shareholders) {
    if (sh.address.equals(wallet)) total += sh.shareBps;
  }
  return total;
}

export interface DiscoveredCoin {
  /** the sharing_config PDA address */
  address: PublicKey;
  mint: PublicKey;
  config: DecodedSharingConfig;
  /** bps routed to the BULL wallet */
  ourBps: number;
  /** passes the listing gates in constants.listing */
  qualifies: boolean;
  /** why it does not qualify (empty when it does) */
  disqualifiers: string[];
}

export function evaluateCoin(
  address: PublicKey,
  config: DecodedSharingConfig,
  cfg: KeeperConfig,
  wallet: PublicKey = cfg.bull,
): DiscoveredCoin {
  const ourBps = bpsFor(config, wallet);
  const listing = cfg.constants.listing;
  const disqualifiers: string[] = [];
  if (listing.requireStatusActive && config.status !== 'Active') disqualifiers.push('status_not_active');
  if (listing.requireAdminRevoked && !config.adminRevoked) disqualifiers.push('admin_not_revoked');
  if (ourBps < listing.minShareBpsToUs) disqualifiers.push('share_below_min');
  return {
    address,
    mint: config.mint,
    config,
    ourBps,
    qualifies: disqualifiers.length === 0,
    disqualifiers,
  };
}

/**
 * Enumerate every SharingConfig that routes any share to `wallet`.
 *
 * One getProgramAccounts per shareholder slot (offset 80 + 34*i, i = 0..9),
 * always paired with the account discriminator at offset 0 — an unfiltered scan
 * of the fee program aborts on public RPC. Results are deduped by PDA address.
 */
export async function discoverSharingConfigs(
  connection: Connection,
  cfg: KeeperConfig,
  wallet: PublicKey = cfg.bull,
  opts: { delayMs?: number } = {},
): Promise<DiscoveredCoin[]> {
  const layout = cfg.constants.sharingConfigLayout;
  const delayMs = opts.delayMs ?? 250;
  const walletB58 = wallet.toBase58();
  const found = new Map<string, DiscoveredCoin>();

  for (let slot = 0; slot < layout.maxShareholders; slot++) {
    const offset = layout.shareholder0Offset + slot * layout.shareholderSize;
    const accounts = await withRetry(`getProgramAccounts(slot=${slot})`, () =>
      connection.getProgramAccounts(cfg.pumpFeesProgram, {
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: sliceLength(layout) },
        filters: [
          { memcmp: { offset: 0, bytes: layout.discriminatorB58 } },
          { memcmp: { offset, bytes: walletB58 } },
        ],
      }),
    );

    for (const { pubkey, account } of accounts) {
      const key = pubkey.toBase58();
      if (found.has(key)) continue;
      try {
        const decoded = decodeSharingConfigData(account.data, layout);
        found.set(key, evaluateCoin(pubkey, decoded, cfg, wallet));
      } catch (err) {
        log.warn(`skipping undecodable sharing config ${key}`, err instanceof Error ? err.message : String(err));
      }
    }

    if (slot < layout.maxShareholders - 1 && delayMs > 0) await sleep(delayMs);
  }

  const coins = [...found.values()];
  log.info(`discovery: ${coins.length} sharing config(s) route to ${walletB58} (${coins.filter((c) => c.qualifies).length} qualify)`);
  return coins;
}

/** Fetch + decode a single SharingConfig by its PDA address. */
export async function decodeSharingConfig(
  connection: Connection,
  cfg: KeeperConfig,
  address: PublicKey,
): Promise<DecodedSharingConfig | null> {
  const info = await withRetry('getAccountInfo(sharingConfig)', () =>
    connection.getAccountInfo(address, 'confirmed'),
  );
  if (info === null) return null;
  if (!info.owner.equals(cfg.pumpFeesProgram)) {
    throw new SharingConfigDecodeError(
      `${address.toBase58()} is not owned by the Pump Fees program`,
    );
  }
  return decodeSharingConfigData(info.data, cfg.constants.sharingConfigLayout);
}

/** Fetch + decode the SharingConfig for a mint (PDA ['sharing-config', mint]). */
export async function decodeSharingConfigForMint(
  connection: Connection,
  cfg: KeeperConfig,
  mint: PublicKey,
): Promise<{ address: PublicKey; config: DecodedSharingConfig } | null> {
  const address = feeSharingConfigPda(mint);
  const config = await decodeSharingConfig(connection, cfg, address);
  return config === null ? null : { address, config };
}

/** Shape the pump SDK's instruction builders expect. */
export function toSdkSharingConfig(config: DecodedSharingConfig): {
  version: number;
  mint: PublicKey;
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: { address: PublicKey; shareBps: number }[];
} {
  return {
    version: config.version,
    mint: config.mint,
    admin: config.admin,
    adminRevoked: config.adminRevoked,
    shareholders: config.shareholders.map((s) => ({ address: s.address, shareBps: s.shareBps })),
  };
}
