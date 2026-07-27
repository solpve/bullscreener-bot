import { apiJson, apiOptions } from '@/lib/api';
import { criteriaDefinitions, criteriaSpec } from '@/lib/listings';
import { KEEPER, LISTING, OPS_FEE, PROGRAMS, SPLIT } from '@/lib/constants';
import { bpsToPercent } from '@/lib/format';

export const revalidate = 60;

/**
 * The gate, machine-readable and straight from config/constants.json — the same
 * file the keeper reads. Nothing here is computed for presentation.
 */
export async function GET() {
  const spec = criteriaSpec();

  return apiJson({
    schema: 'bullscreener.criteria.v1',
    gate: spec,
    criteria: criteriaDefinitions(),
    split: {
      note: 'The FLAGSHIP (full-send) ask only — the sole-recipient 100% commit. Project-lane coins instead route >= gate.tiers.partialMinBps to the burn wallet alongside their own shareholders; per-coin reality is in /api/v1/tokens ourShareBps/tier.',
      shareholders: SPLIT.shareholders.map((s) => ({
        role: s.wallet,
        // `bps` is the canonical on-chain unit and stays put; `percent` is an
        // additive convenience mirroring what the site renders.
        bps: s.bps,
        percent: s.bps / 100,
      })),
      // constants.json settles this as disabled ("no rebates are computed,
      // owed, or advertised anywhere"). The dormant threshold fields are not
      // published: describing a policy that does not run would be a claim
      // nothing enforces.
      rebate: SPLIT.rebate.enabled
        ? {
            enabled: true,
            coinMcapThresholdUsd: SPLIT.rebate.coinMcapThresholdUsd,
            opsRetainedBpsAboveThreshold:
              SPLIT.rebate.opsRetainedBpsAboveThreshold,
          }
        : {
            enabled: false,
            note: `No rebate, negotiated rate or paid placement. Every listed coin routes its committed share — ${bpsToPercent(
              LISTING.tiers.fullBps,
            )} on the full send, ${bpsToPercent(
              LISTING.tiers.partialMinBps,
            )}+ on the project lane — to the burn wallet on-chain; the keeper takes a disclosed ${bpsToPercent(
              OPS_FEE.bps,
            )} operations fee each cycle as a visible on-chain transfer, whichever the lane.`,
          },
    },
    opsFee: {
      bps: OPS_FEE.bps,
      percent: OPS_FEE.bps / 100,
      enforcement: 'keeper',
      note: 'Taken by the open-source keeper from the burn wallet each cycle as a visible on-chain transfer. Not protocol-enforced — disclosed and auditable instead.',
    },
    programs: {
      pump: PROGRAMS.pump,
      pumpAmm: PROGRAMS.pumpAmm,
      pumpFees: PROGRAMS.pumpFees,
      token2022: PROGRAMS.token2022,
    },
    keeper: {
      triggerSol: KEEPER.triggerSol,
    },
    notes: [
      'Every criterion except fresh_wallets is enforced today; fresh_wallets is specified and reported as "pending" until v1.1.',
      'holders reports "unverified" rather than an estimate when no holder index is configured.',
      'market_cap gates on the lower of DexScreener marketCap and supply x price.',
      'Cashback coins are excluded permanently: the flag is locked at launch and their creator fee is paid to traders by the protocol.',
    ],
  });
}

export function OPTIONS() {
  return apiOptions();
}
