# bullscreener keeper bot

The permissionless crank + buyback-and-burn engine.

Every 15 minutes it cranks pump.fun's `transfer_creator_fees_to_pump_v2` →
`distribute_creator_fees_v2` for every coin whose `SharingConfig` routes fees to
the BULL wallet. When the wallet clears the trigger it market-buys $ANSEM through
Jupiter and burns the entire position with Token-2022 `burnChecked`. Every step
is written to an append-only JSONL ledger so the site can prove it.

Nothing in here decides policy: addresses, splits, thresholds, endpoints and the
account layout all come from **`../config/constants.json`**, which is read at
runtime. Do not copy those values into code.

---

## Setup

```bash
cd bot
npm install
cp .env.example .env      # then edit
npm run typecheck
npm test
```

Node 22 + npm. No native build dependencies.

### Environment variables

| Var | Meaning |
|---|---|
| `RPC_URL` | Solana RPC. Defaults to `constants.endpoints.defaultRpc` (public mainnet-beta — fine for dry runs, too rate-limited for production). |
| `KEYPAIR_PATH` | Path to the BULL wallet keypair (JSON byte array). **Unset ⇒ `DRY_RUN` is forced on.** |
| `DRY_RUN` | `false` goes live. Anything else, or unset, stays in dry run. |
| `OPS_KEYPAIR_PATH` | Ops wallet key. Only read by `rebates -- --send`. |
| `JUPITER_API_KEY` | Optional Jupiter portal key. |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. |

`bot/.env` is loaded automatically; real environment variables always win over it.

---

## Dry-run-first workflow

The bot starts safe and stays safe until you take two explicit steps.

1. **`npm run status`** — reads the ledger and the chain, writes nothing. Shows
   the mode, wallets, the derived ANSEM Token-2022 ATA, ledger totals, any open
   cycle, and the honest burn accounting.
2. **`npm run once`** with no `KEYPAIR_PATH` — one full pass in forced dry run.
   It discovers configs, simulates the crank for each coin (including the real
   distribute bundle), quotes Jupiter, runs the circuit breakers, and logs
   exactly what it *would* send. It signs and broadcasts nothing.
3. Set `KEYPAIR_PATH` but leave `DRY_RUN=true`. Same as above, except the real
   signer's pubkey is used for simulations, so account-resolution problems
   surface. Still nothing is sent.
4. Replace `wallets.ops` in `config/constants.json` with the real ops wallet.
   Live mode **refuses to start** while it is `REPLACE_WITH_OPS_WALLET`.
5. Fund the BULL wallet above `keeper.reserveSol`, set `DRY_RUN=false`, and run
   `npm run once` before ever starting the loop.

**In dry run the ledger stays clean of fiction.** Cycle / swap / burn events are
never written, because they would describe transactions that did not happen.
Inflow, crank-attribution and rebate-accrual records *are* written even in dry
run — those describe confirmed on-chain facts and are true either way.

**Dry run never resumes an open cycle.** Advancing a cycle is not a read: a cycle
sitting in `PENDING` or `SWAP_CONFIRMED` is moved forward by *signing and
broadcasting* a swap or a burn. So if the ledger has an open cycle, a dry run
reports it and stops — it does not touch it, and does not fall through to the
quote-only pass either (a live run would be blocked by that cycle too). Resuming
a half-finished cycle is a `DRY_RUN=false` operation, by design.

---

## Commands

| Command | What it does |
|---|---|
| `npm run keeper` | The loop. Cranks every `keeper.crankIntervalSec` (900s), checks inflows + the buyback trigger every `keeper.pollIntervalSec` (45s). Handles SIGINT/SIGTERM by finishing the current pass. |
| `npm run once` | Exactly one pass: crank → observe inflows → buyback + burn. |
| `npm run status` | Human-readable ledger + on-chain summary. Read-only. |
| `npm run rebates` | Reports accrued ops rebates. `npm run rebates -- --send` settles them (see below). |
| `npm run test` | vitest. |
| `npm run typecheck` | `tsc --noEmit`, strict. |

### Kill switch

```bash
touch bot/KILLSWITCH     # loop idles and logs, process stays up
rm bot/KILLSWITCH        # resumes on the next poll
```

`once` refuses to do anything while the file exists.

---

## How a buyback cycle works

```
                    balance - reserveSol >= triggerSol
                                  │
                    ┌─────────────▼─────────────┐
        ┌──────────►│          PENDING          │
        │           └─────────────┬─────────────┘
        │              sign → persist sig → broadcast
        │           ┌─────────────▼─────────────┐
        │           │         SWAP_SENT         │──failed/expired──┐
        │           └─────────────┬─────────────┘                  │
        │            getSignatureStatuses says confirmed           │
        │           ┌─────────────▼─────────────┐                  │
        │      ┌───►│      SWAP_CONFIRMED       │                  │
        │      │    └─────────────┬─────────────┘                  │
        │      │   read FULL ATA balance → sign → persist → send   │
        │      │    ┌─────────────▼─────────────┐                  │
        │      └────│         BURN_SENT         │                  │
        │  retry    └─────────────┬─────────────┘                  ▼
        │                         ▼                            ABORTED
        └── next trigger        DONE
```

Three rules make this safe to crash at any point:

1. **The signature is persisted before the transaction is broadcast.** Signing is
   deterministic, so the signature is known before `sendRawTransaction`.
2. **A stored signature is always resolved with `getSignatureStatuses` before
   anything else happens.** A swap is never re-sent. If the status is unknown but
   the blockhash is still valid the cycle waits; only once
   `blockHeight > lastValidBlockHeight` is it declared expired and aborted, which
   is safe because the SOL was never spent.
3. **The burn always burns the entire ATA balance**, which makes it idempotent —
   a burn that actually landed leaves nothing to burn. That is also why the
   `BURN_SENT → SWAP_CONFIRMED` retry edge exists.

The balance-derived trigger is the second safety net: an aborted cycle simply
leaves the SOL in the wallet, and the next poll re-fires. If a swap landed but
its cycle was aborted, the **orphan sweep** at the start of each pass burns the
stranded tokens before any new SOL is spent.

Larger balances are split into chunks of at most `keeper.maxSolPerSwap`; a
trailing remainder below `keeper.triggerSol` is left in the wallet rather than
swapped at an awkward size. The balance is re-read for every chunk.

---

## Circuit breakers (swap path)

A swap is refused — the cycle aborts rather than "trying smaller" — when:

- `priceImpactPct` from the Jupiter quote exceeds `keeper.maxPriceImpactPct`;
- the implied SOL-per-ANSEM price deviates from an **independent DexScreener
  reference** by more than `keeper.maxRefPriceDeviationPct`;
- **no reference price is available at all.** This fails *closed* deliberately:
  an unverifiable quote is not executed.

Swap requests use Jupiter Swap API v1 only, with `dynamicSlippage: true`
(fallback `keeper.slippageBpsFallback`), `dynamicComputeUnitLimit: true` and
`prioritizationFeeLamports.priorityLevelWithMaxLamports` from constants. The
Ultra API is never used (it skims 5–10 bps off every swap) and `platformFeeBps`
is never sent.

---

## Ledger

Append-only JSONL at `bot/state/ledger.jsonl` (`state/` is gitignored). One event
per line:

| `type` | Meaning |
|---|---|
| `inflow` | SOL credited to the BULL wallet, with `sourceMint` when provable and how (`own_crank` / `distribute_event` / `unknown`). |
| `crank` | A distribution attributed to a mint: total distributed, our slice, the coin's mcap at that moment, and whether we submitted it. |
| `swap` | A confirmed swap: signature, lamports in, raw ANSEM out, price impact. |
| `burn` | A confirmed burn: signature, raw amount, total supply after. |
| `rebate_accrual` | Ops rebate owed for one distribution (see below). |
| `rebate_paid` | An explicit rebate settlement and the accruals it covers. |
| `cycle` | A state-machine transition. Replaying these rebuilds the open cycle after a crash. |

Attribution is deduped by `(signature, mint)`, so replays and overlapping scans
can never double count. The inflow scanner keeps its cursor in
`bot/state/inflow-cursor.json` and only advances past transactions it fully
processed.

Only distributions with a **native SOL quote** are attributed. A live
`DistributeCreatorFeesEvent` for a SOL coin carries
`quote_mint = 1111…1111`; anything else pays shareholders in an SPL token, so its
`distributed` field is denominated in that token, not lamports. Folding it into
the lamport arithmetic would invent inflows (and rebate liabilities) that never
existed, so those events are skipped and the wallet credit is recorded as
`unknown` instead.

### The burn counter is ours only

`npm run status` reports `burns (OURS)` as the sum of **our** burn instructions
from the ledger. It separately shows `burned by all` (launch supply from
constants minus current on-chain supply) and `... not ours`. The ~57,784 ANSEM
burned by third parties before launch shows up there and is never claimed.

---

## Rebates

`config/constants.json` currently ships `split.rebate.enabled: false` — the split
is a flat 95/5 and **nothing is accrued, owed, or advertised**. The code path
stays in place and is driven entirely by that flag.

If it is ever re-enabled: for a distribution attributable to a coin whose mcap at
distribution time is at or above `coinMcapThresholdUsd`, ops keeps
`opsRetainedBpsAboveThreshold` bps-equivalent and owes the rest back to BULL. An
unknown mcap is **never** eligible — we don't accrue a liability we can't
evidence. Accrual is automatic and passive; paying is not:

```bash
npm run rebates              # report only
npm run rebates -- --send    # settle, needs OPS_KEYPAIR_PATH and DRY_RUN=false
```

Settlement is refused unless the ops placeholder has been replaced and
`OPS_KEYPAIR_PATH` holds that exact wallet. The keeper's BULL key can never move
ops funds.

---

## Discovery

`getProgramAccounts` on the Pump Fees program, once per shareholder slot: the
account discriminator at offset 0 plus the BULL wallet at
`sharingConfigLayout.shareholder0Offset + shareholderSize * i` for `i = 0..9`,
with a `dataSlice` covering just the shareholder vec. Never an unfiltered scan.
Each result is decoded (status, admin_revoked, mint, shareholders) and evaluated
against the `listing` gates. The crank runs on anything routing us a non-zero
share; the listing gates only affect what qualifies for the site.

> Program-ownership note: `transfer_creator_fees_to_pump_v2` lives on the
> **PumpSwap AMM** program and `distribute_creator_fees_v2` /
> `get_minimum_distributable_fee` on the **Pump bonding-curve** program. Only the
> `SharingConfig` *account* is owned by Pump Fees. Verified against `idl/*.json`
> and the live ANSEM config.

Dust is prechecked by simulating `get_minimum_distributable_fee` (preceded by the
AMM sweep for graduated coins, since their fees are otherwise invisible to the
bonding-curve vault). The real crank bundle is simulated again before sending, so
a coin that would revert is skipped instead of burning a fee.

---

## Security notes

- **Never print or copy private key material.** The keypair is read from
  `$KEYPAIR_PATH` only to sign. Errors reference the variable by name, never the
  resolved path or the file contents. Nothing logs key bytes.
- **`DRY_RUN` is forced on when `KEYPAIR_PATH` is unset**, and defaults to on even
  when it is set. Going live is an explicit `DRY_RUN=false`.
- **Live mode refuses to start** while `wallets.ops` is `REPLACE_WITH_OPS_WALLET`.
- **Buyback cycles refuse to run** unless the loaded signer *is* the BULL wallet.
  Cranking still works with any signer, because both crank instructions are
  permissionless and the keeper is only the fee payer.
- **$ANSEM is Token-2022.** Every ATA derivation, balance read and burn passes the
  Token-2022 program id explicitly, from constants. `assertToken2022()` fails
  loudly if constants ever disagree. A classic `TOKEN_PROGRAM_ID` anywhere in the
  ANSEM path is a bug.
- **The ATA is created once and never closed**, and burning is always
  `burnChecked` — never a transfer to the incinerator, which does not reduce
  supply.
- The BULL wallet is an unrotatable hot key by design: fee-share configs bake
  shareholder addresses in irreversibly, so the deposit address can never change
  — and the same key signs every swap and burn. Keep the balance near the
  reserve floor in normal operation; `keeper.reserveAlertSol` triggers a warning
  when it runs low.

## Known limits

- Public mainnet-beta RPC is enough for dry runs; discovery alone is ten
  `getProgramAccounts` calls per pass and will need a paid endpoint in
  production.
- A burn that keeps failing will stall new buybacks by design — the cycle will
  not buy more until the tokens it already holds are burned.
- `state/ledger.jsonl` is re-read on each attribution write. Fine at launch
  scale; if the ledger grows into the hundreds of thousands of lines it will want
  an index.
