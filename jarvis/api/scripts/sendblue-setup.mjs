// Turns texting OVOA on (src/texting.ts, docs/texting.md): puts the Sendblue
// keys and OVOA's number on the Worker, makes a new webhook secret, and tells
// Sendblue to post every text to https://api.ovoa.ai/texting/webhook with it.
// Safe to run again at any time: it replaces the webhook and its secret.
//
//     cd jarvis/api
//     XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa node scripts/sendblue-setup.mjs
//
// The keys come from ovoa-team/sendblue/.env (gitignored there), or from the
// environment, which wins:
//
//     SENDBLUE_API_KEY_ID=...     Sendblue dashboard, API keys: the key id
//     SENDBLUE_API_SECRET=...     and its secret
//     SENDBLUE_NUMBER=+1...       the Sendblue line people text, as +15551234567
//
// --dry-run checks the keys against Sendblue and says what it would do, and
// changes nothing.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const KEYS_FILE = join(apiDir, "..", "..", "..", "ovoa-team", "sendblue", ".env");
const SENDBLUE = (process.env.SENDBLUE_API_BASE || "https://api.sendblue.co").replace(/\/+$/, "");
const WORKER = (process.env.WORKER_URL || "https://api.ovoa.ai").replace(/\/+$/, "");
const WEBHOOK = `${WORKER}/texting/webhook`;
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
const keyId = key("SENDBLUE_API_KEY_ID");
const secret = key("SENDBLUE_API_SECRET");
const number = key("SENDBLUE_NUMBER").replace(/[\s()-]/g, "");

console.log(`Keys from ${existsSync(KEYS_FILE) ? KEYS_FILE : "the environment"}`);
if (!keyId || !secret) fail(`SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET are needed (in ${KEYS_FILE}, or the environment).`);
if (!/^\+[1-9]\d{7,14}$/.test(number)) fail(`SENDBLUE_NUMBER must be the Sendblue line as +15551234567, not "${number}".`);

async function sendblue(method, path, body) {
  const res = await fetch(`${SENDBLUE}${path}`, {
    method,
    headers: { "content-type": "application/json", "sb-api-key-id": keyId, "sb-api-secret-key": secret },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: the status says enough.
  }
  if (!res.ok) fail(`Sendblue ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return json ?? {};
}

/** The receive webhooks' URLs, whether Sendblue lists them as strings or as {url, secret}. */
const receiveUrls = (listed) => (listed?.webhooks?.receive ?? []).map((w) => (typeof w === "string" ? w : w?.url)).filter(Boolean);

// 1. The keys work, and what Sendblue has now.
const before = await sendblue("GET", "/api/account/webhooks");
console.log(`✓ Sendblue accepts the keys. Receive webhooks now: ${receiveUrls(before).join(", ") || "none"}`);
if (before?.webhooks?.globalSecret) {
  console.log("! The account has a global webhook secret. This sets one on OVOA's webhook itself; if Sendblue sends the global one instead, texts will be refused (401) until the two match.");
}

const webhookSecret = randomBytes(32).toString("hex");
if (dry) {
  console.log(`\nDry run. It would:\n  - put SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET, SENDBLUE_NUMBER (${number}) and a new SENDBLUE_WEBHOOK_SECRET on the Worker\n  - point Sendblue's receive webhook at ${WEBHOOK}, with that secret`);
  process.exit(0);
}

// 2. The Worker gets the keys, the number and the new secret. Each put deploys a new version.
for (const [name, value] of [
  ["SENDBLUE_API_KEY_ID", keyId],
  ["SENDBLUE_API_SECRET", secret],
  ["SENDBLUE_NUMBER", number],
  ["SENDBLUE_WEBHOOK_SECRET", webhookSecret],
]) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], { cwd: apiDir, input: value, shell: true, encoding: "utf8", env: process.env });
  if (r.status !== 0) fail(`wrangler secret put ${name} failed:\n${(r.stderr || r.stdout).slice(-600)}\n(Run it with XDG_CONFIG_HOME=C:/Users/thoma/.wrangler-ovoa.)`);
  console.log(`✓ ${name} is on the Worker`);
}

// 3. Sendblue posts every text to the webhook, with the secret.
if (receiveUrls(before).includes(WEBHOOK)) await sendblue("DELETE", "/api/account/webhooks", { webhooks: [WEBHOOK], type: "receive" });
await sendblue("POST", "/api/account/webhooks", { webhooks: [{ url: WEBHOOK, secret: webhookSecret }], type: "receive" });
const after = await sendblue("GET", "/api/account/webhooks");
if (!receiveUrls(after).includes(WEBHOOK)) fail(`Sendblue didn't list ${WEBHOOK} after adding it: ${JSON.stringify(after).slice(0, 300)}`);
console.log(`✓ Sendblue posts texts to ${WEBHOOK}`);

// 4. The Worker knows the secret: a report of one of OVOA's own texts is answered 200 and ignored.
let ok = false;
for (let i = 0; i < 10 && !ok; i++) {
  if (i) await new Promise((r) => setTimeout(r, 3000));
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "sb-signing-secret": webhookSecret },
    body: JSON.stringify({ is_outbound: true, from_number: number, content: "", message_handle: `setup-check-${Date.now()}` }),
  }).catch(() => null);
  ok = res?.status === 200;
  if (!ok) console.log(`  the Worker answered ${res?.status ?? "nothing"}; waiting for the new secret to reach it…`);
}
if (!ok) fail("The Worker never took the new secret. Check `npx wrangler secret list`, then run this again.");
console.log("✓ The Worker takes Sendblue's webhook");

console.log(`\nTexting is on. In the app: Settings, Assistant, Link my number. Then text ${number} from that iPhone.`);
