# truthoracle-contracts

Daml contracts for TruthOracle on the Canton Network, plus the operator scripts that
deploy and administer them. Split out of `truthoracle-canton` (the frontend) so the
contracts, the backend (`../truthoracle-backend`) and the treasury wallet
(`../enterprise-wallet`) each have their own repository.

```
truthoracle-contracts/
├── daml/
│   ├── daml.yaml                 # templates package truthoracle-v15 1.0.0 — breaking changes bump the NAME
│   ├── multi-package.yaml        # `dpm build --all` builds the templates package, then the test package
│   ├── daml/Truthoracle.daml     # markets, pm-AMM trades, UserWallet, PendingPayout, resolution tiers
│   ├── daml/PmAmmMath.daml       # pricing math (mirrored by the frontend's lib/marketPricing.ts)
│   ├── daml/Incentives.daml      # rewards
│   ├── daml/Marketplace.daml     # prediction models
│   ├── test/daml.yaml            # test package truthoracle-v15-test (daml-script stays out of the uploaded DAR)
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
| `npm run dars:test` | builds both packages, then `dpm test` in `daml/test` (15 Daml Script scenarios) |
| `npm run dars:upload [-- <path.dar>] [-- --network devnet]` | Upload + vet a DAR (zkpc/MainNet by default; prints the package id to put in `VITE_TRUTHORACLE_PACKAGE_ID`) |
| `npm run create:contract` | Bootstrap the `MarketCounter` as the admin party via the Enterprise Wallet |
| `npm run create:account` | Create the admin/treasury party on the Enterprise Wallet (`WALLET_VALIDATOR_*`) |
| `npm run ledger:query [-- --network zkpc]` | Ad-hoc JSON Ledger API reads (ledger end, packages, parties) |
| `npm run contracts:active [-- --party <partyId>]` | Active contracts of the TruthOracle templates visible to a party |
| `npm run rights:grant [-- --party <partyId>]` | Grant `CanActAs` on a party to the ledger user |
| `npm run typecheck` | `tsc --noEmit` over `scripts/` |

Every script takes the acting party from `VITE_ENTERPRISE_WALLET_PARTY_ID`; `contracts:active`
and `rights:grant` accept `--party` to override. `--network zkpc` (MainNet) reads the
`ZKPC_*` block only and never falls back to the DevNet values.

## Package versioning

The source is **`truthoracle-v15` 1.0.0**, a fresh lineage deployed from scratch; the v14 package
still on DevNet / MainNet is abandoned (as v13 was) and is not upgraded. Canton's
smart-contract-upgrade (SCU) check rejects schema-incompatible DARs uploaded under an existing
package *name*: additive changes (a new `Optional` field appended last) keep the name and bump
`version`; anything else bumps the name (`truthoracle-v14` → `truthoracle-v15`).

**Why v15 — catalog identity is part of the market.** `PredictionMarket` and
`MarketCounter.CreateMarket` carry `ticker` (the Kalshi-style market ticker), `eventTicker` (the
event this market is one leg of — one event, many binary markets), `yesSubTitle` and
`noSubTitle` (what a trader buys with each side) as mandatory, non-empty `Text` (`ensure` and an
`assertMsg` in `CreateMarket` refuse blanks). A trader therefore signs for a named market and
event, the backend indexer reads the identity straight off the ledger with no synthetic
fallback, and the operator catalog (`truthoracle-backend/docs/MARKETS.md`) only adds the
series → event grouping around it. Ticker uniqueness is enforced by the backend catalog, not on
the ledger (Daml 3 has no contract keys). Deploy steps: `daml/DEPLOYMENT.md` "Deploying
truthoracle-v15 1.0.0".

### Toolchain

`daml/daml.yaml` pins **SDK 3.5.12** (`dpm` 1.0.22, `damlc` 3.5.3, Canton 3.5.19 tooling), the
latest stable release at the time of writing. The DevNet and MainNet participants answer
`GET /v2/version` with Canton 3.5.18 and 3.5.16, so an older SDK is behind production, not safer:
keep the pin on the newest stable release. `curl -sS https://get.digitalasset.com/install/latest`
prints it; `curl -sSL https://get.digitalasset.com/install/install.sh | sh -s <version>` installs
it into `~/.dpm` (put `~/.dpm/bin` on PATH). Bumping the SDK changes the package id even with no
Daml change — the id hashes the compiled package together with its stdlib dependencies — so
re-record it below and in `daml/DEPLOYMENT.md`.

The Daml Script suite is its own package (`daml/test`, name `truthoracle-v15-test`, module
`Test.Truthoracle`), as the 3.5 compiler recommends: the DAR that is uploaded carries neither
daml-script nor test code, and a test-only change never changes the production package id.

> macOS note: `dpm` ships `damlc` as an Intel (x86_64) binary only (still true for 3.5.12), so an
> Apple-silicon Mac needs Rosetta 2 once (`softwareupdate --install-rosetta --agree-to-license`);
> without it `dpm build` fails with "bad CPU type in executable".

`truthoracle-v15` 1.0.0 was built and tested (15/15) with this toolchain on 2026-09-29 — package
id `59a785f1aa72f96da4a8569964eeca2efd333a53957075714ff0f57acc37499d` (a content hash: the same source and
SDK reproduce it, on macOS and on the Ubuntu CI runner alike).


**Why v14.** v14 is the greenfield accounts era. The on-ledger `UserWallet` is created only
by the backend treasury for an account's primary wallet, and `UserWallet.depositRefs` is a
mandatory `[Text]` (v13 2.0.0 had appended it as an `Optional` purely to pass the SCU check).
There is no upgrade path from v13; the v13 contracts on DevNet are abandoned test data
(DevNet only, no user funds).

After upload, point the frontend (`VITE_TRUTHORACLE_PACKAGE_ID` / `_NAME`) and the backend
(`TRUTHORACLE_PACKAGE_ID` / `_NAME`) at the new package. Details: `daml/DEPLOYMENT.md`.

## Related repositories

- `../truthoracle-canton` — React frontend + Vercel proxies (reads these contracts through the JSON Ledger API).
- `../truthoracle-backend` — accounts, wallets, KYC and treasury-signed flows (deposit credits, payouts).
- `../enterprise-wallet` — the self-hosted Cantor8 Enterprise Wallet that signs as the admin party.
