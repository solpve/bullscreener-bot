import Link from 'next/link';
import { GITHUB_REPO, SOLSCAN } from '@/lib/links';

export default function Footer({
  ansemMint,
  preExistingBurned,
}: {
  ansemMint: string;
  preExistingBurned: string;
}) {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer__grid">
          <div className="footer__col">
            <h2 className="footer__h">bullscreener</h2>
            <ul className="footer__list">
              {/* This line renders on every page, so it cannot carry a blanket
                  "irreversible" claim — the qualifier travels with it. */}
              <li>
                A public screener for pump.fun coins whose creator fees are
                routed into $ANSEM buybacks and burns under a fee-sharing config
                with <code>admin_revoked = true</code>.
              </li>
              <li className="muted">
                Every number on this site is read from chain at request time.
                There is no database.
              </li>
              <li>
                <a
                  className="link"
                  href={GITHUB_REPO}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Source code on GitHub
                </a>{' '}
                — the keeper bot and this site, open for audit.
              </li>
            </ul>
          </div>
          <div className="footer__col">
            <h2 className="footer__h">Pages</h2>
            <ul className="footer__list">
              <li>
                <Link href="/">Screener</Link>
              </li>
              <li>
                <Link href="/burns">Burn log</Link>
              </li>
              <li>
                <Link href="/route-your-fees">Route your fees</Link>
              </li>
            </ul>
          </div>
          <div className="footer__col">
            <h2 className="footer__h">API</h2>
            <ul className="footer__list">
              <li>
                <a href="/api/v1/tokens">/api/v1/tokens</a>
              </li>
              <li>
                <a href="/api/v1/stats">/api/v1/stats</a>
              </li>
              <li>
                <a href="/api/v1/burns">/api/v1/burns</a>
              </li>
              <li>
                <a href="/api/v1/criteria">/api/v1/criteria</a>
              </li>
            </ul>
          </div>
          <div className="footer__col">
            <h2 className="footer__h">Burn target</h2>
            <ul className="footer__list">
              <li>$ANSEM — The Black Bull</li>
              <li>
                <a
                  className="link break-any"
                  href={SOLSCAN.token(ansemMint)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {ansemMint}
                </a>
              </li>
              <li className="muted">Token-2022. Burns use burnChecked.</li>
            </ul>
          </div>
        </div>

        <div className="footnotes">
          <p>
            <sup>1</sup>
            The burn counter sums only burn instructions signed by this
            project&rsquo;s wallet. A separate {preExistingBurned} ANSEM was
            burned by unrelated parties before this project existed; that
            baseline is disclosed here and is never included in our total.
          </p>
          <p>
            <strong>There is no bullscreener token and there never will be.</strong>{' '}
            If you see a &ldquo;bullscreener&rdquo; coin, it is a scam. This
            project is a wallet, a keeper and this website — nothing else.
          </p>
          <p>
            Burning removes tokens from the supply permanently and verifiably.
            Nothing here is a prediction, a claim about price, or investment
            advice. Fee revenue can be zero.{' '}
            <Link className="link" href="/route-your-fees">
              What &ldquo;irreversible&rdquo; does and does not cover
            </Link>
            , including the override pump.fun retains over its own fee program.
          </p>
        </div>
      </div>
    </footer>
  );
}
