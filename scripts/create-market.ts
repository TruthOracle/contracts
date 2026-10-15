/**
 * TruthOracle — create a PredictionMarket on the ledger as the treasury (ledger-first path).
 *
 * Exercises MarketCounter.CreateMarket through the Enterprise Wallet's single-call
 * POST /api/v1/external/submit (the wallet prepares, signs and executes as the admin party).
 * Since truthoracle-v17 a market is denominated in one CIP-56 collateral instrument
 * (`{ admin, id }`, fixed at creation): shares cost <= 1 unit, a winning share pays 1 unit,
 * fees and bonds are in it, and only UserWallets holding that instrument can trade it
 * (truthoracle-backend docs/TOKENS.md). The catalog side (series / event rows) is NOT written
 * here: the backend indexer creates placeholder rows for an unknown event ticker and an operator
 * renames them later. The operator console (`POST /admin/markets` in truthoracle-backend) is the
 * primary path — it validates the catalog and the event's collateral first — so use this script
 * for bootstrapping and smoke tests.
 *
 * Usage:
 *   npm run create:market -- --ticker FED-26DEC-CUT25 --event FED-26DEC \
 *     --question "Will the Fed cut by at least 25 bps in December 2026?" \
 *     --yes "Cut of 25 bps or more" --no "Smaller cut, hold or hike" \
 *     --rules "Resolves YES if the FOMC statement lowers the target range by >= 25 bps." \
 *     --expires 2026-12-16T19:00:00Z --p0 0.35 --initial-value 200 \
 *     [--collateral-admin <party> --collateral-id <text>] [--fee 30] [--prize-share 2000] \
 *     [--dynamic] [--liquidity-period-secs 0] [--grace-secs 86400] [--counter <MarketCounter cid>] \
 *     [--audit-observers <party,party>]
 *
 * --collateral-admin / --collateral-id default to COLLATERAL_INSTRUMENT_ADMIN /
 * COLLATERAL_INSTRUMENT_ID from .env (DevNet stand-in: the DSO party / Amulet, i.e. Canton Coin,
 * until Cantor8 deploys cBYN) and are required when neither source sets them. --initial-value is
 * the seed pool value in units of that instrument.
 *
 * The market's `auditObservers` are AUDIT_OBSERVER_PARTIES from .env (the regulator; comma
 * separated) plus whatever --audit-observers adds. The flag widens the list and never drops the
 * configured parties — the same rule as the backend's POST /admin/markets (TOKENS.md §2.4) — so a
 * market, and every bond or model-prize PendingPayout it later queues, is visible to the regulator
 * whichever path created it.
 *
 * Required .env: VITE_TRUTHORACLE_PACKAGE_ID, VITE_TRUTHORACLE_PACKAGE_NAME,
 *   VITE_ENTERPRISE_WALLET_PARTY_ID, KEYCLOAK_* (wallet + ledger tokens),
 *   VITE_CANTON_PARTICIPANT_URL (to find the active MarketCounter when --counter is omitted).
 * Optional .env: AUDIT_OBSERVER_PARTIES (blank = no regulator on the market; the script says so).
 */

import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env") });

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const USAGE = [
  "Create a PredictionMarket as the treasury (MarketCounter.CreateMarket via the Enterprise Wallet).",
  "",
  "Usage:",
  "  npm run create:market -- --ticker <TICKER> --event <EVENT-TICKER> --question <text> --expires <UTC ISO-8601> \\",
  '    [--yes "Yes"] [--no "No"] [--rules <resolution terms>] [--p0 0.5] [--initial-value 100] \\',
  "    [--collateral-admin <party> --collateral-id <text>] [--fee 30] [--prize-share 2000] \\",
  "    [--dynamic] [--liquidity-period-secs 0] [--grace-secs 86400] [--counter <MarketCounter cid>] \\",
  "    [--audit-observers <party,party>]",
  "",
  "Collateral (the CIP-56 instrument the market is denominated in; fixed at creation):",
  "  --collateral-admin   instrument admin party; default COLLATERAL_INSTRUMENT_ADMIN (.env)",
  "  --collateral-id      instrument id, e.g. cBYN or Amulet; default COLLATERAL_INSTRUMENT_ID (.env)",
  "  Both are required: the script refuses to run when neither the flag nor the variable is set.",
  "  --initial-value      seed pool value in units of the collateral (default 100)",
  "",
  "Audit observers (the regulator; observers on the market and on every PendingPayout it queues):",
  "  --audit-observers    comma separated party ids ADDED to AUDIT_OBSERVER_PARTIES (.env). The flag",
  "                       widens the list, it cannot drop the configured parties (same as POST /admin/markets).",
  "",
  "Timing: --expires is read as UTC unless it carries an offset; createdAt is now (UTC).",
  "",
  "Required .env: VITE_TRUTHORACLE_PACKAGE_ID, VITE_TRUTHORACLE_PACKAGE_NAME, VITE_ENTERPRISE_WALLET_PARTY_ID,",
  "  KEYCLOAK_URL / KEYCLOAK_CLIENT_ID / KEYCLOAK_CLIENT_SECRET (or the VITE_KEYCLOAK_* URL/realm),",
  "  VITE_CANTON_PARTICIPANT_URL (to find the active MarketCounter when --counter is omitted).",
  "Optional .env: AUDIT_OBSERVER_PARTIES (comma separated regulator parties; blank = none, the script says so),",
  "  VITE_ENTERPRISE_WALLET_URL (default http://localhost:8080), VITE_ENTERPRISE_WALLET_APP_NAME (default truthoracle).",
].join("\n");

function viteEnv(name: string) {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}
function mustEnv(value: string, name: string) {
  if (!value) throw new Error(`Missing required config: ${name}`);
  return value;
}
function stripTrailingSlash(url: string) {
  return url.replace(/\/$/, "");
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function mustArg(name: string): string {
  const v = arg(name);
  if (!v || v.startsWith("--")) throw new Error(`Missing --${name}`);
  return v;
}
/** A flag that falls back to an .env variable; one of the two must be set. */
function argOrEnv(name: string, envName: string): string {
  const fromArg = arg(name);
  if (fromArg && !fromArg.startsWith("--")) return fromArg;
  const fromEnv = viteEnv(envName);
  if (fromEnv) return fromEnv;
  throw new Error(`Missing --${name} (or ${envName} in .env)`);
}

/** A list flag; given without a value it is an error rather than a silent no-op. */
function listArg(name: string): string {
  if (!flag(name)) return "";
  const v = arg(name);
  if (!v || v.startsWith("--")) throw new Error(`Missing value for --${name} (comma separated party ids)`);
  return v;
}

/** Canton party id, `<hint>::1220<64 hex>` — the check the backend applies to AUDIT_OBSERVER_PARTIES. */
const PARTY_ID = /^[A-Za-z0-9_.-]{1,255}::1220[0-9a-f]{64}$/;

/** Comma / whitespace separated party ids; blanks dropped, anything that is not a party id refused. */
function partyList(raw: string, source: string): string[] {
  const parties = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const party of parties) {
    if (!PARTY_ID.test(party)) throw new Error(`${source}: not a Canton party id: ${party.slice(0, 24)}…`);
  }
  return parties;
}

const TICKER = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;

/**
 * Epoch seconds of an ISO-8601 instant, read as UTC. The ledger speaks epoch seconds and the
 * platform has no other zone, so a timestamp without an offset ("2026-12-16T19:00") means UTC,
 * never the operator's local time (which is what Date.parse would assume).
 */
function parseUtcSeconds(value: string): number {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const ms = Date.parse(hasZone ? value.trim() : `${value.trim()}Z`);
  if (!Number.isFinite(ms))
    throw new Error(`--expires must be an ISO-8601 timestamp (UTC unless it carries an offset): ${value}`);
  return Math.floor(ms / 1000);
}

async function keycloakToken(): Promise<string> {
  const url = stripTrailingSlash(mustEnv(viteEnv("KEYCLOAK_URL") || viteEnv("VITE_KEYCLOAK_URL"), "KEYCLOAK_URL"));
  const realm = viteEnv("KEYCLOAK_REALM") || viteEnv("VITE_KEYCLOAK_REALM") || "master";
  const clientId = mustEnv(viteEnv("KEYCLOAK_CLIENT_ID"), "KEYCLOAK_CLIENT_ID");
  const clientSecret = mustEnv(viteEnv("KEYCLOAK_CLIENT_SECRET"), "KEYCLOAK_CLIENT_SECRET");
  const res = await fetch(`${url}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Keycloak token request failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Keycloak response missing access_token");
  return data.access_token;
}

/**
 * The single active MarketCounter of the package, as seen by the admin party. The request uses
 * the `eventFormat` shape: Canton 3.6 disables the legacy `filter` / top-level `verbose` fields
 * of /v2/state/active-contracts (DEPRECATED_API_DISABLED).
 */
async function findMarketCounter(
  token: string,
  party: string,
  packageName: string,
): Promise<{ contractId: string; value: string }> {
  const ledger = stripTrailingSlash(mustEnv(viteEnv("VITE_CANTON_PARTICIPANT_URL"), "VITE_CANTON_PARTICIPANT_URL"));
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const end = (await (await fetch(`${ledger}/v2/state/ledger-end`, { headers })).json()) as { offset?: number };
  const body = {
    activeAtOffset: String(end.offset ?? 0),
    eventFormat: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: { templateId: `#${packageName}:Truthoracle:MarketCounter`, includeCreatedEventBlob: false },
                },
              },
            },
          ],
        },
      },
      verbose: false,
    },
  };
  const res = await fetch(`${ledger}/v2/state/active-contracts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`active-contracts failed (${res.status}): ${await res.text()}`);
  const rows = (await res.json()) as Array<{
    contractEntry?: { JsActiveContract?: { createdEvent?: { contractId: string; createArgument: { value: string } } } };
  }>;
  const counters = rows
    .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
    .filter((e): e is NonNullable<typeof e> => Boolean(e));
  if (counters.length !== 1)
    throw new Error(`expected exactly one active MarketCounter, found ${counters.length} (pass --counter <cid>)`);
  return { contractId: counters[0].contractId, value: String(counters[0].createArgument.value) };
}

async function main() {
  if (flag("help") || flag("h")) {
    console.log(USAGE);
    return;
  }
  const packageId = mustEnv(viteEnv("VITE_TRUTHORACLE_PACKAGE_ID"), "VITE_TRUTHORACLE_PACKAGE_ID");
  const packageName = mustEnv(viteEnv("VITE_TRUTHORACLE_PACKAGE_NAME"), "VITE_TRUTHORACLE_PACKAGE_NAME");
  const party = mustEnv(viteEnv("VITE_ENTERPRISE_WALLET_PARTY_ID"), "VITE_ENTERPRISE_WALLET_PARTY_ID");
  const walletUrl = stripTrailingSlash(viteEnv("VITE_ENTERPRISE_WALLET_URL") || "http://localhost:8080");
  const appName = viteEnv("VITE_ENTERPRISE_WALLET_APP_NAME") || "truthoracle";

  const ticker = mustArg("ticker").toUpperCase();
  const eventTicker = mustArg("event").toUpperCase();
  for (const [k, v] of [
    ["ticker", ticker],
    ["event", eventTicker],
  ] as const) {
    if (!TICKER.test(v)) throw new Error(`--${k} must match ${TICKER}`);
  }
  const question = mustArg("question");
  const yesSubTitle = arg("yes") || "Yes";
  const noSubTitle = arg("no") || "No";
  const rules = arg("rules") || "Resolved by the operator from the sources named in the catalog.";
  const expiresAt = parseUtcSeconds(mustArg("expires"));
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) throw new Error("--expires must be in the future");
  // The collateral instrument: admin = the registry party (cBYN: Cantor8's transfer agent;
  // Canton Coin: the DSO), id = the token identifier. Both halves are required because a
  // market's denomination can never be changed afterwards.
  const collateral = {
    admin: argOrEnv("collateral-admin", "COLLATERAL_INSTRUMENT_ADMIN"),
    id: argOrEnv("collateral-id", "COLLATERAL_INSTRUMENT_ID"),
  };
  // Regulator visibility is not optional: the configured parties are always observers and the
  // flag can only widen the list (the backend's POST /admin/markets applies the same rule). The
  // market copies them onto every bond and model-prize PendingPayout it queues.
  const auditObservers = [
    ...new Set([
      ...partyList(viteEnv("AUDIT_OBSERVER_PARTIES"), "AUDIT_OBSERVER_PARTIES"),
      ...partyList(listArg("audit-observers"), "--audit-observers"),
    ]),
  ];
  const p0 = Number(arg("p0") ?? "0.5");
  if (!(p0 >= 0.01 && p0 <= 0.99)) throw new Error("--p0 must be within [0.01, 0.99]");
  const initialValue = Number(arg("initial-value") ?? "100");
  if (!(initialValue > 0)) throw new Error("--initial-value must be positive");
  const feeBps = Number(arg("fee") ?? "30");
  const prizeShareBps = Number(arg("prize-share") ?? "2000");
  const liquidityPeriodSecs = Number(arg("liquidity-period-secs") ?? "0");
  const graceSecs = Number(arg("grace-secs") ?? "86400");
  const isDynamic = flag("dynamic");

  const token = await keycloakToken();
  const counter = arg("counter")
    ? { contractId: arg("counter")!, value: "?" }
    : await findMarketCounter(token, party, packageName);
  console.log(
    `MarketCounter ${counter.contractId.slice(0, 16)}… (value ${counter.value}) — next marketId = ${counter.value === "?" ? "?" : Number(counter.value) + 1}`,
  );

  const commandId = `create-market-${Date.now()}-${randomUUID()}`;
  const choiceArgument: Json = {
    ticker,
    eventTicker,
    question,
    yesSubTitle,
    noSubTitle,
    resolutionDescription: rules,
    collateral,
    createdAt: String(now),
    expiresAt: String(expiresAt),
    gracePeriodSecs: String(graceSecs),
    isDynamic,
    liquidityPeriodSecs: String(liquidityPeriodSecs),
    initialProbability: p0.toFixed(10),
    initialValue: initialValue.toFixed(10),
    feeBps: String(feeBps),
    prizeFeeShareBps: String(prizeShareBps),
    policy: {
      operatorResolution: true,
      sources: [],
      sourceKeys: [],
      reporters: [],
      quorum: "0",
      challengeSecs: "0",
      bond: "0.0000000000",
    },
    auditObservers,
  };
  const body = {
    partyId: party,
    appName,
    commandId,
    commands: [
      {
        ExerciseCommand: {
          templateId: `${packageId}:Truthoracle:MarketCounter`,
          contractId: counter.contractId,
          choice: "CreateMarket",
          choiceArgument,
        },
      },
    ],
    disclosedContracts: [],
  };
  console.log(
    auditObservers.length
      ? `Audit observers: ${auditObservers.map((p) => `${p.slice(0, 24)}…`).join(", ")}`
      : "Audit observers: none — AUDIT_OBSERVER_PARTIES is blank, so no regulator party will see this market.",
  );
  console.log(
    `Submitting CreateMarket ${ticker} (event ${eventTicker}, collateral ${collateral.id} @ ${collateral.admin.slice(0, 24)}…, initial value ${initialValue}) via ${walletUrl}/api/v1/external/submit …`,
  );
  const res = await fetch(`${walletUrl}/api/v1/external/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}: ${text}`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
