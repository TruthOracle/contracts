/**
 * TruthOracle — create a PredictionMarket on the ledger as the treasury (ledger-first path).
 *
 * Exercises MarketCounter.CreateMarket through the Enterprise Wallet's single-call
 * POST /api/v1/external/submit (the wallet prepares, signs and executes as the admin party).
 * The catalog side (series / event rows) is NOT written here: the backend indexer creates
 * placeholder rows for an unknown event ticker and an operator renames them later. The
 * operator console (`POST /admin/markets` in truthoracle-backend) is the primary path — it
 * validates the catalog first — so use this script for bootstrapping and smoke tests.
 *
 * Usage:
 *   npm run create:market -- --ticker FED-26DEC-CUT25 --event FED-26DEC \
 *     --question "Will the Fed cut by at least 25 bps in December 2026?" \
 *     --yes "Cut of 25 bps or more" --no "Smaller cut, hold or hike" \
 *     --rules "Resolves YES if the FOMC statement lowers the target range by >= 25 bps." \
 *     --expires 2026-12-16T19:00:00Z --p0 0.35 --value 200 [--fee 30] [--prize-share 2000] \
 *     [--dynamic] [--liquidity-period-secs 0] [--grace-secs 86400] [--counter <MarketCounter cid>]
 *
 * Required .env: VITE_TRUTHORACLE_PACKAGE_ID, VITE_TRUTHORACLE_PACKAGE_NAME,
 *   VITE_ENTERPRISE_WALLET_PARTY_ID, KEYCLOAK_* (wallet + ledger tokens),
 *   VITE_CANTON_PARTICIPANT_URL (to find the active MarketCounter when --counter is omitted).
 */

import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", ".env") });

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

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

const TICKER = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;

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

/** The single active MarketCounter of the package, as seen by the admin party. */
async function findMarketCounter(
  token: string,
  party: string,
  packageName: string,
): Promise<{ contractId: string; value: string }> {
  const ledger = stripTrailingSlash(mustEnv(viteEnv("VITE_CANTON_PARTICIPANT_URL"), "VITE_CANTON_PARTICIPANT_URL"));
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const end = (await (await fetch(`${ledger}/v2/state/ledger-end`, { headers })).json()) as { offset?: number };
  const body = {
    verbose: false,
    activeAtOffset: String(end.offset ?? 0),
    filter: {
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
    console.log("See the header comment of scripts/create-market.ts for usage.");
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
  const expiresAt = Math.floor(Date.parse(mustArg("expires")) / 1000);
  if (!Number.isFinite(expiresAt)) throw new Error("--expires must be an ISO-8601 timestamp");
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) throw new Error("--expires must be in the future");
  const p0 = Number(arg("p0") ?? "0.5");
  if (!(p0 >= 0.01 && p0 <= 0.99)) throw new Error("--p0 must be within [0.01, 0.99]");
  const value = Number(arg("value") ?? "100");
  if (!(value > 0)) throw new Error("--value must be positive");
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
    createdAt: String(now),
    expiresAt: String(expiresAt),
    gracePeriodSecs: String(graceSecs),
    isDynamic,
    liquidityPeriodSecs: String(liquidityPeriodSecs),
    initialProbability: p0.toFixed(10),
    initialValueCC: value.toFixed(10),
    feeBps: String(feeBps),
    prizeFeeShareBps: String(prizeShareBps),
    policy: {
      operatorResolution: true,
      sources: [],
      sourceKeys: [],
      reporters: [],
      quorum: "0",
      challengeSecs: "0",
      bondCC: "0.0000000000",
    },
    auditObservers: [],
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
  console.log(`Submitting CreateMarket ${ticker} (event ${eventTicker}) via ${walletUrl}/api/v1/external/submit …`);
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
