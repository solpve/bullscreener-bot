import { formatUtc } from '@/lib/format';

/**
 * Thin instrument strip: where the numbers came from, when they were read, and
 * whether anything degraded. A stale read says so rather than pretending.
 */
export default function StatusRibbon({
  fetchedAt,
  stale,
  holdersProvider,
  errors = [],
}: {
  fetchedAt: number;
  stale: boolean;
  holdersProvider?: 'helius' | 'unavailable';
  errors?: string[];
}) {
  const degraded = stale || errors.length > 0;

  return (
    <div className="ribbon">
      <div className="shell ribbon__inner">
        <span className="ribbon__item">
          <span className={`ribbon__dot${degraded ? ' ribbon__dot--stale' : ''}`} />
          {degraded ? 'refreshing' : 'live'}
        </span>
        <span className="ribbon__item">
          Snapshot {formatUtc(Math.floor(fetchedAt / 1000))}
        </span>
        <span className="ribbon__item">Cache 60s</span>
        <span className="ribbon__item">Source: solana mainnet + dexscreener</span>
        {holdersProvider ? (
          <span className="ribbon__item">
            Holders:{' '}
            {holdersProvider === 'helius' ? 'indexed' : 'unverified — no index key'}
          </span>
        ) : null}
        {errors.length > 0 ? (
          <span className="ribbon__item" title={errors.join(' | ')}>
            {errors.length} degraded read{errors.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
