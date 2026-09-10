# truthoracle-contracts

Daml contracts for TruthOracle on the Canton Network, plus the operator scripts that
deploy and administer them. Split out of `truthoracle-canton` (the frontend) so the
contracts, the backend (`../truthoracle-backend`) and the treasury wallet
(`../enterprise-wallet`) each have their own repository.

```
truthoracle-contracts/
├── daml/
│   ├── daml.yaml                 # package name/version (truthoracle-v14 1.0.0) — breaking changes bump the NAME
│   ├── daml/Truthoracle.daml     # markets, pm-AMM trades, UserWallet, PendingPayout, resolution tiers
│   ├── daml/PmAmmMath.daml       # pricing math (mirrored by the frontend's lib/marketPricing.ts)
│   ├── daml/Incentives.daml      # rewards
│   ├── daml/Marketplace.daml     # prediction models
│   ├── daml/TruthoracleTest.daml # `dpm test` suite
│   ├── README.md / DEPLOYMENT.md # module docs and the deployment runbook
│   └── *.dar                     # previously uploaded packages (history)
├── scripts/                      # tsx operator scripts (see below)
├── docs/active-contracts-api-reference.md
├── .env.example                  # every variable the scripts read
└── package.json
```

## Prerequisites

- Node ≥ 22 and `npm install` (installs `tsx`, `dotenv`, TypeScript).
- The Daml SDK `dpm` on your PATH (`daml.yaml` pins `sdk-version`). See `daml/README.md`.
- A `.env` (copy `.env.example`). The credentials are shared by Cantor8; never commit them.

## Commands

| Command | What it does |
|---|---|
| `npm run dars:build` | `dpm build` → `daml/.daml/dist/<name>-<version>.dar` |
| `npm run dars:test` | `dpm test` (Daml script suite) |
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

The deployed package is **`truthoracle-v14` 1.0.0**. Canton's smart-contract-upgrade (SCU)
check rejects schema-incompatible DARs uploaded under an existing package *name*: additive
changes (a new `Optional` field appended last) keep the name and bump `version`; breaking
changes bump the name (`truthoracle-v13` → `truthoracle-v14`).

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
