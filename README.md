# bullscreener

Open infrastructure for routing pump.fun creator fees into **verifiable buyback-and-burn of $ANSEM** (`9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`).

**There is no bullscreener token, and there never will be. Anyone selling you one is scamming you.**

## How it works

1. A memecoin deployer uses pump.fun's **Creator Fee Sharing** to set the BULL wallet as their coin's **sole fee recipient at 100%** — one address, set once in pump.fun's own interface. This is **irreversible by the deployer** and the routing is enforced by pump.fun's own on-chain program — not by us. (pump.fun's admin retains a platform-level reset instruction; we index reset events and would disclose any use immediately.)
2. The keeper in [`bot/`](bot/) cranks the **permissionless** distribute instructions. Once the BULL wallet accrues 5 SOL, it first takes a **disclosed 5% operations fee** as a plain, visible on-chain transfer, then market-buys $ANSEM via Jupiter with the rest and **burns it** with a Token-2022 `burnChecked` — visibly reducing total supply. The fee is enforced by this published code and verifiable on-chain each cycle, not by the protocol; we say that plainly.
3. The site in [`web/`](web/) lists participating coins that meet the published criteria and shows every burn transaction.

## Verify everything yourself

- **The routing**: decode any listed coin's `SharingConfig` PDA (`['sharing-config', mint]` on `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`) — the BULL wallet as sole recipient at 10000 bps is an on-chain fact.
- **The ops fee**: every cycle's 5% transfer from the BULL wallet to the ops wallet is a public transaction, adjacent to that cycle's buy and burn.
- **The burns**: every burn is a `burnChecked` instruction on the $ANSEM mint; total supply decreases with each one (`getTokenSupply`). Our counter includes **only our own burns** — 57,784.42 ANSEM was burned by other holders before this project existed and is never claimed.
- **The listing rules**: `GET /api/v1/criteria` on the site returns the machine-readable gate; the code that evaluates it is in [`web/lib/`](web/lib/).
- **The engine**: this repository is the code that runs. `config/constants.json` is the single source of truth for every address and threshold.

## What this is not

- Not a token, presale, or investment. The 5% operations fee is disclosed, taken by this open-source keeper as a visible on-chain transfer, nothing more.
- Not price support — burns are a permanent, verifiable supply reduction; no claims are made about price.
- Not custody of anyone's funds but the fees deployers irreversibly route here by their own on-chain action.

## Repository layout

| Path | What |
|---|---|
| `bot/` | The keeper: fee crank, buyback trigger, Jupiter swap, Token-2022 burn, append-only ledger. |
| `web/` | The screener site (Next.js): listings, stats, burn log, public JSON API. |
| `config/constants.json` | Every address, threshold, and routing parameter. |
| `idl/` | pump.fun program IDLs, vendored from [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs). |

Both components have their own README with setup instructions. The bot runs in `DRY_RUN` by default and refuses to go live without explicit configuration.

## License

MIT — see [LICENSE](LICENSE).
