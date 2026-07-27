import { formatCompactUsd, formatInt } from '@/lib/format';
import { SOLSCAN } from '@/lib/links';
import type { ListingsResult } from '@/lib/types';

/**
 * The crowned top three. Rank is market cap among LISTED full-send coins only
 * — a STRICTER gate than the tables below, never a softer one: the crown is
 * what a deployer buys with the 100% commit, and project-lane coins list but
 * never rank here. Unclaimed thrones render as an open challenge rather than
 * an empty state, because the board is the incentive.
 */
const RANK_META = [
  { medal: 'gold', label: '♛ 1', title: 'champion' },
  { medal: 'silver', label: '2', title: 'challenger' },
  { medal: 'bronze', label: '3', title: 'contender' },
] as const;

export default function Leaderboard({
  listings,
}: {
  listings: ListingsResult;
}) {
  // Full-route tier only: the crown is what a deployer gets for the 100%
  // commit. Project-tier coins list in their own lane but never rank here.
  const ranked = listings.tokens
    .filter((t) => t.listed && t.tier === 'full')
    .sort((a, b) => (b.market.mcapUsd ?? 0) - (a.market.mcapUsd ?? 0))
    .slice(0, 3);

  return (
    <div
      className="podium"
      role="list"
      aria-label="Top three listed full-send coins"
    >
      {RANK_META.map((meta, i) => {
        const token = ranked[i];
        return (
          <div
            role="listitem"
            key={meta.medal}
            className={`podium__slot podium__slot--${meta.medal}${
              token ? '' : ' podium__slot--open'
            }`}
          >
            <div className="podium__medal">
              {meta.label}
              <span className="podium__medal-title">{meta.title}</span>
            </div>
            {token ? (
              <>
                <a
                  className="podium__ticker"
                  href={SOLSCAN.token(token.mint)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {token.market.symbol ?? 'UNKNOWN'}
                </a>
                <div className="podium__name">{token.market.name ?? '—'}</div>
                <dl className="podium__stats">
                  <div>
                    <dt>mcap</dt>
                    <dd className="num">
                      {formatCompactUsd(token.market.mcapUsd)}
                    </dd>
                  </div>
                  <div>
                    <dt>holders</dt>
                    <dd className="num">
                      {token.holders === null
                        ? '—'
                        : formatInt(token.holders)}
                    </dd>
                  </div>
                </dl>
                <span className="chip chip--pass">100% routed</span>
              </>
            ) : (
              <>
                <div className="podium__ticker podium__ticker--open">OPEN</div>
                <div className="podium__name">
                  {i === 0
                    ? 'The crown is unclaimed.'
                    : 'Nobody holds this spot yet.'}
                </div>
                <p className="podium__pitch">
                  Route 100% of your creator fees, clear the bar, take the
                  throne.
                </p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
