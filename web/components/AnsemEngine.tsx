import { Stat } from '@/components/StatStrip';
import {
  formatAmount,
  formatCompactUsd,
  formatPercent,
  formatSol,
  formatUsd,
} from '@/lib/format';

/**
 * The narrative row: what $ANSEM is worth, how much of it this project has
 * destroyed, and how close the wallet is to doing it again.
 *
 * Every prop is a scalar. The deposit address is never passed in — only the
 * SOL figure derived from it server-side (see lib/ansem.ts).
 *
 * Honesty rules encoded here:
 *  - `ansemBurnedByUs` counts our burn instructions only. Burns by unrelated
 *    parties are disclosed in the footer and never added in.
 *  - Anything unreadable renders "—". A zero is only shown when a zero was
 *    actually measured.
 *  - Market cap is the conservative of DexScreener's figure and supply x price,
 *    matching the gate listings.ts applies to every screened coin.
 */
export default function AnsemEngine({
  priceUsd,
  reportedMcapUsd,
  supply,
  ansemBurnedByUs,
  balanceSol,
  deployableSol,
  triggerSol,
  reserveSol,
  fraction,
}: {
  priceUsd: number | null;
  reportedMcapUsd: number | null;
  supply: number | null;
  /** null when the on-chain scan did not complete — unknown, not zero. */
  ansemBurnedByUs: number | null;
  balanceSol: number | null;
  deployableSol: number | null;
  triggerSol: number;
  reserveSol: number;
  fraction: number | null;
}) {
  const computedMcapUsd =
    priceUsd !== null && supply !== null && supply > 0 ? priceUsd * supply : null;

  // Two independent figures disagreeing is a reason to quote the lower one, not
  // to pick a favourite.
  const mcapUsd =
    reportedMcapUsd !== null && computedMcapUsd !== null
      ? Math.min(reportedMcapUsd, computedMcapUsd)
      : (computedMcapUsd ?? reportedMcapUsd);

  const mcapFoot =
    mcapUsd === null
      ? 'Could not be read — neither source answered.'
      : computedMcapUsd === null
        ? 'DexScreener’s figure — the supply cross-check could not be read.'
        : reportedMcapUsd === null
          ? 'Current on-chain supply × price.'
          : 'Lower of DexScreener’s figure and supply × price.';

  // Share of the supply that exists right now, not of the launch supply: the
  // denominator has to be the thing a reader can go and check.
  const burnedPct =
    ansemBurnedByUs !== null && supply !== null && supply > 0
      ? (ansemBurnedByUs / supply) * 100
      : null;

  const pctFoot =
    ansemBurnedByUs === null
      ? 'Unknown while the burn scan is incomplete.'
      : supply === null
        ? 'Current supply could not be read, so the share is unknown.'
        : 'Our burns ÷ current on-chain supply. Others’ burns excluded.';

  const accrued = formatSol(balanceSol, 2);
  const pctFull = fraction === null ? null : Math.round(fraction * 100);

  return (
    <div className="engine">
      <div className="stats" role="group" aria-label="$ANSEM burn engine">
        <Stat
          label="$ANSEM price"
          value={formatUsd(priceUsd, 4)}
          muted={priceUsd === null}
          foot={
            priceUsd === null
              ? 'Could not be read from DexScreener.'
              : 'Deepest Solana pool, quoted live.'
          }
        />
        <Stat
          label="Market cap"
          value={formatCompactUsd(mcapUsd)}
          muted={mcapUsd === null}
          foot={mcapFoot}
        />
        <Stat
          label="ANSEM burned by us"
          value={ansemBurnedByUs === null ? '—' : formatAmount(ansemBurnedByUs, 2)}
          muted={ansemBurnedByUs === null || ansemBurnedByUs === 0}
          footnote="1"
          foot={
            ansemBurnedByUs === null
              ? 'Could not be read — the on-chain scan did not complete.'
              : 'Our burn instructions only, summed from chain.'
          }
        />
        <Stat
          label="Share of supply burned"
          value={formatPercent(burnedPct, 4)}
          muted={burnedPct === null || burnedPct === 0}
          foot={pctFoot}
        />
      </div>

      <div className="progress">
        <div className="progress__head">
          <span className="micro">Next buyback &amp; burn</span>
          <span className="progress__pct num">
            {pctFull === null ? '—' : `${pctFull}% of trigger`}
          </span>
        </div>

        <div className="progress__line">
          <strong
            className={`progress__value num${
              balanceSol === null ? ' progress__value--muted' : ''
            }`}
          >
            {accrued}
          </strong>
          <span className="progress__unit">SOL accrued</span>
          <span className="progress__of">
            trigger at {triggerSol} SOL
          </span>
        </div>

        <div
          className="progress__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={triggerSol}
          aria-valuenow={deployableSol ?? undefined}
          aria-valuetext={
            deployableSol === null
              ? 'Unknown — the balance could not be read'
              : `${formatSol(deployableSol, 2)} of ${triggerSol} SOL`
          }
          aria-label={`Progress toward the ${triggerSol} SOL buyback trigger`}
        >
          <div
            className="progress__fill"
            style={{ width: `${(fraction ?? 0) * 100}%` }}
          />
        </div>

        <p className="progress__foot">
          {balanceSol === null ? (
            <>
              The fee wallet balance could not be read this minute, so this is
              unknown rather than zero. It is a live RPC call on every refresh —
              there is nothing stored behind it.
            </>
          ) : (
            <>
              Next buyback &amp; burn at {triggerSol} SOL — currently {accrued}{' '}
              SOL accrued. The keeper fires on the balance less a {reserveSol}{' '}
              SOL transaction-fee reserve, market-buys $ANSEM through Jupiter,
              and destroys it with a Token-2022 <code>burnChecked</code>. Both
              transactions land on-chain and both are linked in the burn log.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
