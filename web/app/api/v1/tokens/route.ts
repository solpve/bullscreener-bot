import { apiJson, apiOptions, redactAddress } from '@/lib/api';
import { getListings } from '@/lib/listings';

export const revalidate = 60;

export async function GET() {
  const listings = await getListings();

  return apiJson({
    schema: 'bullscreener.tokens.v1',
    generatedAt: new Date(listings.fetchedAt).toISOString(),
    stale: listings.stale,
    discovered: listings.discovered,
    listed: listings.tokens.filter((t) => t.listed).length,
    /**
     * False when a shareholder-slot scan failed. Consumers must not read an
     * empty `tokens` array as "no coin participates" unless this is true.
     */
    enumerationComplete: listings.enumerationComplete,
    holdersProvider: listings.holdersProvider,
    /** Discovered mints with no indexed DexScreener pair — an absence, not a failed read. */
    marketDataMissing: listings.marketDataMissing,
    errors: listings.errors,
    tokens: listings.tokens.map((token) => ({
      mint: token.mint,
      symbol: token.market.symbol,
      name: token.market.name,
      listed: token.listed,
      incomplete: token.incomplete,
      ourShareBps: token.ourShareBps,
      /** Additive sibling of ourShareBps; the bps field remains canonical. */
      ourSharePercent: token.ourShareBps / 100,
      /** 'full' = sole recipient at 10000 bps (podium-eligible); 'partial' = anything less. See /api/v1/criteria gate.tiers. */
      tier: token.tier,
      holders: token.holders,
      holdersVerified: token.holdersVerified,
      isCashbackCoin: token.isCashbackCoin,
      cashbackSource: token.cashbackSource,
      vaultMigrated: token.vaultMigrated,
      market: {
        priceUsd: token.market.priceUsd,
        marketCapUsd: token.market.mcapUsd,
        reportedMarketCapUsd: token.market.reportedMcapUsd,
        computedMarketCapUsd: token.market.computedMcapUsd,
        marketCapMismatch: token.market.mcapMismatch,
        liquidityUsd: token.market.liquidityUsd,
        volume24hUsd: token.market.volume24hUsd,
        supply: token.market.supply,
      },
      sharingConfig: {
        address: token.sharingConfig.address,
        admin: token.sharingConfig.admin,
        version: token.sharingConfig.version,
        status: token.sharingConfig.status,
        adminRevoked: token.sharingConfig.adminRevoked,
        shareholders: token.sharingConfig.shareholders.map((s) => ({
          address: redactAddress(s.address),
          shareBps: s.shareBps,
          /** Additive sibling of shareBps; the bps field remains canonical. */
          sharePercent: s.shareBps / 100,
          isUs: s.isUs,
        })),
      },
      criteria: token.criteria.map((c) => ({
        id: c.id,
        label: c.label,
        state: c.state,
        detail: c.detail,
        rule: c.rule,
      })),
    })),
  });
}

export function OPTIONS() {
  return apiOptions();
}
