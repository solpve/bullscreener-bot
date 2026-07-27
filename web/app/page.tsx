import Image from "next/image";
import Link from "next/link";
import ansemLogo from "@/public/ansem.png";
import heroBull from "@/public/images/hero-bull.png";
import logoMark from "@/public/images/logo-mark-v2.png";
import AnsemChart from "@/components/AnsemChart";
import AnsemEngine from "@/components/AnsemEngine";
import StatStrip from "@/components/StatStrip";
import ScreenerTable from "@/components/ScreenerTable";
import ScreenerTabs from "@/components/ScreenerTabs";
import Leaderboard from "@/components/Leaderboard";
import AddressBar from "@/components/AddressBar";
import EmbargoedAddress from "@/components/EmbargoedAddress";
import { getListings } from "@/lib/listings";
import { getStats } from "@/lib/stats";
import {
  ANSEM_PAIR_URL,
  ansemChartEmbedUrl,
  getAnsemMarket,
  getBuybackProgress,
} from "@/lib/ansem";
import {
  ANSEM,
  BULL_WALLET,
  KEEPER,
  LISTING,
  OPS_FEE,
  PROGRAMS,
  REVALIDATE_SECONDS,
  SPLIT,
} from "@/lib/constants";
import { SHOW_ADDRESS } from "@/lib/flags";
import {
  bpsToPercent,
  formatAmount,
  formatInt,
  formatSol,
  shortenAddress,
} from "@/lib/format";
import { SOLSCAN } from "@/lib/links";

export const revalidate = 60;

const STEPS = [
  {
    title: "Commit",
    body: (
      <>
        Two instructions on pump.fun&rsquo;s fee program. The second is
        one-shot — <code>admin_revoked = true</code> — and the routing is
        locked by the program itself. No take-backs.
      </>
    ),
  },
  {
    title: "Accrue",
    body: (
      <>
        The coin trades, creator fees stack in pump.fun&rsquo;s own vaults.
        Nobody has custody in the meantime — not the deployer, not us.
      </>
    ),
  },
  {
    title: "Crank",
    body: (
      <>
        Distribution is permissionless. The keeper cranks it on schedule and
        the program pays the burn wallet directly.
      </>
    ),
  },
  {
    title: "Buy & burn",
    body: (
      <>
        At {KEEPER.triggerSol} SOL the keeper takes its disclosed{" "}
        {bpsToPercent(OPS_FEE.bps)} fee as a visible transfer, sends the rest
        through Jupiter into $ANSEM, and <code>burnChecked</code>s it out of
        existence. Receipts in the burn log.
      </>
    ),
  },
];

/* Decorative, but every line is a claim the page already proves. */
const TICKER = [
  "the ultimate PVE",
  "every committed share → burn wallet",
  `full send ${bpsToPercent(LISTING.tiers.fullBps)} · project lane ${bpsToPercent(LISTING.tiers.partialMinBps)}+`,
  "irreversible by the deployer",
  `${KEEPER.triggerSol} SOL trigger`,
  "buy → burn → receipt",
  `${bpsToPercent(OPS_FEE.bps)} keeper fee · visible every cycle`,
  "no bullscreener token. ever.",
];

export default async function HomePage() {
  const [stats, listings, market, buyback] = await Promise.all([
    getStats(),
    getListings(),
    getAnsemMarket(),
    getBuybackProgress(),
  ]);

  // One-way door: the address only ever reaches the HTML behind the launch
  // flag — everything that renders it takes this gated value, never the
  // constant directly.
  const bullAddress = SHOW_ADDRESS ? BULL_WALLET : null;

  // Same rule StatStrip applies: a zero we read is a fact, a zero we failed to
  // read is not. Anything unknown is handed down as null and renders "—".
  const burnHistoryKnown =
    stats.historyComplete ||
    stats.burnTxCount > 0 ||
    stats.solReceived > 0 ||
    stats.ansemBurnedByUs > 0;

  const shareToBurns = SPLIT.shareholders[0]?.bps ?? 10_000;

  // The two lanes the screener tabs split on. Every discovered config lands in
  // exactly one — below-floor coins sit in the project lane with a failed
  // share criterion, never hidden.
  const fullLane = listings.tokens.filter((t) => t.tier === "full");
  const partialLane = listings.tokens.filter((t) => t.tier === "partial");

  return (
    <>
      <AddressBar address={bullAddress} />

      <section className="hero hero--stage">
        <div className="shell hero__stage">
          <p className="hero__eyebrow micro">
            pump.fun creator fee sharing · solana mainnet
          </p>

          <div className="hero__bull" aria-hidden="true">
            <Image
              src={heroBull}
              alt=""
              priority
              sizes="(max-width: 46rem) 72vw, 416px"
            />
          </div>

          <h1>
            The ultimate <em>PVE</em>.
          </h1>

          <p className="prose hero__lede">
            {/* Present tense would assert that deployers are already doing
                this. The table below is the only thing allowed to say how
                many actually have. */}
            Creator fees in. $ANSEM burned. Proved on-chain. One address,
            two lanes: would-be cashback coins send the full{" "}
            {bpsToPercent(shareToBurns)}, projects commit{" "}
            {bpsToPercent(LISTING.tiers.partialMinBps)}+ and keep the rest
            — either way it&rsquo;s locked by pump.fun&rsquo;s own program,
            provably out of the dev&rsquo;s hands. The engine buys $ANSEM
            and burns it, minus a disclosed {bpsToPercent(OPS_FEE.bps)}{" "}
            keeper fee that moves in the open.{" "}
            <strong>Permanent, verifiable supply reduction</strong>{" "}
            — the only thing promised, because it&rsquo;s the only thing
            the chain can prove.
          </p>

          <div className="hero__actions">
            <Link className="btn btn--primary" href="/route-your-fees">
              Route your fees →
            </Link>
            <Link className="btn" href="/burns">
              Burn log
            </Link>
            <a className="btn" href="/api/v1/criteria">
              Criteria as JSON
            </a>
          </div>

          {/* Live vitals. Every value obeys the StatStrip suppression rule:
              a value we failed to read renders "—", never a zero. */}
          <dl className="hero__pulse">
            <div>
              <dt>Next burn at</dt>
              <dd className="num">
                {formatSol(buyback.balanceSol, 2)}
                <span className="muted"> / {buyback.triggerSol} SOL</span>
              </dd>
            </div>
            <div>
              <dt>ANSEM burned by us</dt>
              <dd className="num">
                {burnHistoryKnown ? formatAmount(stats.ansemBurnedByUs, 2) : "—"}
              </dd>
            </div>
            <div>
              <dt>Configs routing</dt>
              <dd className="num">{formatInt(listings.discovered)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="ticker" role="presentation">
        <div className="ticker__inner">
          {[0, 1].map((copy) => (
            <div
              className="ticker__set"
              key={copy}
              aria-hidden={copy === 1 ? "true" : undefined}
            >
              {TICKER.map((t) => (
                <span className="ticker__item" key={t}>
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <section className="section section--band">
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">
              <span className="section__index">01</span>Scoreboard
            </h2>
            <span className="section__note">
              derived from chain · cached {REVALIDATE_SECONDS}s
            </span>
          </div>
          <StatStrip stats={stats} />
          {stats.truncated ? (
            <div className="notice" style={{ marginTop: "1rem" }}>
              <div>
                The signature walk hit its scan cap, so these totals cover the
                most recent window only. Treat them as a lower bound until the
                indexed history ships.
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="section" id="screener">
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">
              <span className="section__index">02</span>Leaderboard
            </h2>
            <span className="section__note">
              crown = the {bpsToPercent(LISTING.tiers.fullBps)} lane · rank =
              market cap · {formatInt(listings.discovered)} config
              {listings.discovered === 1 ? "" : "s"} routing ·{" "}
              {formatInt(listings.tokens.filter((t) => t.listed).length)} listed
            </span>
          </div>
          <Leaderboard listings={listings} />
          <ScreenerTabs
            tabs={[
              {
                id: "full",
                label: `Full send · ${bpsToPercent(LISTING.tiers.fullBps)}`,
                count: fullLane.length,
                content: (
                  <ScreenerTable
                    listings={listings}
                    tokens={fullLane}
                    lane="full"
                  />
                ),
              },
              {
                id: "partial",
                label: `Project lane · ${bpsToPercent(LISTING.tiers.partialMinBps)}+`,
                count: partialLane.length,
                content: (
                  <ScreenerTable
                    listings={listings}
                    tokens={partialLane}
                    lane="partial"
                  />
                ),
              },
            ]}
          />
          <div className="stack-sm" style={{ marginTop: "1rem" }}>
            <p className="section__note">
              The bar: config Active · <code>admin_revoked</code> ·{" "}
              {bpsToPercent(LISTING.tiers.fullBps)} to the burn wallet (full
              send) or {bpsToPercent(LISTING.tiers.partialMinBps)}+ (project
              lane) · ${formatInt(LISTING.minMarketCapUsd)}+ mcap ·{" "}
              {formatInt(LISTING.minHolders)}+ holders · no cashback coins
              (their fees are protocol-locked to volume farmers, forever).
              Fresh-wallet check (max {LISTING.maxFreshWalletPct}%) ships in
              v1.1 and is labeled <em>pending</em> — never silently scored.{" "}
              {listings.holdersProvider === "unavailable"
                ? "Holder counts read unverified until a holder index is configured — and an unverified check never counts as a pass."
                : null}
            </p>
          </div>
        </div>
      </section>

      <section className="section section--burn">
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">
              <span className="section__index">03</span>The burn engine
            </h2>
            <span className="section__note">
              read from chain · cached {REVALIDATE_SECONDS}s
            </span>
          </div>

          <div className="enginegrid">
            <div className="enginegrid__main">
              <AnsemEngine
                priceUsd={market.priceUsd}
                reportedMcapUsd={market.reportedMcapUsd}
                supply={stats.ansemSupply}
                ansemBurnedByUs={burnHistoryKnown ? stats.ansemBurnedByUs : null}
                balanceSol={buyback.balanceSol}
                deployableSol={buyback.deployableSol}
                triggerSol={buyback.triggerSol}
                reserveSol={buyback.reserveSol}
                fraction={buyback.fraction}
              />
            </div>

            <div className="enginegrid__side">
              <div className="tokenid">
                <Image
                  className="tokenid__logo"
                  src={ansemLogo}
                  alt="The Black Bull, the $ANSEM token logo"
                  width={64}
                  height={64}
                  placeholder="blur"
                />
                <div>
                  <div className="tokenid__name">{ANSEM.name}</div>
                  <div className="tokenid__meta">
                    <a
                      className="link"
                      href={SOLSCAN.token(ANSEM.mint)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      ${ANSEM.symbol}
                    </a>
                    <span aria-hidden="true">·</span>
                    <span>Token-2022</span>
                    <span aria-hidden="true">·</span>
                    <span className="nowrap">
                      {shortenAddress(ANSEM.mint, 4, 4)}
                    </span>
                  </div>
                </div>
              </div>

              <AnsemChart
                darkSrc={ansemChartEmbedUrl("dark")}
                lightSrc={ansemChartEmbedUrl("light")}
                pairUrl={ANSEM_PAIR_URL}
              />
            </div>
          </div>

          <div className="notice notice--warn" style={{ marginTop: "1.5rem" }}>
            <div>
              <strong>No bullscreener token. Ever.</strong>{" "}
              Any &ldquo;bullscreener&rdquo; coin you see is a scam — not us.
              The only token here is ${ANSEM.symbol}: bought on the open
              market, destroyed on sight.
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">
              <span className="section__index">04</span>The thesis
            </h2>
            <span className="section__note">cashback vs the burn</span>
          </div>
          <div className="thesis">
            <p className="prose">
              Cashback was pump.fun&rsquo;s answer to greedy devs banking every
              fee and doing nothing for the coin. Fair. But look at who it
              actually pays: up on the coin? The cashback is negligible. Down?
              It covers nothing. The only real winners are volume farmers
              grinding the accumulator — and the flag locks at launch, so those
              fees feed farmers forever.
            </p>
            <p className="prose">
              This is the other answer. The dev routes 100% of the creator fees
              to one wallet, revoked on-chain, provably out of their hands —
              and that wallet does exactly one thing: buy $ANSEM and burn it.
              Every fee becomes permanent supply destruction instead of farmer
              food.
            </p>
            <p className="prose">
              Building a real project and need your fees? There&rsquo;s a lane
              for that too: commit{" "}
              {bpsToPercent(LISTING.tiers.partialMinBps)} or more, keep the
              rest, still make the board. Only the full send gets crowned.
            </p>
          </div>
          <p className="thesis__punch">Feed the burn, not the farmers.</p>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">
              <span className="section__index">05</span>The loop
            </h2>
            <span className="section__note">
              {bpsToPercent(LISTING.tiers.partialMinBps)}–
              {bpsToPercent(shareToBurns)} routed on-chain ·{" "}
              {bpsToPercent(OPS_FEE.bps)} keeper fee
            </span>
          </div>

          <div className="mech">
            <div className="flow">
              {STEPS.map((step, i) => (
                <div className="flow__step" key={step.title}>
                  <div className="flow__index">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div className="flow__title">{step.title}</div>
                  <p className="flow__body">{step.body}</p>
                </div>
              ))}
            </div>

            <aside
              className="panel panel--ticked specplate"
              aria-label="Parameters"
            >
              <div className="micro specplate__head">Parameters</div>
              <dl className="specplate__list">
                <div className="specrow">
                  <dt>Fee program</dt>
                  <dd>
                    <a
                      className="link"
                      href={SOLSCAN.account(PROGRAMS.pumpFees)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {shortenAddress(PROGRAMS.pumpFees, 6, 5)}
                    </a>
                  </dd>
                </div>
                <div className="specrow">
                  <dt>Routed</dt>
                  <dd>
                    {bpsToPercent(shareToBurns)} full send ·{" "}
                    {bpsToPercent(LISTING.tiers.partialMinBps)}+ project lane
                  </dd>
                </div>
                <div className="specrow">
                  <dt>Ops fee</dt>
                  <dd>{bpsToPercent(OPS_FEE.bps)} · keeper, per cycle</dd>
                </div>
                <div className="specrow">
                  <dt>Burn trigger</dt>
                  <dd>{KEEPER.triggerSol} SOL</dd>
                </div>
                <div className="specrow">
                  <dt>Burn target</dt>
                  <dd>
                    <a
                      className="link"
                      href={SOLSCAN.token(ANSEM.mint)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      ${ANSEM.symbol}
                    </a>{" "}
                    <span className="muted">Token-2022</span>
                  </dd>
                </div>
                <div className="specrow">
                  <dt>Min market cap</dt>
                  <dd>${formatInt(LISTING.minMarketCapUsd)}</dd>
                </div>
                <div className="specrow">
                  <dt>Min holders</dt>
                  <dd>{formatInt(LISTING.minHolders)}</dd>
                </div>
                <div className="specrow">
                  <dt>Deposit address</dt>
                  <dd>
                    <EmbargoedAddress address={bullAddress} />
                  </dd>
                </div>
              </dl>
            </aside>
          </div>

          {/* The irreversibility claim must not travel without its limits, and
              the deployer page is not the only surface people read. */}
          <p className="section__note" style={{ marginTop: "1rem" }}>
            &ldquo;Irreversible&rdquo; means exactly one thing:{" "}
            <code>admin_revoked = true</code>, after which the program refuses
            any further share update from the deployer. It does not bind
            pump.fun itself — its admin keeps a reset instruction, disclosed
            rather than hidden. We gate on it and never list the revocable v1
            path.{" "}
            <Link className="link" href="/route-your-fees">
              Full caveats
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="ctaband">
        <div className="ctaband__mark" aria-hidden="true">
          <Image src={logoMark} alt="" sizes="352px" />
        </div>
        <div className="shell ctaband__inner">
          <h2 className="ctaband__title">
            Pick your lane. <em>Feed the burn.</em>
          </h2>
          <p className="ctaband__sub">
            The full send routes {bpsToPercent(LISTING.tiers.fullBps)} and
            competes for the crown. The project lane routes{" "}
            {bpsToPercent(LISTING.tiers.partialMinBps)}+ and keeps the rest.
            Both are locked by pump.fun&rsquo;s own fee program — irreversibly
            by the deployer — and every burn lands on-chain with a receipt.
          </p>
          <div className="hero__actions">
            <Link className="btn btn--primary" href="/route-your-fees">
              Route your fees →
            </Link>
            <Link className="btn" href="/burns">
              Watch the burns
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
