import 'server-only';
import { PublicKey } from '@solana/web3.js';
import {
  DISCRIMINATORS,
  OUR_WALLETS,
  PROGRAMS,
  SHARING_CONFIG_LAYOUT,
} from './constants';
import type { SharingConfig, Shareholder } from './types';

/**
 * Hand-rolled Borsh readers for the two accounts the screener depends on.
 * Offsets come from idl/pump_fees.json and idl/pump.json and were re-verified
 * against live mainnet accounts on 2026-07-26:
 *   SharingConfig 9ENSWnedBEAvVB7jJKZrLRZ9vuVuJdBE7uJt2oAsG1jr
 *   BondingCurve  FxC6pJJSiu6efSn8PmBMQjQaYm6dkSqmQYohui6NPnrf
 */

const PUMP_FEES_PROGRAM = new PublicKey(PROGRAMS.pumpFees);
const PUMP_PROGRAM = new PublicKey(PROGRAMS.pump);

function discriminatorMatches(data: Buffer, expected: Uint8Array): boolean {
  if (data.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (data[i] !== expected[i]) return false;
  }
  return true;
}

function readPubkey(data: Buffer, offset: number): string | null {
  if (data.length < offset + 32) return null;
  try {
    return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  } catch {
    return null;
  }
}

/**
 * SharingConfig layout:
 *   0   [8]  discriminator
 *   8   u8   bump
 *   9   u8   version
 *   10  u8   status        (ConfigStatus: 0 = Paused, 1 = Active)
 *   11  [32] mint
 *   43  [32] admin
 *   75  bool admin_revoked
 *   76  u32  shareholders vec length
 *   80  ..   Shareholder { [32] address, u16 share_bps }  — stride 34
 */
export function decodeSharingConfig(
  address: string,
  data: Buffer,
): SharingConfig | null {
  if (!discriminatorMatches(data, DISCRIMINATORS.sharingConfig)) return null;
  if (data.length < SHARING_CONFIG_LAYOUT.shareholder0Offset) return null;

  const mint = readPubkey(data, 11);
  const admin = readPubkey(data, 43);
  if (!mint || !admin) return null;

  const statusByte = data[10];
  const status: SharingConfig['status'] =
    statusByte === 1 ? 'Active' : statusByte === 0 ? 'Paused' : 'Unknown';

  const declaredLen = data.readUInt32LE(76);
  // The account is a fixed 1024-byte allocation; a corrupt or unexpected vec
  // length must not make us read garbage past the shareholder region.
  const maxByLayout = SHARING_CONFIG_LAYOUT.maxShareholders;
  const maxByData = Math.floor(
    (data.length - SHARING_CONFIG_LAYOUT.shareholder0Offset) /
      SHARING_CONFIG_LAYOUT.shareholderSize,
  );
  const count = Math.max(0, Math.min(declaredLen, maxByLayout, maxByData));

  const shareholders: Shareholder[] = [];
  for (let i = 0; i < count; i++) {
    const offset =
      SHARING_CONFIG_LAYOUT.shareholder0Offset +
      i * SHARING_CONFIG_LAYOUT.shareholderSize;
    const holder = readPubkey(data, offset);
    if (!holder) continue;
    const shareBps = data.readUInt16LE(offset + 32);
    shareholders.push({
      address: holder,
      shareBps,
      isUs: OUR_WALLETS.includes(holder),
    });
  }

  return {
    address,
    mint,
    admin,
    bump: data[8] ?? 0,
    version: data[9] ?? 0,
    status,
    adminRevoked: data[75] === 1,
    shareholders,
  };
}

export interface BondingCurveState {
  complete: boolean;
  creator: string | null;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  tokenTotalSupply: bigint;
}

/**
 * BondingCurve layout (151 bytes on chain, 36 trailing reserved bytes):
 *   0  [8]  discriminator
 *   8  u64  virtual_token_reserves
 *   16 u64  virtual_quote_reserves
 *   24 u64  real_token_reserves
 *   32 u64  real_quote_reserves
 *   40 u64  token_total_supply
 *   48 bool complete
 *   49 [32] creator            <- equals the sharing config PDA once fees are routed
 *   81 bool is_mayhem_mode
 *   82 bool is_cashback_coin   <- hard listing disqualifier
 *   83 [32] quote_mint
 */
export function decodeBondingCurve(data: Buffer): BondingCurveState | null {
  if (!discriminatorMatches(data, DISCRIMINATORS.bondingCurve)) return null;
  if (data.length < 115) return null;
  return {
    complete: data[48] === 1,
    creator: readPubkey(data, 49),
    isMayhemMode: data[81] === 1,
    isCashbackCoin: data[82] === 1,
    tokenTotalSupply: data.readBigUInt64LE(40),
  };
}

export interface MintState {
  supplyRaw: bigint;
  decimals: number;
}

/**
 * SPL Mint layout — identical for the first 82 bytes under Token and Token-2022.
 *   0  u32  mint_authority option
 *   4  [32] mint_authority
 *   36 u64  supply
 *   44 u8   decimals
 */
export function decodeMint(data: Buffer): MintState | null {
  if (data.length < 45) return null;
  const decimals = data[44];
  if (decimals === undefined || decimals > 18) return null;
  return { supplyRaw: data.readBigUInt64LE(36), decimals };
}

export function sharingConfigPda(mint: string): string | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('sharing-config'), new PublicKey(mint).toBuffer()],
      PUMP_FEES_PROGRAM,
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

export function bondingCurvePda(mint: string): string | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
      PUMP_PROGRAM,
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

export function rawToUi(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
