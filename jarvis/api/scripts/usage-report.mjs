// What OVOA cost to run, day by day, from Cloudflare's own analytics.
//
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-edgeformmedia node scripts/usage-report.mjs [days]
//
// Reads the same OAuth token wrangler uses (from the profile named by
// XDG_CONFIG_HOME, or CF_API_TOKEN if that is set) and asks the GraphQL API for
// the last few days of Workers AI tokens and neurons per model, Worker requests
// and CPU time, and D1 rows read and written. Prints one table per dataset.
// The token is never printed. Nothing here writes anything.
//
// Cloudflare only keeps these adaptive datasets for a limited time and samples
// heavy days, so the numbers are close rather than exact. They are the before
// and after for every phase of the cost pass (docs/cost-cut-prompt.md).

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACCOUNT = "33594882ed1877edb5cee6f495ca7fae";
const SCRIPT = "jarvis-api";
const DATABASE = "96162569-6625-4cad-af9c-62a3f6820033";
const days = Math.max(1, Math.min(31, Number(process.argv[2] ?? 7)));

function token() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const home = process.env.XDG_CONFIG_HOME;
  if (!home) throw new Error("Set XDG_CONFIG_HOME to the wrangler profile folder, or CF_API_TOKEN");
  const toml = readFileSync(join(home, ".wrangler", "config", "default.toml"), "utf8");
  const m = /oauth_token\s*=\s*"([^"]+)"/.exec(toml);
  if (!m) throw new Error("No oauth_token in the wrangler profile; run `npx wrangler login` with that XDG_CONFIG_HOME");
  const exp = /expiration_time\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  if (exp && new Date(exp).getTime() < Date.now()) {
    console.error("note: the wrangler token has expired; run any wrangler command with the profile to refresh it, then retry");
  }
  return m[1];
}

async function query(gql, variables) {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    body: JSON.stringify({ query: gql, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data.viewer.accounts[0];
}

const dayOf = (d) => d.toISOString().slice(0, 10);
const end = new Date();
const start = new Date(end.getTime() - days * 86_400_000);
const range = { start: dayOf(start), end: dayOf(end) };

const ai = await query(
  `query ($account: String!, $start: Date!, $end: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      aiInferenceAdaptiveGroups(limit: 500, filter: { date_geq: $start, date_leq: $end }, orderBy: [date_ASC]) {
        dimensions { date modelId }
        count
        sum { totalNeurons totalInputTokens totalOutputTokens }
      }
    } }
  }`,
  { account: ACCOUNT, ...range },
);

const workers = await query(
  `query ($account: String!, $start: Date!, $end: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 500, filter: { date_geq: $start, date_leq: $end, scriptName: "${SCRIPT}" }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    } }
  }`,
  { account: ACCOUNT, ...range },
);

const d1 = await query(
  `query ($account: String!, $start: Date!, $end: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      d1AnalyticsAdaptiveGroups(limit: 500, filter: { date_geq: $start, date_leq: $end, databaseId: "${DATABASE}" }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes }
      }
    } }
  }`,
  { account: ACCOUNT, ...range },
);

const n = (v) => (v ?? 0).toLocaleString("en-US");

console.log(`\nWorkers AI, ${range.start} to ${range.end} (neurons: 1K = $0.011 after the 10K/day free)`);
console.log("date        model                                   requests      in tokens     out tokens     neurons");
for (const g of ai.aiInferenceAdaptiveGroups) {
  const s = g.sum;
  console.log(
    `${g.dimensions.date}  ${g.dimensions.modelId.padEnd(38)} ${n(g.count).padStart(8)} ${n(s.totalInputTokens).padStart(14)} ${n(s.totalOutputTokens).padStart(14)} ${n(s.totalNeurons).padStart(11)}`,
  );
}

console.log(`\nWorker ${SCRIPT}`);
console.log("date        requests    errors   subrequests   cpu p50 ms   cpu p99 ms");
for (const g of workers.workersInvocationsAdaptive) {
  const s = g.sum;
  const q = g.quantiles;
  console.log(
    `${g.dimensions.date}  ${n(s.requests).padStart(8)} ${n(s.errors).padStart(9)} ${n(s.subrequests).padStart(13)} ${((q.cpuTimeP50 ?? 0) / 1000).toFixed(1).padStart(12)} ${((q.cpuTimeP99 ?? 0) / 1000).toFixed(1).padStart(12)}`,
  );
}

console.log(`\nD1 jarvis-db`);
console.log("date        read queries   write queries      rows read   rows written");
for (const g of d1.d1AnalyticsAdaptiveGroups) {
  const s = g.sum;
  console.log(
    `${g.dimensions.date}  ${n(s.readQueries).padStart(12)} ${n(s.writeQueries).padStart(15)} ${n(s.rowsRead).padStart(14)} ${n(s.rowsWritten).padStart(14)}`,
  );
}
console.log();
