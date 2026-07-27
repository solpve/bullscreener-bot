import { apiJson, apiOptions } from '@/lib/api';
import { getStats } from '@/lib/stats';
import { ANSEM } from '@/lib/constants';

export const revalidate = 60;

export async function GET() {
  const stats = await getStats();

  return apiJson({
    schema: 'bullscreener.stats.v1',
    generatedAt: new Date(stats.fetchedAt).toISOString(),
    stale: stats.stale,
    solReceived: stats.solReceived,
    /** Our burn instructions only — see `disclosure` below. */
    ansemBurnedByUs: stats.ansemBurnedByUs,
    burnTxCount: stats.burnTxCount,
    listedCoins: stats.listedCoins,
    discoveredConfigs: stats.discoveredConfigs,
    /**
     * False when a shareholder-slot scan failed. `discoveredConfigs` is then a
     * floor, not a count — do not read 0 as "nobody participates".
     */
    enumerationComplete: stats.enumerationComplete,
    /**
     * False when the burn/inflow signature walk did not complete. `solReceived`,
     * `ansemBurnedByUs` and `burnTxCount` are then unknown, not zero.
     */
    historyComplete: stats.historyComplete,
    ansem: {
      mint: ANSEM.mint,
      symbol: ANSEM.symbol,
      decimals: ANSEM.decimals,
      tokenProgram: ANSEM.tokenProgram,
      currentSupply: stats.ansemSupply,
      launchSupply: stats.ansemLaunchSupply,
    },
    disclosure: {
      preExistingBurnedByOthers: stats.preExistingBurned,
      note: 'ansemBurnedByUs counts only burn instructions signed by this project. It is not the supply delta; preExistingBurnedByOthers was burned by unrelated parties before launch and is never included.',
      completeness:
        'Read historyComplete and enumerationComplete before treating any zero on this payload as a measurement.',
    },
    /** True when the signature walk hit its cap — totals are a lower bound. */
    truncated: stats.truncated,
    errors: stats.errors,
  });
}

export function OPTIONS() {
  return apiOptions();
}
