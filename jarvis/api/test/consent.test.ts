// Consent's second wording (consent.ts, 2026-09-23): the screen now names
// Cloudflare (Workers AI), which answers spoken turns and the AI-led setup, so
// everyone agrees once more; an app still showing the first wording can't agree
// to the second; and a setup turn is held back like any other turn. The SQL
// runs on Node's own SQLite with migration 0041 applied, behind a small
// stand-in for D1's calls; the routes run on a Hono app built the way index.ts
// builds `authed` (verify.test.ts has the rest of consent).

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AI_CONSENT_LATEST, AI_CONSENT_VERSION, consentGiven, consentRoutes, consentView, forgetConsent, needsConsentFor, requireConsent } from "../src/consent";
import type { Env, Vars } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- The wording ----------

// The wording that names Cloudflare is the second; it is only required once the
// build that shows it is installed, so builds 67 and 68 keep their AI meanwhile.
eq("the newest wording is the second", AI_CONSENT_LATEST, 2);
eq("the first still counts until the bump", AI_CONSENT_VERSION, 1);
eq("agreeing to the first counts for now", consentGiven({ ai_consent_at: 1, ai_consent_version: 1 }), true);
eq("agreeing to the second does too", consentGiven({ ai_consent_at: 1, ai_consent_version: 2 }), true);
eq("/me reports what they agreed to", consentView({ ai_consent_at: 1, ai_consent_version: 2 }), { given: true, version: 2, at: 1, current: 1 });

// ---------- Which routes wait for it ----------

eq("a setup turn waits for it", needsConsentFor("POST", "/onboarding/turn"), true);
eq("as a Talk turn does", needsConsentFor("POST", "/chat"), true);
eq("where setup stands doesn't (no model)", needsConsentFor("GET", "/onboarding/state"), false);
eq("nor putting setup off", needsConsentFor("POST", "/onboarding/finish"), false);
eq("nor build 67's old answer route (the gate on its model call refuses it)", needsConsentFor("POST", "/onboarding/answer"), false);

// ---------- An old app, then the new one ----------

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
sqlite.exec(readFileSync("migrations/0041_verify_consent.sql", "utf8"));
// Signed up, never agreed.
sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, ai_consent_at, ai_consent_version) VALUES ('u', 'u@example.com', '', '', 'Sam', 0, NULL, NULL)").run();
const env = { DB: d1(sqlite) } as unknown as Env;

let turns = 0;
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("userId", "u");
  await next();
});
app.use("*", requireConsent());
app.post("/onboarding/turn", (c) => {
  turns++;
  return c.json({ reply: "Hi." });
});
app.route("/", consentRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

forgetConsent();
const before = await call("POST", "/onboarding/turn", { turnId: "turn-0001", action: "start" });
eq("someone who hasn't agreed: a setup turn is 403", before.status, 403);
eq("keyed on needs_consent", before.json.error, "needs_consent");
eq("and nothing ran", turns, 0);
const old = (await call("POST", "/me/consent", { version: 1 })).json.aiConsent as { given: boolean; version: number };
eq("an app still showing the first wording can agree, for now", [old.given, old.version], [true, 1]);
eq("so its setup turn goes through", (await call("POST", "/onboarding/turn", { turnId: "turn-0002", action: "start" })).status, 200);
const agreed = (await call("POST", "/me/consent", { version: 2 })).json.aiConsent as { given: boolean; version: number };
eq("the new screen's yes is kept as the second, so the later bump won't ask again", [agreed.given, agreed.version], [true, 2]);
const future = (await call("POST", "/me/consent", { version: 7 })).json.aiConsent as { version: number };
eq("a wording the server doesn't know yet is kept as the newest it knows", future.version, AI_CONSENT_LATEST);
eq("and the setup turn goes through", (await call("POST", "/onboarding/turn", { turnId: "turn-0003", action: "start" })).status, 200);
eq("twice in all", turns, 2);

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("all passed");
