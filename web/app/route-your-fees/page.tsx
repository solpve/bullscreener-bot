import type { Metadata } from 'next';
import EmbargoedAddress from '@/components/EmbargoedAddress';
import {
  BULL_WALLET,
  KEEPER,
  LISTING,
  OPS_FEE,
  OPS_WALLET,
  PROGRAMS,
  SPLIT,
} from '@/lib/constants';
import { SHOW_ADDRESS, EMBARGO_SHORT, OPS_EMBARGO_LABEL } from '@/lib/flags';
import { bpsToPercent, formatInt } from '@/lib/format';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Route your fees',
  description:
    'Point your pump.fun coin’s creator fees at the burn wallet from pump.fun’s own interface — 100% full send or 20%+ project lane, no wallet connection to this site, ever. The steps, the fee, the listing criteria and the caveats, in full.',
  alternates: { canonical: '/route-your-fees' },
};

/**
 * The whole flow happens inside pump.fun's creator dashboard. This site hosts
 * instructions and verification only — there is deliberately nothing here to
 * connect a wallet to, and never will be.
 */
const UI_STEPS = [
  {
    title: 'Open your coin on pump.fun',
    body: 'Sign in with the wallet that deployed the coin and open its page. Only the creator wallet can change fee sharing, so nothing works from anywhere else.',
  },
  {
    title: 'Open creator rewards',
    body: 'In the coin’s creator rewards panel, choose to share your rewards. Claim any fees you have already accrued first — they do not follow the config.',
  },
  {
    title: 'Pick your lane',
    body: `Full send: the burn wallet as the ONLY entry at ${bpsToPercent(LISTING.tiers.fullBps)} — the cashback-killer commit, and the only lane the leaderboard crowns. Project lane: add the burn wallet at ${bpsToPercent(LISTING.tiers.partialMinBps)} or more alongside your own shareholders and keep the rest for the team.`,
  },
  {
    title: 'Lock it',
    body: 'Confirm. pump.fun runs the one-shot v2 instruction, sets admin_revoked = true, and the panel shows the config as Locked with the burn wallet at your committed share. From that moment neither you nor we can change it.',
  },
  {
    title: 'Watch it list',
    body: 'Once the coin clears the listing bar below, it appears on the screener automatically. There is nothing to submit and nobody to contact.',
  },
];

const BULL_BPS = SPLIT.shareholders[0]?.bps ?? 10_000;
/**
 * Percentages are what the page says everywhere. The raw basis points survive
 * only inside the instruction template below, because that is the literal
 * value `update_fee_shares_v2` takes — showing "100" there would build a
 * broken config.
 */
const BULL_PCT = bpsToPercent(BULL_BPS);
const OPS_PCT = bpsToPercent(OPS_FEE.bps);
/**
 * config/constants.json settles this: `split.rebate.enabled = false`, with the
 * policy note "no rebates are computed, owed, or advertised anywhere". This
 * page must describe the flat terms and promise nothing on top of them.
 */
const REBATE_ENABLED = SPLIT.rebate.enabled;

export default function RouteYourFeesPage() {
  // The deposit address is a one-way door — once it is baked into a coin's
  // config it can never be rotated. It renders only behind the launch flag.
  const bullAddress = SHOW_ADDRESS ? BULL_WALLET : null;
  const opsAddress = SHOW_ADDRESS ? OPS_WALLET : null;

  const bullSlot = bullAddress ?? `<burn wallet — ${EMBARGO_SHORT}>`;

  return (
    <>
      <section className="hero">
        <div className="shell">
          <div className="hero__label">
            <span className="micro">for deployers · pump.fun fee sharing</span>
          </div>
          <h1>Route your fees</h1>
          <p className="prose hero__lede">
            One address, set once, in pump.fun&rsquo;s own UI — and two lanes.
            Full send: burn wallet, {BULL_PCT}, sole recipient, eligible for
            the crown. Project lane: burn wallet at{' '}
            {bpsToPercent(LISTING.tiers.partialMinBps)}+ next to your own
            shareholders, keep the rest. Either way it locks. Nothing to
            connect here — ever. After the lock, neither you nor we can touch
            the routing. Skim the caveats below before you pull the trigger.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">In pump.fun, in a minute</h2>
            <span className="section__note">
              one address · two lanes · locked
            </span>
          </div>

          <p className="prose rf-lede">
            Everything happens in pump.fun&rsquo;s creator dashboard — we never
            touch your keys and never ask for a signature. This page hands you
            one address and shows you what the chain says afterwards.
          </p>

          <div className="flow">
            {UI_STEPS.map((step, i) => (
              <div className="flow__step" key={step.title}>
                <div className="flow__index">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div className="flow__title">{step.title}</div>
                <p className="flow__body">{step.body}</p>
              </div>
            ))}
          </div>

          <dl className="kv" style={{ marginTop: '1.5rem' }}>
            <dt>Burn wallet</dt>
            <dd>
              <EmbargoedAddress address={bullAddress} /> ·{' '}
              <span className="num">{BULL_PCT}</span>{' '}
              <span className="muted">
                full send ({formatInt(BULL_BPS)} bps, sole recipient) — or{' '}
                {formatInt(LISTING.tiers.partialMinBps)}+ bps project lane
              </span>
            </dd>
            <dt>Fee program</dt>
            <dd className="addr">{PROGRAMS.pumpFees}</dd>
          </dl>
        </div>
      </section>

      <section className="section">
        {/* .doc nests inside .shell rather than sharing the element, so the
            reading column starts on the same rail as the hero above it. */}
        <div className="shell">
          <div className="section__head">
            <h2 className="section__title">Under the hood</h2>
            <span className="section__note">
              the two instructions pump.fun runs for you
            </span>
          </div>
          <div className="doc">
          {!SHOW_ADDRESS ? (
            <div className="notice notice--embargo">
              <div>
                <strong>The deposit address is withheld until launch.</strong>{' '}
                Because the address is baked irreversibly into every coin that
                commits, we publish it once and never again. Do not use an
                address for this that you found anywhere else.
              </div>
            </div>
          ) : null}

          <h2>The two instructions</h2>
          <p className="prose">
            pump.fun&rsquo;s interface runs both against its fee program{' '}
            <code>{PROGRAMS.pumpFees}</code>, and tooling that speaks Solana can
            run them directly. The first creates the config and migrates your
            fee vaults to it; the second sets the recipient and burns the admin
            authority in the same call.
          </p>

          <div className="codeblock" role="figure" aria-label="Fee sharing setup">
            {`// 1 — create the config (also rewrites bonding_curve.creator, and
//     pool.coin_creator if your coin has already graduated)
create_fee_sharing_config
  program   ${PROGRAMS.pumpFees}
  seeds     ['sharing-config', <your mint>]

// 2 — set the routing. One-shot: this call sets admin_revoked = true.
// FULL SEND — the burn wallet as the only entry:
update_fee_shares_v2
  shareholders [
    { address: ${bullSlot}, share_bps: ${BULL_BPS} },  // ${BULL_PCT} — sole recipient
  ]

// PROJECT LANE — the burn wallet at >= ${LISTING.tiers.partialMinBps} bps
// (${bpsToPercent(LISTING.tiers.partialMinBps)}+) alongside your own shareholders.
// The program takes basis points; all entries must sum to exactly 10000.`}
          </div>

          <h2>What &ldquo;irreversible&rdquo; means here</h2>
          <p className="prose">
            Specifically and only this:{' '}
            <code>update_fee_shares_v2</code> sets{' '}
            <code>admin_revoked = true</code> on your sharing config, and the
            program will not accept another share update afterwards. That is the
            claim the screener gates on, and it is why the table shows an{' '}
            <em>irreversible</em> chip per coin rather than as a blanket
            statement.
          </p>
          <p className="prose">
            It is worth being precise about what this does not mean. The same
            program also exposes a v1 <code>update_fee_shares</code> that stays
            revocable until <code>revoke_fee_sharing_authority</code> is called,
            plus <code>transfer_fee_sharing_authority</code>. A config set up
            through that path is not irreversible, and we do not list it. If
            your tooling offers you the v1 path, it is the wrong one.
          </p>

          <h2>The fee, stated exactly</h2>
          <p className="prose">
            <strong>
              Whatever share you commit — {BULL_PCT} on the full send,{' '}
              {bpsToPercent(LISTING.tiers.partialMinBps)}+ on the project lane
              — the fee program pays the burn wallet directly.
            </strong>{' '}
            Your fees never pass through any other account of ours on the way
            in.
          </p>
          <p className="prose">
            Each buyback cycle, the open-source keeper first moves a disclosed{' '}
            {OPS_PCT} operations fee from the burn wallet to the ops wallet
            {opsAddress ? (
              <>
                {' '}
                (<EmbargoedAddress address={opsAddress} />)
              </>
            ) : (
              <>
                {' '}
                (
                <span className="chip chip--unverified chip--phrase">
                  {SHOW_ADDRESS ? 'not yet configured' : OPS_EMBARGO_LABEL}
                </span>
                )
              </>
            )}{' '}
            as a plain transfer, then buys $ANSEM with everything else and burns
            it. Straight talk: the routing is program-enforced; the {OPS_PCT}{' '}
            fee is not — it&rsquo;s taken by open-source keeper code and lands
            on-chain every cycle where anyone can watch it. Audit it, then hold
            us to it.
          </p>
          {REBATE_ENABLED ? null : (
            <p className="prose">
              Same terms for every coin, at every size, in both lanes. No
              rebates, no negotiated rates, nothing sold off-chain — placement
              is earned on-chain by the share you route and the bar you clear,
              and deliberately nothing else exists to have to trust us about.
            </p>
          )}

          <h2>Listing criteria</h2>
          <p className="prose">
            Committing your fees is what routes the money. Getting listed on the
            screener is a separate, stricter bar — a coin can be routing fees and
            still show as excluded here. Every check below is evaluated live and
            shown per-coin with its result.
          </p>
          <ul>
            <li>
              <strong>Config active</strong> — <code>status == Active</code>.
            </li>
            <li>
              <strong>Irreversible</strong> — <code>admin_revoked == true</code>,
              i.e. the v2 path.
            </li>
            <li>
              <strong>Share to burns</strong> — the burn wallet holds{' '}
              {bpsToPercent(LISTING.tiers.fullBps)} of the config as its only
              shareholder (full send), or at least{' '}
              {bpsToPercent(LISTING.tiers.partialMinBps)} alongside yours
              (project lane). Only the full send ranks on the podium.
            </li>
            <li>
              <strong>Vault migrated</strong> —{' '}
              <code>bonding_curve.creator</code> equals your sharing config PDA,
              which proves the fee vaults actually moved.
            </li>
            <li>
              <strong>Market cap</strong> — at or above $
              {formatInt(LISTING.minMarketCapUsd)}. We take the lower of
              DexScreener&rsquo;s reported figure and supply x price, because the
              reported field is wrong often enough to matter.
            </li>
            <li>
              <strong>Holders</strong> — at least{' '}
              {formatInt(LISTING.minHolders)} addresses with a non-zero balance.
              Where no holder index is configured this reads{' '}
              <em>unverified</em>; it is never estimated.
            </li>
            <li>
              <strong>Not a cashback coin</strong> —{' '}
              <code>is_cashback_coin == false</code>.
            </li>
            <li>
              <strong>Fresh wallets</strong> — no more than{' '}
              {LISTING.maxFreshWalletPct}% of supply held by newly created
              wallets. Specified but <em>not yet enforced</em>; it ships in v1.1
              and is displayed as pending until then.
            </li>
          </ul>

          <h2>Cashback coins cannot participate</h2>
          <p className="prose">
            If your coin was launched with the cashback flag, its creator fee is
            paid out to traders by the protocol through volume-accumulator
            accounts. The flag is locked at launch and there is no CTO path that
            changes it, so those fees can never reach a burn wallet — no
            configuration on your side or ours fixes it. The screener reads{' '}
            <code>BondingCurve.is_cashback_coin</code> directly and excludes
            those coins permanently.
          </p>

          <h2>Caveats — read before committing</h2>
          <ul>
            <li>
              <strong>pump.fun retains an override.</strong> The fee program
              exposes <code>reset_fee_sharing_config_v2</code> to its own admin.
              Your revocation binds you; it does not bind pump.fun. We have not
              been able to prove the exact authority gating on that instruction,
              so we disclose it rather than talk around it.
            </li>
            <li>
              <strong>Fees already accrued do not come with you.</strong> Fees
              that accumulated before the config change are swept to the previous
              recipient list — normally you. Claim them first if you want them.
            </li>
            <li>
              <strong>This is one-way.</strong> There is no undo, no grace
              period, and no support ticket. If you change your mind after you
              lock it, the answer is no.
            </li>
            <li>
              <strong>Creator fees can be small, or zero.</strong>{' '}
              The creator share decays as market cap rises, and it is 0% on
              every venue other than pump.fun&rsquo;s own. A coin that trades mostly
              elsewhere may route almost nothing. The keeper only acts once{' '}
              {KEEPER.triggerSol} SOL has accrued.
            </li>
            <li>
              <strong>Listing is not payment and not an endorsement.</strong>{' '}
              We do not price-support anything, and nothing on this site is a
              claim about your coin&rsquo;s price or anyone&rsquo;s returns.
            </li>
            <li>
              <strong>We will never launch a token.</strong>{' '}
              Not now, not later. Any &ldquo;bullscreener&rdquo; coin is a scam.
            </li>
          </ul>
          </div>
        </div>
      </section>
    </>
  );
}
