# truthoracle-contracts

Daml contracts for TruthOracle on the Canton Network, plus the operator scripts that
deploy and administer them. Split out of `truthoracle-canton` (the frontend) so the
contracts, the backend (`../truthoracle-backend`) and the treasury wallet
(`../enterprise-wallet`) each have their own repository.

```
truthoracle-contracts/
├── daml/
│   ├── daml.yaml                 # templates package truthoracle-v17 1.0.0 — breaking changes bump the NAME
│   ├── multi-package.yaml        # `dpm build --all` builds the templates package, then the test package
│   ├── daml/Truthoracle.daml     # InstrumentId, markets (collateral), pm-AMM trades, UserWallet per
│   │                             # (owner, instrument), PendingPayout, resolution tiers
│   ├── daml/PmAmmMath.daml       # pricing math (mirrored by the frontend's lib/marketPricing.ts)
│   ├── daml/Marketplace.daml     # prediction models
│   ├── test/daml.yaml            # test package truthoracle-v17-test (daml-script stays out of the uploaded DAR)
│   ├── test/daml/Test/Truthoracle.daml  # the Daml Script suite (`npm run dars:test`)
│   ├── README.md / DEPLOYMENT.md # module docs and the deployment runbook
│   └── *.dar                     # previously uploaded packages (history)
├── scripts/                      # tsx operator scripts (see below)
├── docs/active-contracts-api-reference.md
├── .env.example                  # every variable the scripts read
└── package.json
```

## Prerequisites

- Node ≥ 22 and `npm install` (installs `tsx`, `dotenv`, TypeScript).
- `dpm` (the Daml SDK) on your PATH and a JDK (`dpm test` and `dpm upgrade-check` are JVM tools;
  17 works locally, CI uses Temurin 21). `daml/daml.yaml` pins `sdk-version`; keep it on the
  latest stable release (see "Toolchain" below).
- A `.env` (copy `.env.example`). The credentials are shared by Cantor8; never commit them.

## Commands

| Command | What it does |
|---|---|
| `npm run dars:build` | `dpm build --all` → `daml/.daml/dist/<name>-<version>.dar` (plus the test package's DAR under `daml/test/.daml/dist/`, never uploaded) |
| `npm run dars:test` | builds both packages, then `dpm test` in `daml/test` (21 Daml Script scenarios) |
| `npm run dars:upload [-- <path.dar>] [-- --network devnet]` | Upload + vet a DAR (zkpc/MainNet by default; without a path, the DAR `daml/daml.yaml` names — `daml/.daml/dist/<name>-<version>.dar` — so the default never lags a lineage bump; the package id comes from `dpm inspect-dar`, see `daml/DEPLOYMENT.md`) |
| `npm run create:contract` | Bootstrap the `MarketCounter` as the admin party via the Enterprise Wallet (`-- user-wallet <party> [balance] [txRef]` creates a `UserWallet` in the collateral instrument) |
| `npm run create:market -- --ticker … --event … --question … --expires <UTC ISO> [--initial-value 100] [--collateral-admin … --collateral-id …] [--audit-observers …]` | Treasury-signed `CreateMarket` on the ledger in the collateral instrument (`COLLATERAL_INSTRUMENT_ADMIN` / `_ID` unless overridden) with `AUDIT_OBSERVER_PARTIES` as `auditObservers` (`--audit-observers` adds parties and never drops the configured ones — the backend's rule); ledger-first: the backend indexer creates placeholder series / event rows; the operator console is the primary path |
| `npm run create:account` | Create the admin/treasury party on the Enterprise Wallet (`WALLET_VALIDATOR_*`) |
| `npm run ledger:query [-- <Template>] [-- --network zkpc] [-- --raw]` | Active `MarketCounter` / `PredictionMarket` / `Position` contracts of the package in one request (`VITE_TRUTHORACLE_PACKAGE_NAME`; blank = the `name:` in `daml/daml.yaml`) |
| `npm run contracts:active [-- <Template>] [-- --party <partyId>]` | Active contracts of every TruthOracle template — markets, positions, liquidity, `UserWallet`s, payouts, attestations, forecasts, models — visible to a party, one request per template |
| `npm run rights:grant [-- --party <partyId>]` | Grant `CanActAs` on a party to the ledger user |
| `npm run typecheck` | `tsc --noEmit` over `scripts/` |

Every script takes the acting party from `VITE_ENTERPRISE_WALLET_PARTY_ID`; `contracts:active`
and `rights:grant` accept `--party` to override. `--network zkpc` (MainNet) reads the
`ZKPC_*` block only and never falls back to the DevNet values.

## CI

`.github/workflows/ci.yml` runs on every push to a pull request and on `main`: `dpm build --all`,
the Daml Script suite, an upgrade check of the templates DAR against what the PR's base branch
builds (same name and a bumped version → `dpm upgrade-check --both`; same name and version but a
different package id → red, bump the version), the operator scripts' typecheck and prettier, and
an advisory job that warns when `daml.yaml` is behind the latest stable SDK. The job summary
prints the package id and the DAR is attached to the run as an artifact.

## Package versioning

The source is **`truthoracle-v17` 1.0.0**, a fresh lineage deployed from scratch; the v16 package
still on DevNet is abandoned (as v15 and v14 were) and is not upgraded. Canton's
smart-contract-upgrade (SCU) check rejects schema-incompatible DARs uploaded under an existing
package *name*: additive changes (a new `Optional` field appended last) keep the name and bump
`version`; anything else bumps the name (`truthoracle-v16` → `truthoracle-v17`).

**Why v17 — the collateral is a configurable instrument, not Canton Coin.** TruthOracle launches in
cBYN, the Canton Belarusian Ruble (a CIP-56 token under Cantor8's transfer agent), pays rewards in
TRO, and runs DevNet on Canton Coin until Cantor8 deploys cBYN. v16 had no notion of *which* token a
balance was in: every amount was implicitly Canton Coin and said so in its name (`balanceCC`,
`collateralCC`, `bondCC`, …). v17 makes the instrument explicit and immutable where it matters
(design: `truthoracle-backend/docs/TOKENS.md`):

- `InstrumentId with admin : Party; id : Text` (the token-standard shape) is declared in
  `Truthoracle`; `PredictionMarket.collateral` and `MarketCounter.CreateMarket.collateral` fix the
  instrument a market is denominated in — shares cost ≤ 1 unit, a winning share pays 1 unit, fees,
  bonds and model prizes are in it. One market, one instrument, no conversion on the ledger.
- `UserWallet` is one contract per (owner, instrument) with an immutable `instrument`; every market
  choice that debits or credits a wallet asserts `wallet.instrument == collateral`, as do
  `PendingPayout.SettleToWallet` / `CancelPayout` against `PendingPayout.instrument`. A TRO wallet
  can never pay for, or be paid by, a cBYN market.
- `depositRefs` became `creditRefs`, one namespace for deposits and grants, and `UserWallet.Grant
  { amount, ref, reason }` credits treasury-funded rewards and bonuses without touching `deposited`
  — a reward is applied at most once and deposit reconciliation stays exact.
- `auditObservers` is now also on `UserWallet` and `PendingPayout` (it was on markets, positions and
  forecasts): the regulator sees balances and money owed, and nobody else does.
- The `CC` suffix is gone from every field and choice argument; every amount is read next to the
  instrument it is in (`market.collateral`, `wallet.instrument`, `payout.instrument`).
- `Incentives.daml` (the Aptos-era claim-rewards templates) is deleted: rewards are computed
  off-ledger from the index and credited with `Grant`.

Renaming fields and adding mandatory ones is exactly what the SCU check refuses under an existing
name, hence v17. Kept from before: `UserWallet` is created only by the backend treasury (v14), the
mandatory catalog identity (v15) and off-ledger presentation (v16) below. Deploy steps:
`daml/DEPLOYMENT.md` "Deploying truthoracle-v17 1.0.0".

**Why v16 (kept in v17) — presentation leaves the contract.** `imageUrl`, `description` and
`category` are gone from `PredictionMarket` and `CreateMarket`. Rule: on-ledger only what a trader
signs for, what a choice reads, or what a resolution needs. Artwork, blurbs and categorisation are
none of those, were frozen for the life of a market (no choice edited them) and were copied into
every trade transaction. The backend catalog owns them (`truthoracle-backend/docs/MARKETS.md` "What
lives where"): an operator sets them at creation or later through
`PATCH /admin/markets/:market/metadata`, category comes from the series, a blank image falls back to
the event's. `resolutionDescription` stays: it is the terms a resolution is judged against, signed
with every trade.

**Why v15 (kept in v17) — catalog identity is part of the market.** `PredictionMarket` and
`MarketCounter.CreateMarket` carry `ticker` (the Kalshi-style market ticker), `eventTicker` (the
event this market is one leg of — one event, many binary markets), `yesSubTitle` and
`noSubTitle` (what a trader buys with each side) as mandatory, non-empty `Text` (`ensure` and an
`assertMsg` in `CreateMarket` refuse blanks). A trader therefore signs for a named market and
event, the backend indexer reads the identity straight off the ledger with no synthetic
fallback, and the operator catalog (`truthoracle-backend/docs/MARKETS.md`) only adds the
series → event grouping around it. Ticker uniqueness is enforced by the backend catalog, not on
the ledger (Daml 3 has no contract keys).

All times on the ledger are UTC: choices take epoch seconds (`createdAt`, `expiresAt`, `nowSeconds`), and the scripts read a timestamp without an offset as UTC.

### Toolchain

`daml/daml.yaml` pins **SDK 3.6.0** (`dpm` 1.0.22, `damlc` 3.6.2, `daml-script` 3.6.2, Canton 3.6.1
tooling), the latest stable release at the time of writing. The Cantor8 DevNet participant answers
`GET /v2/version` with Canton 3.6.1, so an older SDK is behind the network, not safer: keep the pin
on the newest stable release. `curl -sS https://get.digitalasset.com/install/latest` prints it;
`curl -sSL https://get.digitalasset.com/install/install.sh | sh -s <version>` installs it into
`~/.dpm` (put `~/.dpm/bin` on PATH). Bumping the SDK changes the package id even with no Daml
change — the id hashes the compiled package together with its stdlib dependencies — so re-record
it below and in `daml/DEPLOYMENT.md`. Canton 3.6 also disabled the legacy `filter` / top-level
`verbose` fields of `/v2/state/active-contracts` (`DEPRECATED_API_DISABLED`); every script here
sends `eventFormat` and neither legacy field (a top-level `verbose: false` beside `eventFormat` is
refused just the same).

The Daml Script suite is its own package (`daml/test`, name `truthoracle-v17-test`, module
`Test.Truthoracle`), as the compiler recommends: the DAR that is uploaded carries neither
daml-script nor test code, and a test-only change never changes the production package id.

> macOS note: `dpm` ships `damlc` as an Intel (x86_64) binary only (still true for 3.6.0 / damlc 3.6.2), so an
> Apple-silicon Mac needs Rosetta 2 once (`softwareupdate --install-rosetta --agree-to-license`);
> without it `dpm build` fails with "bad CPU type in executable".

`truthoracle-v17` 1.0.0 was built and tested (21/21 scenarios) with this toolchain on 2026-10-15 —
package id `5b52a2ca8ed402b716d7e37ffafb3432b4c773472702822ce9059d899266d66c` (a content hash: the same source and
SDK reproduce it, on macOS and on the Ubuntu CI runner alike). It has not been uploaded to a
participant yet; `daml/DEPLOYMENT.md` has the cut-over steps.

After upload, point the frontend (`VITE_TRUTHORACLE_PACKAGE_ID` / `_NAME`) and the backend
(`TRUTHORACLE_PACKAGE_ID` / `_NAME`) at the new package. Details: `daml/DEPLOYMENT.md`.

## Related repositories

- `../truthoracle-canton` — React frontend + Vercel proxies (reads these contracts through the JSON Ledger API).
- `../truthoracle-backend` — accounts, wallets, KYC and treasury-signed flows (deposit credits, payouts).
- `../enterprise-wallet` — the self-hosted Cantor8 Enterprise Wallet that signs as the admin party.
- `../cbyn-token`, `../truthoracle-token` — the cBYN and TRO token packages (CIP-56); these contracts only name them through `InstrumentId`.
