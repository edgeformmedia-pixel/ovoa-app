// Proving the address in the app, and agreeing to AI (verify.ts, consent.ts):
// what an unproven new account can still reach, the code step's two routes
// against a fake Resend (no real email is ever sent), a local worker writing
// the code to its log instead, and consent standing in front of a turn and
// OVOA's voice. The SQL runs for real, on Node's own SQLite with migrations
// 0039 and 0041 applied, behind a small stand-in for D1's calls; the routes run
// on a Hono app built the way index.ts builds `authed`.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AI_CONSENT_VERSION, aiConsentFor, consentRoutes, forgetConsent, requireConsent } from "../src/consent";
import type { Env, Vars } from "../src/types";
import { emailVerifyRoutes, forgetVerified, mustVerifyNow, needsVerification, openWhileUnverified, requireVerified } from "../src/verify";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- A D1 over node:sqlite ----------

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
sqlite.exec(readFileSync("migrations/0039_email_codes.sql", "utf8"));
sqlite.exec(readFileSync("migrations/0041_verify_consent.sql", "utf8"));
const DB = d1(sqlite);

function addUser(id: string, email: string, { mustVerify = false, verified = false } = {}) {
  sqlite
    .prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, must_verify, email_verified_at) VALUES (?, ?, '', '', ?, 0, ?, ?)")
    .run(id, email, "Sam Smith", mustVerify ? 1 : 0, verified ? 1 : null);
}
const column = (id: string, name: string) => (sqlite.prepare(`SELECT ${name} AS v FROM users WHERE id = ?`).get(id) as { v: unknown }).v;

// ---------- The app, built like index.ts's `authed` ----------

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
// The session lookup, reduced to a header naming who is signed in.
app.use("*", async (c, next) => {
  c.set("userId", c.req.header("x-user") ?? "");
  await next();
});
app.use("*", requireVerified());
app.use("*", requireConsent());
app.get("/me", (c) => c.json({ ok: true }));
app.delete("/me", (c) => c.json({ ok: true }));
app.post("/auth/logout", (c) => c.json({ ok: true }));
app.get("/routines", (c) => c.json({ ok: true }));
app.post("/chat", (c) => c.json({ reply: "hello" }));
app.post("/voice/speak", (c) => c.json({ ok: true }));
app.post("/siri", (c) => c.text("hello"));
app.route("/", emailVerifyRoutes);
app.route("/", consentRoutes);

// A fake Resend: every email the routes send lands here, and none leaves the machine.
const outbox: { to: string[]; subject: string; text: string }[] = [];
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith("https://resend.test/")) throw new Error(`unexpected fetch to ${String(url)}`);
  outbox.push(JSON.parse(String(init?.body)));
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const RESEND = { DB, RESEND_API_KEY: "re_test", RESEND_API_BASE: "https://resend.test" } as unknown as Env;
const LOCAL = { DB, DEBUG_KEY: "localtest" } as unknown as Env;
const BARE = { DB } as unknown as Env;

async function call(env: Env, user: string, method: string, path: string, body?: unknown) {
  const res = await app.request(
    path,
    { method, headers: { "x-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// ---------- What an unproven new account can reach ----------

eq("GET /me is open", openWhileUnverified("GET", "/me"), true);
eq("so is deleting the account", openWhileUnverified("DELETE", "/me"), true);
eq("and signing out", openWhileUnverified("POST", "/auth/logout"), true);
eq("and the two code routes", openWhileUnverified("POST", "/me/email/code") && openWhileUnverified("POST", "/me/email/verify"), true);
eq("but not changing settings", openWhileUnverified("PATCH", "/me"), false);
eq("nor talking", openWhileUnverified("POST", "/chat"), false);
eq("nor agreeing to AI", openWhileUnverified("POST", "/me/consent"), false);
eq("new and unproven: held", mustVerifyNow({ must_verify: 1, email_verified_at: null }), true);
eq("new and proven: free to go", mustVerifyNow({ must_verify: 1, email_verified_at: 5 }), false);
eq("from before, unproven: not held by the server", mustVerifyNow({ must_verify: 0, email_verified_at: null }), false);

{
  addUser("new", "new@example.com", { mustVerify: true });
  addUser("old", "old@example.com");
  eq("new account: /me works", (await call(RESEND, "new", "GET", "/me")).status, 200);
  const blocked = await call(RESEND, "new", "GET", "/routines");
  eq("new account: anything else is 403", blocked.status, 403);
  eq("keyed on error", blocked.json.error, "needs_verification");
  eq("with a sentence to show", String(blocked.json.message).startsWith("Enter the code we emailed you"), true);
  eq("signing out still works", (await call(RESEND, "new", "POST", "/auth/logout")).status, 200);
  eq("and deleting the account", (await call(RESEND, "new", "DELETE", "/me")).status, 200);
  eq("an account from before isn't held", (await call(RESEND, "old", "GET", "/routines")).status, 200);

  // The code step, against the fake Resend.
  const sent = await call(RESEND, "new", "POST", "/me/email/code");
  eq("a code is sent", sent.status, 200);
  eq("with the wait before another", sent.json.resendInSeconds, 60);
  eq("to the account's own address", outbox[0]?.to, ["new@example.com"]);
  eq("saying what it's for", outbox[0]?.text.includes("confirm your email for OVOA"), true);
  const code = /(\d{6}) is your OVOA code/.exec(outbox[0]?.subject ?? "")?.[1] ?? "";
  eq("the subject leads with the code", code.length, 6);
  const again = await call(RESEND, "new", "POST", "/me/email/code");
  eq("another straight away waits", again.status, 429);
  eq("and says how long", typeof again.json.retryAfter === "number" && (again.json.retryAfter as number) <= 60, true);
  eq("nothing more was sent", outbox.length, 1);
  const wrong = await call(RESEND, "new", "POST", "/me/email/verify", { code: code === "000000" ? "111111" : "000000" });
  eq("a wrong code is 400", wrong.status, 400);
  eq("with the tries left", wrong.json.attemptsLeft, 4);
  eq("still held", (await call(RESEND, "new", "GET", "/routines")).status, 403);
  const right = await call(RESEND, "new", "POST", "/me/email/verify", { code: `${code.slice(0, 3)} ${code.slice(3)}` });
  eq("the right one, pasted with a space", right.json, { ok: true, emailVerified: true });
  eq("is written down", column("new", "email_verified_at") !== null, true);
  eq("and everything opens up", (await call(RESEND, "new", "GET", "/routines")).status, 200);
  eq("a proven account asking for a code gets none", (await call(RESEND, "new", "POST", "/me/email/code")).json.emailVerified, true);
  eq("still just the one email", outbox.length, 1);

  // Proven is remembered on this isolate: it can't be taken back.
  forgetVerified();
  eq("read again after forgetting, still proven", await needsVerification({ DB }, "new"), false);
  eq("no such account: not held (GET /me answers 401 for it)", await needsVerification({ DB }, "gone"), false);
}

// A local worker: no Resend key, a debug key. The code goes to its log, not to anyone.
{
  addUser("local", "local@example.com", { mustVerify: true });
  const logged: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  const res = await call(LOCAL, "local", "POST", "/me/email/code");
  console.log = log;
  eq("a local worker gives a code", res.status, 200);
  const line = logged.find((l) => l.startsWith("ovoa.dev email code"));
  eq("to its own log", !!line, true);
  eq("without the address", line?.includes("local@example.com"), false);
  eq("and nothing went to Resend", outbox.length, 1);
  const code = /code (\d{6})/.exec(line ?? "")?.[1] ?? "";
  eq("the logged code works", (await call(LOCAL, "local", "POST", "/me/email/verify", { code })).status, 200);

  addUser("nokey", "nokey@example.com", { mustVerify: true });
  const none = await call(BARE, "nokey", "POST", "/me/email/code");
  eq("no Resend key and no debug key: 502, not a silent success", none.status, 502);
  eq("and the failed one didn't count: a new try isn't told to wait", (await call(BARE, "nokey", "POST", "/me/email/code")).status, 502);
}

// ---------- Consent ----------

{
  addUser("ai", "ai@example.com", { verified: true });
  forgetConsent();
  eq("not agreed yet", await aiConsentFor({ DB }, "ai"), "needed");
  const chat = await call(BARE, "ai", "POST", "/chat", { message: "hi" });
  eq("a turn is 403 before anything is sent", chat.status, 403);
  eq("keyed on error", chat.json.error, "needs_consent");
  eq("OVOA's voice too (Deepgram)", (await call(BARE, "ai", "POST", "/voice/speak", { text: "Hello" })).json.error, "needs_consent");
  const siri = await call(BARE, "ai", "POST", "/siri", { message: "hi" });
  eq("Siri hears it as a sentence", [siri.status, siri.text.startsWith("Before I can answer")], [403, true]);
  eq("routes that call no model don't care", (await call(BARE, "ai", "GET", "/routines")).status, 200);
  eq("a version is required", (await call(BARE, "ai", "POST", "/me/consent", {})).status, 400);
  const agreed = await call(BARE, "ai", "POST", "/me/consent", { version: AI_CONSENT_VERSION });
  eq("agreeing", (agreed.json.aiConsent as { given: boolean }).given, true);
  eq("to this wording", (agreed.json.aiConsent as { version: number }).version, AI_CONSENT_VERSION);
  eq("is written down", column("ai", "ai_consent_at") !== null, true);
  eq("and a turn goes through at once", (await call(BARE, "ai", "POST", "/chat", { message: "hi" })).status, 200);
  eq("and the voice", (await call(BARE, "ai", "POST", "/voice/speak", { text: "Hello" })).status, 200);
  const newer = await call(BARE, "ai", "POST", "/me/consent", { version: AI_CONSENT_VERSION + 5 });
  eq("a version past the server's is kept as the server's", (newer.json.aiConsent as { version: number }).version, AI_CONSENT_VERSION);
  const back = await call(BARE, "ai", "DELETE", "/me/consent");
  eq("taking it back", (back.json.aiConsent as { given: boolean }).given, false);
  eq("stops turns at once on this isolate", (await call(BARE, "ai", "POST", "/chat", { message: "hi" })).status, 403);

  // Only a yes is remembered: a no is read again, so agreeing on another isolate counts at once.
  forgetConsent();
  eq("no again", await aiConsentFor({ DB }, "ai", 1_000), "needed");
  sqlite.prepare("UPDATE users SET ai_consent_at = 1, ai_consent_version = ? WHERE id = 'ai'").run(AI_CONSENT_VERSION);
  eq("agreed somewhere else: seen on the next ask", await aiConsentFor({ DB }, "ai", 2_000), "given");
  sqlite.prepare("UPDATE users SET ai_consent_at = NULL, ai_consent_version = NULL WHERE id = 'ai'").run();
  eq("taken back somewhere else: this isolate's yes stands for its minute", await aiConsentFor({ DB }, "ai", 30_000), "given");
  eq("and not after it", await aiConsentFor({ DB }, "ai", 70_000), "needed");
  sqlite.prepare("UPDATE users SET ai_consent_at = 1, ai_consent_version = 0 WHERE id = 'ai'").run();
  forgetConsent();
  eq("agreeing to an older wording counts as not agreed", await aiConsentFor({ DB }, "ai"), "needed");
}

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("all passed");
