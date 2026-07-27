import { formatAmount, formatInt, formatSol } from '@/lib/format';
import type { StatsResult } from '@/lib/types';

/** Exported so the homepage's $ANSEM row renders identical tiles, not a lookalike. */
export function Stat({
  label,
  value,
  unit,
  foot,
  muted,
  footnote,
}: {
  label: string;
  value: string;
  unit?: string;
  foot?: string;
  muted?: boolean;
  footnote?: string;
}) {
  return (
    <div className="stat">
      <div className="micro">{label}</div>
      <div className={`stat__value${muted ? ' stat__value--muted' : ''}`}>
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
        {footnote ? (
          <sup className="accent" style={{ fontSize: '0.55em', marginLeft: '0.15em' }}>
            {footnote}
          </sup>
        ) : null}
      </div>
      {foot ? <div className="stat__foot">{foot}</div> : null}
    </div>
  );
}

export default function StatStrip({ stats }: { stats: StatsResult }) {
  // A zero we read is a fact; a zero we failed to read is not.
  //
  // Only the *unverified zero* is suppressed. If the scan found real activity
  // we still show it — an incomplete scan makes those figures a lower bound,
  // which `truncated` already says — but if the scan failed AND we have
  // nothing, "0" would be a claim of absence we did not earn, so it renders
  // "—" instead.
  const hasData =
    stats.burnTxCount > 0 || stats.solReceived > 0 || stats.ansemBurnedByUs > 0;
  const known = stats.historyComplete || hasData;
  const zeroHistory =
    stats.historyComplete && stats.burnTxCount === 0 && stats.solReceived === 0;
  const unknownFoot = 'Could not be read — the on-chain scan did not complete.';
  const partialFoot = 'Partial — a read failed or the scan window was capped.';

  return (
    <div className="stats" role="group" aria-label="Live protocol statistics">
      <Stat
        label="SOL received"
        value={known ? formatSol(stats.solReceived, 4) : '—'}
        unit={known ? 'SOL' : undefined}
        muted={!known || stats.solReceived === 0}
        foot={
          !known
            ? unknownFoot
            : zeroHistory
              ? 'No creator fees routed yet.'
              : 'Every SOL credit to the fee wallet, not fee revenue alone.'
        }
      />
      <Stat
        label="ANSEM burned by us"
        value={known ? formatAmount(stats.ansemBurnedByUs, 2) : '—'}
        muted={!known || stats.ansemBurnedByUs === 0}
        footnote="1"
        foot={known ? 'Our burn instructions only.' : unknownFoot}
      />
      <Stat
        label="Burn transactions"
        value={known ? formatInt(stats.burnTxCount) : '—'}
        muted={!known || stats.burnTxCount === 0}
        foot={
          !known
            ? unknownFoot
            : stats.truncated
              ? partialFoot
              : 'On-chain, each one verifiable.'
        }
      />
      <Stat
        label="Listed coins"
        value={formatInt(stats.listedCoins)}
        muted={stats.listedCoins === 0}
        foot={
          stats.discoveredConfigs === 0
            ? stats.enumerationComplete
              ? 'No fee-sharing configs found yet.'
              : 'Scan incomplete — count is not a measurement.'
            : `${formatInt(stats.discoveredConfigs)} config${
                stats.discoveredConfigs === 1 ? '' : 's'
              } discovered, gated below.`
        }
      />
    </div>
  );
}
