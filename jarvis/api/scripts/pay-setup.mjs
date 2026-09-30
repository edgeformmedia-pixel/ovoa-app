// Turns OVOA paying on (src/pay.ts, docs/pay.md), once Stripe has approved the
// account for Issuing: makes (or reuses) the cardholder the one-time cards are
// issued to, points a Stripe webhook at https://api.ovoa.ai/pay/webhook for
// the cards' charges, and puts the three secrets on the Worker. Safe to run
// again: it replaces the webhook and its secret.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/pay-setup.mjs
//
// The values come from ovoa-team/stripe/pay.env (that folder is gitignored), or
// from the environment, which wins:
//
//     STRIPE_SECRET_KEY=sk_live_...     the live secret key of the account with Issuing
//     PAY_CARDHOLDER_ID=ich_...         optional: an existing cardholder to reuse
//     PAY_CARDHOLDER_NAME=OVOA AI       otherwise one is made, a company, with
//     PAY_CARDHOLDER_EMAIL=admin@ovoa.ai
//     PAY_BILLING_LINE1=...             the business address merchants check the card against
//     PAY_BILLING_CITY=...
//     PAY_BILLING_STATE=FL
//     PAY_BILLING_POSTAL=...
//
// A test key (sk_test_) is refused for api.ovoa.ai: test mode goes on a test
// Worker (WORKER_URL=...), never the live one. --dry-run checks the key and
// Issuing and says what it would do, and changes nothing.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const KEYS_FILE = join(apiDir, "..", "..", "..", "ovoa-team", "stripe", "pay.env");
const STRIPE = "https://api.stripe.com/v1";
const WORKER = (process.env.WORKER_URL || "https://api.ovoa.ai").replace(/\/+$/, "");
const WEBHOOK = `${WORKER}/pay/webhook`;
const EVENTS = ["issuing_authorization.created", "issuing_transaction.created"];
const dry = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** KEY=value lines; quotes and a leading `export` allowed. */
function readKeys(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const file = readKeys(KEYS_FILE);
const key = (name) => (process.env[name] || file[name] || "").trim();
const secret = key("STRIPE_SECRET_KEY");

console.log(`Values from ${existsSync(KEYS_FILE) ? KEYS_FILE : "the environment"}`);
if (!/^(sk|rk)_(live|test)_/.test(secret)) fail(`STRIPE_SECRET_KEY is needed (in ${KEYS_FILE}, or the environment).`);
if (secret.includes("_test_") && WORKER === "https://api.ovoa.ai") fail("That's a test key. Test mode never goes on api.ovoa.ai: set WORKER_URL to a test Worker.");

function form(params, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? form(item, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))));
    else if (typeof v === "object") form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function stripe(method, path, params) {
  const body = params ? form(params).toString() : "";
  const url = method === "GET" && body ? `${STRIPE}${path}?${body}` : `${STRIPE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${secret}`, "Stripe-Version": "2024-06-20", ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(method === "POST" ? { body } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message ?? `Stripe returned ${res.status}`);
  return json;
}

// 1. The key, and Issuing on it.
const account = await stripe("GET", "/account").catch((err) => fail(`The key doesn't work: ${err.message}`));
console.log(`✓ Stripe account ${account.id} (${account.settings?.dashboard?.display_name ?? account.email ?? "no name"})`);
const issuing = await stripe("GET", "/issuing/cardholders", { limit: 1 }).catch((err) => err);
if (issuing instanceof Error) fail(`Issuing isn't on for this account yet: ${issuing.message}\nApply in the Stripe dashboard (Issuing), then run this again.`);
console.log("✓ Issuing is on");
const balance = await stripe("GET", "/balance").catch(() => null);
const funded = balance?.issuing?.available?.find((b) => b.currency === "usd")?.amount ?? 0;
console.log(`${funded > 0 ? "✓" : "!"} Issuing balance: $${(funded / 100).toFixed(2)}${funded > 0 ? "" : "  (top it up in the dashboard: the one-time cards spend from it)"}`);

// 2. The cardholder.
let cardholder = key("PAY_CARDHOLDER_ID");
if (cardholder) {
  const found = await stripe("GET", `/issuing/cardholders/${cardholder}`).catch((err) => fail(`Cardholder ${cardholder}: ${err.message}`));
  console.log(`✓ Cardholder ${found.id} (${found.name}, ${found.status})`);
} else {
  const address = {
    line1: key("PAY_BILLING_LINE1"),
    city: key("PAY_BILLING_CITY"),
    state: key("PAY_BILLING_STATE"),
    postal_code: key("PAY_BILLING_POSTAL"),
    country: "US",
  };
  if (!address.line1 || !address.city || !address.state || !address.postal_code) {
    fail("No PAY_CARDHOLDER_ID, and no business address to make one with: PAY_BILLING_LINE1, _CITY, _STATE and _POSTAL are needed.");
  }
  const params = {
    type: "company",
    name: key("PAY_CARDHOLDER_NAME") || "OVOA AI",
    email: key("PAY_CARDHOLDER_EMAIL") || "admin@ovoa.ai",
    status: "active",
    billing: { address },
  };
  if (dry) console.log(`· would make a company cardholder "${params.name}" at ${address.line1}, ${address.city}`);
  else {
    const made = await stripe("POST", "/issuing/cardholders", params).catch((err) => fail(`Couldn't make the cardholder: ${err.message}`));
    cardholder = made.id;
    console.log(`✓ Made cardholder ${made.id} (${made.name}). Add PAY_CARDHOLDER_ID=${made.id} to ${KEYS_FILE} so a rerun reuses it.`);
  }
}

// 3. The webhook: an old one at the same address is replaced.
const { data: hooks } = await stripe("GET", "/webhook_endpoints", { limit: 100 });
const old = hooks.filter((h) => h.url === WEBHOOK);
if (dry) {
  console.log(`· would ${old.length ? "replace" : "make"} the webhook ${WEBHOOK} for ${EVENTS.join(", ")}`);
  console.log("\nDry run: nothing changed.");
  process.exit(0);
}
for (const h of old) await stripe("DELETE", `/webhook_endpoints/${h.id}`);
const hook = await stripe("POST", "/webhook_endpoints", { url: WEBHOOK, enabled_events: EVENTS, api_version: "2024-06-20", description: "OVOA paying: one-time card charges (jarvis-api pay.ts)" });
console.log(`✓ Webhook ${hook.id} → ${WEBHOOK}`);

// 4. The Worker's secrets.
function put(name, value) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], { cwd: apiDir, input: value, shell: true, encoding: "utf8", env: process.env });
  if (r.status !== 0) fail(`wrangler secret put ${name} failed:\n${(r.stderr || r.stdout).slice(-600)}\n(Run it with XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa.)`);
  console.log(`✓ ${name} is on the Worker`);
}
put("STRIPE_SECRET_KEY", secret);
put("STRIPE_PAY_WEBHOOK_SECRET", hook.secret);
put("STRIPE_ISSUING_CARDHOLDER", cardholder);
console.log("\nPaying is on. Text OVOA “save my card” to try it.");
