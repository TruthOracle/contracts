# TruthOracle DAML Contracts (Canton Network)

DAML contracts for the TruthOracle prediction market protocol on **Canton Network**,
implementing the TruthOracle proposal v0.6 / implementation plan v1.1 (see `docs/`):
a **dynamic pm-AMM** (Paradigm's Gaussian-score AMM — price `P = Φ((y−x)/L_eff)`,
`L_eff = L0·√(T−t)`) with **tiered objective resolution** (T0–T3). Since `truthoracle-v17`
every market is denominated in a configurable **CIP-56 collateral instrument** —
`InstrumentId { admin, id }`: the Canton Belarusian Ruble **cBYN** under Cantor8's transfer-agent
party, or Canton Coin under the DSO as the DevNet stand-in — and rewards are paid in **TRO**
through `UserWallet.Grant`. Nothing on the ledger is specific to Canton Coin, and no token
contract is part of this package: the tokens live in their own repositories (`cbyn-token`,
`truthoracle-token`); these contracts only name them (design: `truthoracle-backend/docs/TOKENS.md`).

## Money model

- **Instrument** — `InstrumentId with admin : Party; id : Text`, the token-standard shape
  (`Splice.Api.Token.HoldingV1.InstrumentId`), declared in `Truthoracle` so the package needs no
  data-dependencies; off-ledger code compares the two field by field.
- **Collateral** — `PredictionMarket.collateral`, fixed by `MarketCounter.CreateMarket` and copied
  into every successor version of the market. Shares cost ≤ 1 unit, a winning share pays exactly
  1 unit, fees (`accumulatedFees`, `prizePool`), bonds (`ResolutionPolicy.bond`) and model prizes
  are in it. One market, one instrument: there is no conversion anywhere on the ledger.
- **UserWallet** — one contract per `(owner, instrument)`, signed by the admin treasury and observed
  by the owner and the `auditObservers`; `instrument` is immutable. `Deposit` (an external transfer
  the treasury received; bumps `balance` and `deposited`) and `Grant` (a treasury-funded reward,
  bonus or correction; bumps `balance` only, so deposit reconciliation stays honest) share one
  `creditRefs` namespace and refuse a ref already applied — a replayed deposit or reward aborts
  on-ledger even if it slips past command-dedup. `Credit` / `Debit` are the market-internal moves
  (`Debit` needs owner *and* admin, so it is only reachable from inside a market choice);
  `Withdraw` queues a `PendingPayout` in the wallet's instrument. Every market choice that debits or
  credits a wallet asserts `wallet.instrument == collateral` ("wallet holds a different instrument
  than the market's collateral"): a TRO wallet can never pay for, or be paid by, a cBYN market.
- **PendingPayout** — `instrument` and `amount` the admin owes a user: withdrawals in the wallet's
  instrument, T3 bonds and model prizes in the market's collateral. Observed by the user and the
  `auditObservers`; `SettleToWallet` and `CancelPayout` refuse a wallet of another instrument.
- **auditObservers** — the regulator's parties, observers on markets, positions, liquidity positions,
  forecasts, wallets and payouts (the backend passes `AUDIT_OBSERVER_PARTIES` on everything it
  creates): balances and money owed are visible to holder, operator and regulator, and nobody else.

## Roles

- **Admin (operator/treasury)** – Creates markets (`MarketCounter.CreateMarket` with a `collateral`
  and a `ResolutionPolicy`), credits wallets (`UserWallet.Deposit` after a transfer landed,
  `UserWallet.Grant` for rewards), resolves markets (`ResolveT0` / `Resolve` from attestations /
  `VoidMarket`), settles the payout queue (`PendingPayout.MarkPaid` or `SettleToWallet`), and scores
  model forecasts (`ScoreAndDistribute`).
- **Traders** – `Buy` / `Sell` against the pm-AMM (slippage-bounded, priced on-ledger, paid from and
  into the in-app wallet of the market's collateral), `Split` / `Merge` complete sets (1 unit of
  collateral = 1 YES + 1 NO), `RedeemPosition` after resolution (1 unit per winning share;
  cost-basis refund on Void), `UserWallet.Withdraw` to take funds back to an external wallet.
- **Liquidity providers** – `ProvideLiquidity` (value-based, price-preserving) and
  `WithdrawLiquidity` (dynamic pools lock LPs until resolution — uniform LVR).
- **Reporters / sources (T1/T2)** – create `OutcomeAttestation` contracts; `Resolve`
  accepts a first-party `secp256k1`-signed source reading (T1) or an M-of-N reporter
  quorum (T2).
- **Proposers / challengers (T3)** – `ProposeOutcome` / `ChallengeOutcome` /
  `FinalizeOutcome` with bonds in the market's collateral; challenges escalate objectively to
  T1/T2, never a vote.
- **Forecasters** – `CommitForecast` while a market is Trading; Brier-scored against the
  realised outcome, prize pool funded from a fee slice.
- **Regulator** – reads everything it is an audit observer on; signs nothing, controls nothing.

## Modules

- **PmAmmMath.daml** – Normal distribution (`Φ`, `φ`, `Φ⁻¹`), closed-form optimal
  reserves / pool value, effective-liquidity decay, and the Newton swap solver.
- **Truthoracle.daml** – `InstrumentId`, `UserWallet`, `PendingPayout`, `PredictionMarket`
  (inline pm-AMM + `collateral` + `ResolutionPolicy` + lifecycle `Trading | Proposed | Resolved |
  Voided`), `Position`, `LiquidityPosition`, `OutcomeAttestation`, `ModelForecast`, `MarketCounter`.
- **Marketplace.daml** – `PredictionModel` registry (prediction-model marketplace).

`Incentives.daml` (the Aptos-era `UserRewardsSummary` / `ClaimedReward` claim-rewards templates)
was deleted in v17: rewards are computed off-ledger by the backend's rewards processor from the
ledger index and credited on-ledger with `UserWallet.Grant { amount, ref = "reward:<grantId>",
reason }` on the user's TRO wallet, which is what makes them idempotent and withdrawable.

After any DAML change: **`dpm build --all`**, record the new package id (`DEPLOYMENT.md`), upload
the new **`.dar`**, then point `VITE_TRUTHORACLE_PACKAGE_ID` / `TRUTHORACLE_PACKAGE_ID` at it.

## Prerequisites

- **dpm** (Digital Asset Package Manager) with the SDK pinned in `daml.yaml` — **3.6.0**, the latest
  stable release; the Cantor8 DevNet participant runs Canton 3.6.1. Keep it current (repo README,
  "Toolchain"). See [dpm installation](https://docs.canton.network/sdks-tools/cli-tools/dpm#installation).
  `dpm test` and `dpm upgrade-check` need a JDK (17 works locally, CI uses 21).
- Canton Network DevNet access (a participant exposing the JSON Ledger API) to deploy.

## Build

```bash
cd daml
dpm build --all
```

Or from the repo root: `npm run dars:build`.

Output: `.daml/dist/truthoracle-v17-1.0.0.dar` (the templates package — the one that gets uploaded)
and `test/.daml/dist/truthoracle-v17-test-1.0.0.dar` (the Daml Script suite, never uploaded).
`multi-package.yaml` makes `--all` build them in dependency order.

**Note on `daml` vs `dpm`**  
The legacy `daml` assistant was removed with SDK 3.5; `dpm` is the only supported CLI.

## Test

```bash
cd daml
dpm build --all && (cd test && dpm test)
```

Or from the repo root: `npm run dars:test`. The suite lives in `test/daml/Test/Truthoracle.daml`:
21 scenarios covering the pm-AMM math, the wallet rail, trading, liquidity, every resolution tier,
voiding, forecasts and catalog identity, plus the v17 instrument rules —
`walletInstrumentMustMatchCollateral` (a TRO wallet is refused on a cBYN market for `Buy`,
`ProvideLiquidity`, `Split` and as a `Sell` target), `walletInstrumentCheckedOnEveryMove` (the same
refusal on `Merge`, `RedeemPosition`, `WithdrawLiquidity`, `ProposeOutcome` and `ChallengeOutcome`,
so every one of the eleven money paths is exercised), `twoInstrumentWalletsCoexist`,
`grantIsIdempotent` (same ref twice aborts, a deposit's txRef cannot be reused by a grant and vice
versa, `deposited` untouched by grants, refs newest first), `withdrawCarriesInstrument` (payout in
the wallet's instrument; `SettleToWallet` / `CancelPayout` refuse another instrument's wallet),
`regulatorSeesWalletAndPayout` (audit observers can fetch wallets and payouts, including the bond
payout `FinalizeOutcome` creates) and `marketPayoutsCarryCollateralAndObservers` (the slashed bond
`Resolve` settles, the bond `VoidMarket` refunds and the model prize `ScoreAndDistribute` queues all
carry the collateral and the market's observers; a stranger sees none). Every market in the suite
is denominated in a `cBYN` instrument whose admin is a transfer-agent party; `TRO` has its own issuer.

## Deploy to Canton Network

**Step-by-step instructions:** see **[DEPLOYMENT.md](./DEPLOYMENT.md)** for building the DAR, uploading it to a Canton participant (local or DevNet), configuring parties and the v17 cut-over.

In short: run `dpm build --all`, then upload `daml/.daml/dist/truthoracle-v17-1.0.0.dar` to your
participant (`npm run dars:upload -- daml/.daml/dist/truthoracle-v17-1.0.0.dar -- --network devnet`,
or `participant1.dars.upload("path/to/truthoracle-v17-1.0.0.dar")` in the Canton console). See the
[Canton Network documentation](https://docs.digitalasset.com/canton/) for participant setup.

The backend (`../truthoracle-backend`) indexes these contracts through the JSON Ledger API and signs
as the treasury through the Enterprise Wallet; the frontend prepares trader-signed choices
(`Buy`, `Sell`, `Split`, `Merge`, `ProvideLiquidity`, `WithdrawLiquidity`, `RedeemPosition`,
`UserWallet.Withdraw`) with the v17 argument names.
