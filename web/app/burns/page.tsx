import type { Metadata } from 'next';
import StatusRibbon from '@/components/StatusRibbon';
import { getActivity } from '@/lib/stats';
import { ANSEM, PRE_EXISTING_BURNED_ANSEM } from '@/lib/constants';
import { formatAmount, formatInt, formatSol, formatUtc, shortenAddress } from '@/lib/format';
import { SOLSCAN } from '@/lib/links';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Burn log',
  description:
    'Every $ANSEM burn transaction signed by this project, with the SOL that funded it and a link to the transaction on Solscan.',
};

export default async function BurnsPage() {
  const activity = await getActivity();
  // Same rule as the screener's `enumerationComplete`: a zero is only reportable
  // when the scan that would have found something actually ran to completion.
  // Real figures still render on a partial scan (they are a lower bound, and
  // `truncated` says so); it is specifically the *unverified zero* that must
  // not be printed as a measurement.
  const hasData =
    activity.burnTxCount > 0 ||
    activity.totalSolReceived > 0 ||
    activity.totalAnsemBurned > 0;
  const known = activity.scanComplete || hasData;
  const unknownFoot = 'Could not be read — the on-chain scan did not complete.';

  return (
    <>
      <StatusRibbon
        fetchedAt={activity.fetchedAt}
        stale={activity.stale}
        errors={activity.errors}
      />

      <section className="hero">
        <div className="shell">
          <div className="hero__label">
            <span className="micro">token-2022 burnChecked · ANSEM</span>
          </div>
          <h1>Burn log</h1>
          <p className="prose hero__lede">
            Every row is a transaction signed by this project&rsquo;s wallet that
            destroyed $ANSEM. The counter below sums those instructions and
            nothing else — it is not the difference in total supply, because{' '}
            {formatAmount(PRE_EXISTING_BURNED_ANSEM, 2)} ANSEM had already been
            burned by unrelated parties before this project existed. Burning
            removes tokens from circulation permanently and verifiably; that is
            the entire claim.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="stats">
            <div className="stat">
              <div className="micro">ANSEM burned by us</div>
              <div
                className={`stat__value${
                  !known || activity.totalAnsemBurned === 0
                    ? ' stat__value--muted'
                    : ''
                }`}
              >
                {known ? formatAmount(activity.totalAnsemBurned, 2) : '—'}
              </div>
              <div className="stat__foot">
                {known ? 'Sum of our burn instructions.' : unknownFoot}
              </div>
            </div>
            <div className="stat">
              <div className="micro">Burn transactions</div>
              <div
                className={`stat__value${
                  !known || activity.burnTxCount === 0 ? ' stat__value--muted' : ''
                }`}
              >
                {known ? formatInt(activity.burnTxCount) : '—'}
              </div>
              <div className="stat__foot">
                {known ? 'Each independently verifiable.' : unknownFoot}
              </div>
            </div>
            <div className="stat">
              <div className="micro">SOL received</div>
              <div
                className={`stat__value${
                  !known || activity.totalSolReceived === 0
                    ? ' stat__value--muted'
                    : ''
                }`}
              >
                {known ? formatSol(activity.totalSolReceived, 4) : '—'}
                {known ? <span className="stat__unit">SOL</span> : null}
              </div>
              {/* This is every positive lamport delta on the wallet, which is
                  not the same thing as routed creator fees — the wallet also
                  has to be funded for transaction fees. Do not relabel it as
                  fee revenue without splitting the two apart on-chain. */}
              <div className="stat__foot">
                {known
                  ? 'Every SOL credit to the fee wallet, including funding for transaction fees — not fee revenue alone.'
                  : unknownFoot}
              </div>
            </div>
            <div className="stat">
              <div className="micro">Pre-existing burns</div>
              <div className="stat__value stat__value--muted">
                {formatAmount(PRE_EXISTING_BURNED_ANSEM, 2)}
              </div>
              <div className="stat__foot">
                Burned by others before launch. Disclosed, never counted as ours.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">Transactions</h2>
            <span className="section__note">
              {!activity.scanComplete
                ? `scan incomplete — ${formatInt(
                    activity.parsedTransactions,
                  )} transaction(s) decoded, some reads did not return`
                : activity.truncated
                  ? `partial — ${formatInt(activity.parsedTransactions)} of ${formatInt(
                      activity.scannedSignatures,
                    )} wallet signatures decoded, most recent first`
                  : `${formatInt(activity.parsedTransactions)} wallet transaction${
                      activity.parsedTransactions === 1 ? '' : 's'
                    } decoded`}
            </span>
          </div>

          {activity.burns.length === 0 ? (
            <div className="table-wrap">
              {/* An empty burn log only means "nothing has burned" when the scan
                  that would have found a burn actually completed. If the walk
                  errored we do not know, and saying otherwise would be the one
                  kind of claim this site cannot make. */}
              {!activity.scanComplete ? (
                <div className="empty">
                  <div className="empty__title">
                    Scan incomplete — cannot report
                  </div>
                  <p className="empty__body">
                    The on-chain read that finds burn transactions did not
                    complete, so this table is blank because we could not look,
                    not because we looked and found nothing. Any counter above
                    reading &ldquo;—&rdquo; is unknown for the same reason, and
                    any figure it does show is a lower bound. It retries
                    automatically.
                  </p>
                </div>
              ) : (
                <div className="empty">
                  <div className="empty__title">First burn pending launch.</div>
                  <p className="empty__body">
                    No burn has happened yet. When the fee wallet first accrues
                    enough SOL, the keeper will buy $ANSEM and burn it, and the
                    transaction will appear here automatically — this table is
                    read from chain, not written by us.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data data--narrow">
                <caption className="sr-only">
                  ANSEM burn transactions signed by this project.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Time (UTC)</th>
                    <th scope="col" className="col-num">
                      SOL in
                    </th>
                    <th scope="col" className="col-num">
                      ANSEM burned
                    </th>
                    <th scope="col" className="col-num">
                      Slot
                    </th>
                    <th scope="col">Signature</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.burns.map((burn) => (
                    <tr key={burn.signature}>
                      <td className="num">{formatUtc(burn.blockTime)}</td>
                      <td className="col-num">
                        {burn.solIn === null ? (
                          <span
                            className="muted"
                            title="No matching buy transaction inside the scanned window."
                          >
                            —
                          </span>
                        ) : (
                          <a
                            className="link"
                            href={
                              burn.swapSignature
                                ? SOLSCAN.tx(burn.swapSignature)
                                : undefined
                            }
                            target="_blank"
                            rel="noreferrer noopener"
                            title="The buy transaction attributed to this burn"
                          >
                            {formatSol(burn.solIn, 4)}
                          </a>
                        )}
                      </td>
                      <td className="col-num">
                        {formatAmount(burn.ansemBurned, 2)}
                      </td>
                      <td className="col-num muted">{formatInt(burn.slot)}</td>
                      <td>
                        <a
                          className="addr link"
                          href={SOLSCAN.tx(burn.signature)}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {shortenAddress(burn.signature, 8, 8)}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="section__note" style={{ marginTop: '1rem' }}>
            &ldquo;SOL in&rdquo; is the SOL spent on the buy attributed to each
            burn. The swap and the burn are separate transactions, so attribution
            pairs a burn with the nearest preceding unattributed buy from the
            same wallet; where no match exists inside the scanned window the cell
            reads &ldquo;—&rdquo; rather than guessing. Burn amounts are read
            directly from the {ANSEM.symbol} burn instructions and are exact.
          </p>
        </div>
      </section>
    </>
  );
}
