import 'server-only';
import { PublicKey } from '@solana/web3.js';
import raw from '../../config/constants.json';

/**
 * config/constants.json is the single source of truth shared with bot/.
 * Nothing in web/ may re-declare an address, threshold, or offset that lives
 * there — import from this module instead.
 *
 * `server-only` is load-bearing: raw contains the embargoed BULL deposit
 * address, and this import makes it a build error for any client component to
 * pull it into the browser bundle.
 */

export const CONSTANTS = raw;
export const ANSEM = raw.ansem;
export const PROGRAMS = raw.programs;
export const LISTING = raw.listing;
export const SPLIT = raw.split;
export const OPS_FEE = raw.opsFee;
export const KEEPER = raw.keeper;
export const SHARING_CONFIG_LAYOUT = raw.sharingConfigLayout;
export const POOL_LAYOUT = raw.pool;
export const ENDPOINTS = raw.endpoints;

function asPubkey(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    // Rejects the `REPLACE_WITH_OPS_WALLET` placeholder and any typo'd base58.
    const key = new PublicKey(value);
    return key.toBase58() === value ? value : null;
  } catch {
    return null;
  }
}

/** The vanity wallet every participating coin routes its committed share to — all 10000 bps on the full send, >= the tier floor on the project lane. */
export const BULL_WALLET = asPubkey(raw.wallets.bull);
/** Ops-fee wallet — paid by the keeper each cycle, never a shareholder; null while constants.json holds a placeholder. */
export const OPS_WALLET = asPubkey(raw.wallets.ops);

/**
 * Wallets whose share_bps count toward `minShareBpsToUs` (the project-lane
 * floor; `listing.tiers.fullBps` marks the flagship sole-recipient tier).
 * Only the burn wallet counts — published as `ourShareholderCount` in the
 * criteria API.
 */
export const OUR_WALLETS: string[] = [BULL_WALLET].filter(
  (w): w is string => w !== null,
);

export const OPS_WALLET_CONFIGURED = OPS_WALLET !== null;

/** Pre-existing burns by third parties. Disclosed as a baseline, never counted as ours. */
export const PRE_EXISTING_BURNED_ANSEM = 57784.42;

export const ANSEM_LAUNCH_SUPPLY =
  Number(ANSEM.launchSupplyRaw) / 10 ** ANSEM.decimals;

export const RPC_URL = process.env.RPC_URL || ENDPOINTS.defaultRpc;
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY || null;

/** Cache/ISR window. Everything on this site is derived live and cached for this long. */
export const REVALIDATE_SECONDS = 60;

/** Anchor account discriminators we memcmp against. */
export const DISCRIMINATORS = {
  sharingConfig: Uint8Array.from(SHARING_CONFIG_LAYOUT.discriminator),
  sharingConfigB58: SHARING_CONFIG_LAYOUT.discriminatorB58,
  // Verified against IDL + live account FxC6pJJSiu6efSn8PmBMQjQaYm6dkSqmQYohui6NPnrf.
  bondingCurve: Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]),
};
