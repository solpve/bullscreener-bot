# bullscreener — web

The public screener at bullscreener.xyz. Lists pump.fun coins that irreversibly
route their creator fees into $ANSEM buybacks and burns, and shows the on-chain
proof for every claim it makes.

Next.js 16 (App Router) + TypeScript. No Tailwind — hand-rolled CSS with design
tokens in `app/globals.css`. **No database.** Every figure is derived from chain
and free public APIs at request time and cached for 60 seconds, so the site
itself is not something you have to trust.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional — sensible defaults without it
npm run dev                  # http://localhost:3000
```

```bash
npm run build && npm start   # production
npm run typecheck            # tsc --noEmit
```

Node 20.9+ (developed on v22). npm only — no pnpm, and no native-build deps.

## Environment variables

| Variable | Required | Default | Effect |
|---|---|---|---|
| `RPC_URL` | no | `endpoints.defaultRpc` from `config/constants.json` | Solana JSON-RPC endpoint for all chain reads. |
| `HELIUS_API_KEY` | no | unset | Enables holder counts via `getProgramAccountsV2`. Without it the holders criterion renders `unverified`. |
| `NEXT_PUBLIC_SHOW_ADDRESS` | no | `false` | Reveals the BULL deposit address. **Leave off until launch.** |

### `NEXT_PUBLIC_SHOW_ADDRESS` — the address embargo

The BULL deposit address is a one-way door: once a deployer commits, it is baked
irreversibly into their coin's fee-sharing config and can never be rotated. It is
therefore published exactly once, at launch.

While the flag is anything other than the literal string `"true"`:

- every place the address would render shows `deposit address reveals at launch`;
- the copy-paste config on `/route-your-fees` shows a placeholder slot;
- `/api/v1/tokens` masks our shareholder entries as `embargoed:reveals-at-launch`
  (third-party shareholder addresses are public chain data and pass through).

`lib/constants.ts` is marked `server-only`, so a client component that tries to
import the address fails the build rather than shipping it to the browser.

This value is inlined at build time — **flipping it requires a rebuild**, not
just a restart.

### About the public RPC

The default endpoint rate-limits `getProgramAccounts` per method, aggressively:
batching the ten shareholder-slot scans into one JSON-RPC request returns `429`
for all ten. `lib/listings.ts` therefore issues them one per request at 250 ms
spacing (measured: 10/10 succeed, ~25 s total). That cost lands on background ISR
regeneration, not on visitors. Set `RPC_URL` to a dedicated endpoint in
production and the pacing stops mattering.

## Where the data comes from

`config/constants.json` at the repo root is the single source of truth, shared
with `bot/`. Nothing here re-declares an address, threshold or byte offset — it
is imported (`turbopack.root` is widened to the repo so the bundler can reach it).

| Module | Does |
|---|---|
| `lib/rpc.ts` | Batching JSON-RPC client: bounded concurrency, jittered backoff, per-call results. Never throws. |
| `lib/cache.ts` | 60 s in-process TTL cache with in-flight de-duplication, under Next's ISR. |
| `lib/decode.ts` | Hand-rolled Borsh readers for `SharingConfig`, `BondingCurve` and SPL `Mint`, plus PDA derivation. |
| `lib/listings.ts` | Enumerates sharing configs, gathers market/holder/cashback data, evaluates the gate. |
| `lib/stats.ts` | Walks the BULL wallet's signatures and parses transactions into burns and inflows. |
| `lib/dexscreener.ts` | Keyless batch price/market-cap lookup. |
| `lib/helius.ts` | Holder counts. Returns `null` rather than an estimate. |

### How listings are enumerated

`getProgramAccounts` against the Pump Fees program, filtered by the
`SharingConfig` discriminator at offset 0 **and** the BULL wallet at offset
`80 + 34*i` for each of the ten shareholder slots. Never an unfiltered scan —
that aborts. Results are de-duplicated by PDA.

Account offsets were re-verified against live mainnet accounts on 2026-07-26
(`SharingConfig 9ENSWned…G1jr`, `BondingCurve FxC6pJJS…Pnrf`, where
`bonding_curve.creator` does equal the sharing-config PDA).

### The gate

Read `/api/v1/criteria` for the machine-readable version. Seven checks are
enforced (config active, `admin_revoked`, share bps to burns, vault migrated,
market cap, holders, not a cashback coin) and one — fresh wallets — is specified
but reported as `pending` until v1.1.

Two deliberate behaviours:

- **Market cap** gates on the *lower* of DexScreener's `marketCap` and
  supply × price. The reported field is wrong often enough to matter; a
  divergence over 10% is flagged in the UI.
- **`unverified` is never a pass.** A criterion that could not be evaluated keeps
  a coin out of `Listed` and shows an `unverified` verdict rather than
  `excluded`. With no `HELIUS_API_KEY` this means nothing reaches `Listed`.

### The burn counter

`ansemBurnedByUs` sums **only** `burn` / `burnChecked` instructions on the
Token-2022 program whose mint is $ANSEM and whose authority is our wallet. It is
not the supply delta. 57,784.42 ANSEM was burned by unrelated parties before this
project existed; that baseline is disclosed on every surface that shows the
counter and is never added to it.

The signature walk is capped (3 pages of 1,000 signatures; the most recent 400
transactions fetched in detail). When a cap is hit, responses set
`truncated: true` and the UI says the totals are a lower bound.

`solIn` on the burn log pairs each burn with the nearest preceding unattributed
buy from the same wallet, because the swap and the burn are separate
transactions. Where no match exists in the scanned window it is `null` and renders
as `—` rather than a guess. Burn amounts themselves are read from the instruction
and are exact.

## API

All four return JSON with `access-control-allow-origin: *` and
`cache-control: public, s-maxage=60, stale-while-revalidate=300`.

| Endpoint | Contents |
|---|---|
| `/api/v1/tokens` | Every discovered sharing config with market data, per-criterion results and verdict. |
| `/api/v1/stats` | Headline totals, $ANSEM supply, and the pre-existing-burn disclosure. |
| `/api/v1/burns` | Our burn transactions with signatures and explorer links. |
| `/api/v1/criteria` | The gate, straight from `config/constants.json`. |

Everything degrades instead of failing: upstream errors surface in an `errors[]`
array and a `stale` flag, and the page renders what it has. With zero history
(pre-launch) every surface renders clean zeros.

## Copy rules baked into this app

- The claim is **permanent, verifiable supply reduction** — never price impact,
  never investment upside.
- "Irreversible" is only ever stated with its qualifier: the v2 path, meaning
  `update_fee_shares_v2` set `admin_revoked = true`. The revocable v1 path and
  pump.fun's retained `reset_fee_sharing_config_v2` override are both disclosed
  on `/route-your-fees`.
- The burn counter is ours alone, with the pre-existing baseline footnoted.
- No token exists and none ever will. Every page says so: if you see a
  bullscreener coin, it's a scam.

## Design

Dark-first, theme-aware via `prefers-color-scheme` with a `data-theme` override
that wins in both directions (set by a blocking script in `app/layout.tsx`, so no
flash). Monospace for chrome, addresses and all numerals (`tabular-nums`); a text
serif for prose. Verdict chips carry their state in marker *shape* as well as
colour — square pass, diamond fail, circle pending, hollow unverified — so they
survive colour-blindness and greyscale printing.
