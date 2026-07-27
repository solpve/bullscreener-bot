import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import {
  bpsFor,
  decodeSharingConfigData,
  evaluateCoin,
  sliceLength,
  SharingConfigDecodeError,
  toSdkSharingConfig,
} from '../src/discovery.js';
import { readConstants } from '../src/config.js';
import fixture from './fixtures/ansem-sharing-config.json' with { type: 'json' };

const constants = readConstants();
const layout = constants.sharingConfigLayout;
const data = Buffer.from(fixture.dataBase64, 'base64');

/** Ansem's own wallet — the sole shareholder on the ANSEM sharing config. */
const ANSEM_WALLET = 'GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52';

describe('SharingConfig decode (live ANSEM fixture)', () => {
  it('is a Pump Fees account of the expected shape', () => {
    expect(fixture.owner).toBe(constants.programs.pumpFees);
    expect(fixture.address).toBe(constants.ansem.sharingConfigPda);
    expect(data.length).toBeGreaterThanOrEqual(sliceLength(layout));
  });

  it('decodes the ANSEM config: active, admin_revoked, 100% to Ansem', () => {
    const decoded = decodeSharingConfigData(data, layout);

    expect(decoded.mint.toBase58()).toBe(constants.ansem.mint);
    expect(decoded.status).toBe('Active');
    expect(decoded.adminRevoked).toBe(true);
    expect(decoded.version).toBe(2);

    expect(decoded.shareholders).toHaveLength(1);
    expect(decoded.shareholders[0]!.address.toBase58()).toBe(ANSEM_WALLET);
    expect(decoded.shareholders[0]!.shareBps).toBe(10_000);
  });

  it('agrees with the pump SDK decoder', () => {
    const viaSdk = PUMP_SDK.decodeSharingConfig({
      data,
      executable: false,
      lamports: 0,
      owner: new PublicKey(constants.programs.pumpFees),
      rentEpoch: 0,
    });
    const mine = decodeSharingConfigData(data, layout);
    expect(viaSdk.mint.toBase58()).toBe(mine.mint.toBase58());
    expect(viaSdk.admin.toBase58()).toBe(mine.admin.toBase58());
    expect(viaSdk.adminRevoked).toBe(mine.adminRevoked);
    expect(viaSdk.shareholders.map((s) => [s.address.toBase58(), s.shareBps])).toEqual(
      mine.shareholders.map((s) => [s.address.toBase58(), s.shareBps]),
    );
  });

  it('bpsFor finds and misses the right wallets', () => {
    const decoded = decodeSharingConfigData(data, layout);
    expect(bpsFor(decoded, new PublicKey(ANSEM_WALLET))).toBe(10_000);
    expect(bpsFor(decoded, new PublicKey(constants.wallets.bull))).toBe(0);
  });

  it('round-trips into the SDK instruction-builder shape', () => {
    const sdkShape = toSdkSharingConfig(decodeSharingConfigData(data, layout));
    expect(sdkShape.shareholders).toHaveLength(1);
    expect(sdkShape.shareholders[0]!.shareBps).toBe(10_000);
    expect(sdkShape.adminRevoked).toBe(true);
  });

  it('rejects a wrong discriminator', () => {
    const bad = Buffer.from(data);
    bad[0] = (bad[0]! + 1) % 256;
    expect(() => decodeSharingConfigData(bad, layout)).toThrow(SharingConfigDecodeError);
  });

  it('rejects an implausible shareholder vec length', () => {
    const bad = Buffer.from(data);
    bad.writeUInt32LE(11, 76);
    expect(() => decodeSharingConfigData(bad, layout)).toThrow(/exceeds max/);
  });

  it('rejects a truncated shareholder vec', () => {
    const bad = Buffer.from(data.subarray(0, layout.shareholder0Offset + 10));
    expect(() => decodeSharingConfigData(bad, layout)).toThrow(/truncated/);
  });

  it('decodes a synthetic 2-shareholder 9500/500 config', () => {
    const buf = Buffer.alloc(sliceLength(layout));
    Buffer.from(layout.discriminator).copy(buf, 0);
    buf.writeUInt8(255, 8); // bump
    buf.writeUInt8(2, 9); // version
    buf.writeUInt8(1, 10); // Active
    new PublicKey(constants.ansem.mint).toBuffer().copy(buf, 11);
    new PublicKey(constants.wallets.bull).toBuffer().copy(buf, 43);
    buf.writeUInt8(1, 75); // admin_revoked
    buf.writeUInt32LE(2, 76);
    new PublicKey(constants.wallets.bull).toBuffer().copy(buf, 80);
    buf.writeUInt16LE(9500, 112);
    new PublicKey(ANSEM_WALLET).toBuffer().copy(buf, 114);
    buf.writeUInt16LE(500, 146);

    const decoded = decodeSharingConfigData(buf, layout);
    expect(decoded.shareholders).toHaveLength(2);
    expect(bpsFor(decoded, new PublicKey(constants.wallets.bull))).toBe(9500);
  });
});

describe('listing gate evaluation', () => {
  const cfgLike = {
    constants,
    bull: new PublicKey(constants.wallets.bull),
  } as never;

  it('disqualifies a config that does not route enough to us', () => {
    const decoded = decodeSharingConfigData(data, layout);
    const coin = evaluateCoin(new PublicKey(fixture.address), decoded, cfgLike);
    expect(coin.qualifies).toBe(false);
    expect(coin.disqualifiers).toContain('share_below_min');
  });

  it('qualifies an active, revoked, single-shareholder 100% config', () => {
    const decoded = decodeSharingConfigData(data, layout);
    decoded.shareholders = [{ address: new PublicKey(constants.wallets.bull), shareBps: 10_000 }];
    const coin = evaluateCoin(new PublicKey(fixture.address), decoded, cfgLike);
    expect(coin.disqualifiers).toEqual([]);
    expect(coin.qualifies).toBe(true);
    expect(coin.ourBps).toBe(10_000);
  });

  it('qualifies a project-lane config (us alongside other shareholders, above the floor)', () => {
    const decoded = decodeSharingConfigData(data, layout);
    decoded.shareholders = [
      { address: new PublicKey(constants.wallets.bull), shareBps: 9500 },
      { address: new PublicKey(ANSEM_WALLET), shareBps: 500 },
    ];
    const coin = evaluateCoin(new PublicKey(fixture.address), decoded, cfgLike);
    expect(coin.disqualifiers).toEqual([]);
    expect(coin.qualifies).toBe(true);
    expect(coin.ourBps).toBe(9500);
  });

  it('disqualifies a config routing us less than the project-lane floor', () => {
    const decoded = decodeSharingConfigData(data, layout);
    decoded.shareholders = [
      { address: new PublicKey(constants.wallets.bull), shareBps: constants.listing.minShareBpsToUs - 1 },
      { address: new PublicKey(ANSEM_WALLET), shareBps: 10_000 - (constants.listing.minShareBpsToUs - 1) },
    ];
    const coin = evaluateCoin(new PublicKey(fixture.address), decoded, cfgLike);
    expect(coin.disqualifiers).toContain('share_below_min');
    expect(coin.qualifies).toBe(false);
  });

  it('disqualifies a paused or non-revoked config', () => {
    const decoded = decodeSharingConfigData(data, layout);
    decoded.shareholders = [{ address: new PublicKey(constants.wallets.bull), shareBps: 10_000 }];
    decoded.status = 'Paused';
    decoded.adminRevoked = false;
    const coin = evaluateCoin(new PublicKey(fixture.address), decoded, cfgLike);
    expect(coin.disqualifiers).toEqual(['status_not_active', 'admin_not_revoked']);
  });
});
