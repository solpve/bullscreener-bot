import { apiJson, apiOptions } from '@/lib/api';
import { getActivity } from '@/lib/stats';
import { ANSEM, PRE_EXISTING_BURNED_ANSEM } from '@/lib/constants';

export const revalidate = 60;

export async function GET() {
  const activity = await getActivity();

  return apiJson({
    schema: 'bullscreener.burns.v1',
    generatedAt: new Date(activity.fetchedAt).toISOString(),
    stale: activity.stale,
    mint: ANSEM.mint,
    tokenProgram: ANSEM.tokenProgram,
    totalAnsemBurnedByUs: activity.totalAnsemBurned,
    burnTxCount: activity.burnTxCount,
    totalSolReceived: activity.totalSolReceived,
    /**
     * False when the signature walk or a transaction fetch failed. The totals
     * above are then NOT a measurement — a zero means "could not read", not
     * "nothing burned". Consumers must gate on this exactly as they gate on
     * `enumerationComplete` in /api/v1/tokens.
     */
    scanComplete: activity.scanComplete,
    truncated: activity.truncated,
    scannedSignatures: activity.scannedSignatures,
    parsedTransactions: activity.parsedTransactions,
    disclosure: {
      preExistingBurnedByOthers: PRE_EXISTING_BURNED_ANSEM,
      scanCompleteness:
        'scanComplete=false means an on-chain read failed. Do not interpret the totals as measurements when it is false; truncated=true means they are a lower bound.',
      solInAttribution:
        'solIn pairs each burn with the nearest preceding unattributed buy from the same wallet. Null when no match exists inside the scanned window. ansemBurned is read from the burn instruction and is exact.',
    },
    burns: activity.burns.map((burn) => ({
      signature: burn.signature,
      slot: burn.slot,
      blockTime: burn.blockTime,
      timestamp:
        burn.blockTime === null
          ? null
          : new Date(burn.blockTime * 1000).toISOString(),
      ansemBurned: burn.ansemBurned,
      solIn: burn.solIn,
      solInAttributed: burn.solInAttributed,
      swapSignature: burn.swapSignature,
      explorer: `https://solscan.io/tx/${burn.signature}`,
    })),
    errors: activity.errors,
  });
}

export function OPTIONS() {
  return apiOptions();
}
