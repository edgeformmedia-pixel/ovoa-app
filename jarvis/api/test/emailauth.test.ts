// Proving an address (emailauth.ts): the codes, their limits, the signup
// tickets, the email, and what counts as a Google sign-in. The SQL runs for
// real, on Node's own SQLite with migration 0039 applied, behind a small
// stand-in for D1's calls.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  checkCode,
  cleanCode,
  CODE_ATTEMPTS,
  CODE_RESEND_MS,
  CODE_SENDS_PER_HOUR,
  CODE_TTL_MS,
  codeEmail,
  codesAvailable,
  deliverCode,
  googleAudiences,
  googleIdentityFrom,
  issueCode,
  issueTicket,
  newCode,
  pruneEmailAuth,
  readTicket,
  sendEmail,
  spendTicket,
  TICKET_TTL_MS,
  unsendCode,
  verifyGoogleIdToken,
} from "../src/emailauth";

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
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  sqlite.exec(readFileSync("migrations/0039_email_codes.sql", "utf8"));
  return { sqlite, db: d1(sqlite) };
}

// ---------- The code itself ----------

eq("a code is six digits", /^\d{6}$/.test(newCode()), true);
{
  // 4294000000 is past the last whole million below 2^32, so it's drawn again.
  const draws = [4_294_000_000, 1_234_567];
  eq("draws past the last whole million are thrown back", newCode((buf) => void (buf[0] = draws.shift()!)), "234567");
}
eq("small numbers keep their zeros", newCode((buf) => void (buf[0] = 42)), "000042");
eq("spaces and dashes pasted from the email go", cleanCode(" 123-456 "), "123456");

// ---------- Sending, and the limits on it ----------

{
  const { db } = freshDb();
  const t0 = 1_000_000_000_000;
  const a = await issueCode(db, "a@example.com", t0, "111111");
  eq("the first code is issued", a, { code: "111111" });
  eq("a second one straight after waits", await issueCode(db, "a@example.com", t0 + 1000, "222222"), {
    waitSeconds: 59,
  });
  eq("another address isn't held up", await issueCode(db, "b@example.com", t0 + 1000, "333333"), { code: "333333" });

  let t = t0;
  for (let n = 2; n <= CODE_SENDS_PER_HOUR; n++) {
    t += CODE_RESEND_MS;
    await issueCode(db, "a@example.com", t, "444444");
  }
  t += CODE_RESEND_MS;
  const sixth = await issueCode(db, "a@example.com", t, "555555");
  eq("past five an hour it waits for the hour", "waitSeconds" in sixth && sixth.waitSeconds > 60, true);
  eq("and the hour is counted from the first", await issueCode(db, "a@example.com", t0 + 60 * 60 * 1000, "666666"), {
    code: "666666",
  });

  // An email that didn't go out doesn't make them wait or count against the hour.
  const c1 = await issueCode(db, "c@example.com", t0, "777777");
  eq("c gets a code", c1, { code: "777777" });
  await unsendCode(db, "c@example.com");
  eq("an unsent code can be replaced at once", await issueCode(db, "c@example.com", t0 + 1000, "888888"), {
    code: "888888",
  });
  eq("and the unsent one no longer works", await checkCode(db, "c@example.com", "777777", t0 + 2000), {
    ok: false,
    reason: "wrong",
    attemptsLeft: CODE_ATTEMPTS - 1,
  });
}

// ---------- Checking ----------

{
  const { db } = freshDb();
  const t0 = 1_000_000_000_000;
  await issueCode(db, "a@example.com", t0, "123456");
  eq("a wrong code says how many tries are left", await checkCode(db, "a@example.com", "000000", t0 + 1), {
    ok: false,
    reason: "wrong",
    attemptsLeft: 4,
  });
  eq("too short is just wrong", (await checkCode(db, "a@example.com", "123", t0 + 1)).ok, false);
  eq("the right one, pasted with a space", await checkCode(db, "a@example.com", "123 456", t0 + 2), { ok: true });
  eq("it works once", await checkCode(db, "a@example.com", "123456", t0 + 3), { ok: false, reason: "expired" });

  await issueCode(db, "b@example.com", t0, "654321");
  eq("it has run out after ten minutes", await checkCode(db, "b@example.com", "654321", t0 + CODE_TTL_MS), {
    ok: false,
    reason: "expired",
  });

  await issueCode(db, "c@example.com", t0, "999999");
  for (let i = 1; i < CODE_ATTEMPTS; i++) await checkCode(db, "c@example.com", "000000", t0 + i);
  eq("the fifth wrong try voids the code", await checkCode(db, "c@example.com", "000001", t0 + 10), {
    ok: false,
    reason: "expired",
  });
  eq("and then even the right one fails", await checkCode(db, "c@example.com", "999999", t0 + 11), {
    ok: false,
    reason: "expired",
  });

  await issueCode(db, "d@example.com", t0, "246810");
  const all = await Promise.all(
    Array.from({ length: 20 }, (_, i) => checkCode(db, "d@example.com", String(100000 + i), t0 + 1)),
  );
  eq("twenty guesses at once still get five between them", all.filter((r) => !r.ok && r.reason === "wrong").length, 4);
  eq("no address, no code", await checkCode(db, "nobody@example.com", "123456", t0), { ok: false, reason: "expired" });
}

// ---------- Signup tickets ----------

{
  const { sqlite, db } = freshDb();
  const t0 = 1_000_000_000_000;
  const ticket = await issueTicket(db, "new@example.com", "Ada Lovelace", t0);
  eq("a ticket is 48 hex characters", /^[0-9a-f]{48}$/.test(ticket), true);
  eq("only its hash is stored", sqlite.prepare("SELECT count(*) n FROM signup_tickets WHERE ticket_hash = ?").get(ticket), {
    n: 0,
  });
  eq("reading it says whose it is", await readTicket(db, ticket, t0 + 1), { email: "new@example.com", name: "Ada Lovelace" });
  eq("spending it gives the same", await spendTicket(db, ticket, t0 + 2), { email: "new@example.com", name: "Ada Lovelace" });
  eq("and it's good once", await spendTicket(db, ticket, t0 + 3), null);
  const late = await issueTicket(db, "late@example.com", null, t0);
  eq("half an hour later it has run out", await spendTicket(db, late, t0 + TICKET_TTL_MS), null);
  eq("anything that isn't a ticket is nothing", await readTicket(db, "'; DROP TABLE users; --", t0), null);

  // The nightly tidy-up.
  await issueCode(db, "old@example.com", t0, "121212");
  await issueCode(db, "recent@example.com", t0 + 2 * 60 * 60 * 1000, "343434");
  await db.batch(pruneEmailAuth(db, t0 + 2 * 60 * 60 * 1000 + 1));
  eq(
    "the tidy-up keeps codes from the last hour and drops the rest",
    sqlite.prepare("SELECT email FROM email_codes ORDER BY email").all().map((r) => (r as { email: string }).email),
    ["recent@example.com"],
  );
  eq("and every ticket that has run out", sqlite.prepare("SELECT count(*) n FROM signup_tickets").get(), { n: 0 });
}

// ---------- The email ----------

{
  const signIn = codeEmail({ to: "a@example.com", code: "042137", name: "Ada Lovelace", existing: true });
  eq("the subject leads with the code", signIn.subject, "042137 is your OVOA code");
  eq("an account holder is greeted by first name", signIn.text.startsWith("Hi Ada,"), true);
  eq("and told it's to sign in", signIn.text.includes("sign in to OVOA"), true);
  eq("the code is in the page", signIn.html.includes(">042137</p>"), true);
  const create = codeEmail({ to: "b@example.com", code: "000001", name: null, existing: false });
  eq("someone new is told it's to create an account", create.text.includes("create your OVOA account"), true);
  eq("no name, no name", create.text.startsWith("Hi,"), true);
  eq("names can't write HTML", codeEmail({ to: "c@x.co", code: "1", name: "<b>x", existing: true }).html.includes("<b>x"), false);
  eq("no em dashes in the copy", /—/.test(signIn.text + create.text), false);
  const confirm = codeEmail({ to: "d@example.com", code: "314159", name: "Sam", existing: true, confirm: true });
  eq("the app's code step says it's to confirm the address", confirm.text.includes("confirm your email for OVOA"), true);
  eq("and not that it's a sign-in", confirm.text.includes("sign in"), false);
}

{
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const resend = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response("{}", { status: 200 });
  };
  const email = codeEmail({ to: "a@example.com", code: "123456", name: null, existing: false });
  eq("no key, nothing sent", await sendEmail({}, email, resend), false);
  eq("with a key it goes to Resend", await sendEmail({ RESEND_API_KEY: "re_test" }, email, resend), true);
  eq("from no-reply@ovoa.ai", calls[0]?.body.from, "OVOA <no-reply@ovoa.ai>");
  eq("replies to support", calls[0]?.body.reply_to, "support@ovoa.ai");
  eq("to them", calls[0]?.body.to, ["a@example.com"]);
  eq("with the key", calls[0]?.auth, "Bearer re_test");
  eq("at Resend's address", calls[0]?.url, "https://api.resend.com/emails");
  await sendEmail({ RESEND_API_KEY: "re_test", EMAIL_FROM: "OVOA <hi@ovoa.ai>", RESEND_API_BASE: "http://x" }, email, resend);
  eq("EMAIL_FROM and the test base are honoured", [calls[1]?.body.from, calls[1]?.url], ["OVOA <hi@ovoa.ai>", "http://x/emails"]);
  eq(
    "Resend saying no is false, not a throw",
    await sendEmail({ RESEND_API_KEY: "re_test" }, email, async () => new Response("nope", { status: 422 })),
    false,
  );
  eq(
    "nor is Resend being unreachable",
    await sendEmail({ RESEND_API_KEY: "re_test" }, email, async () => {
      throw new Error("offline");
    }),
    false,
  );
}

// ---------- Delivering a code: Resend, or a local worker's log ----------

{
  const sent: string[] = [];
  const resend = async (url: string) => {
    sent.push(url);
    return new Response("{}", { status: 200 });
  };
  const email = codeEmail({ to: "e@example.com", code: "271828", name: null, existing: true, confirm: true });
  const logged: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  const withKey = await deliverCode({ RESEND_API_KEY: "re_test", DEBUG_KEY: "localtest" }, email, "271828", resend);
  const local = await deliverCode({ DEBUG_KEY: "localtest" }, email, "271828", resend);
  const neither = await deliverCode({}, email, "271828", resend);
  console.log = log;
  eq("with a Resend key it's sent, debug key or not", withKey, "sent");
  eq("once", sent.length, 1);
  eq("no key but a debug key (a local worker): logged, not sent", local, "logged");
  eq("the log line has the code", logged.some((l) => l.includes("271828")), true);
  eq("and not the address", logged.some((l) => l.includes("e@example.com")), false);
  eq("neither: it failed, and nothing was logged", [neither, logged.length], ["failed", 1]);
  eq("codes can go out with a key", codesAvailable({ RESEND_API_KEY: "re_test" }), true);
  eq("or a debug key", codesAvailable({ DEBUG_KEY: "x" }), true);
  eq("but not with neither", codesAvailable({}), false);
}

// ---------- Google ----------

{
  const now = 1_000_000_000_000;
  const aud = ["app-client", "site-client"];
  const good = {
    aud: "site-client",
    iss: "https://accounts.google.com",
    exp: String(now / 1000 + 600),
    email: "Ada@Example.com",
    email_verified: "true",
    name: "Ada Lovelace",
  };
  eq("a good token is who it says", googleIdentityFrom(good, aud, now), { email: "ada@example.com", name: "Ada Lovelace" });
  eq("the short issuer counts too", googleIdentityFrom({ ...good, iss: "accounts.google.com" }, aud, now) !== null, true);
  eq("another app's token doesn't", googleIdentityFrom({ ...good, aud: "someone-else" }, aud, now), null);
  eq("nor another issuer's", googleIdentityFrom({ ...good, iss: "https://evil.example" }, aud, now), null);
  eq("nor an expired one", googleIdentityFrom({ ...good, exp: String(now / 1000 - 1) }, aud, now), null);
  eq("nor an unverified address", googleIdentityFrom({ ...good, email_verified: "false" }, aud, now), null);
  eq("nor no address", googleIdentityFrom({ ...good, email: undefined }, aud, now), null);
  eq("no name is fine", googleIdentityFrom({ ...good, name: "" }, aud, now), { email: "ada@example.com", name: null });

  eq("the app's client and the listed ones count", googleAudiences({ GOOGLE_CLIENT_ID: "a", GOOGLE_SIGNIN_CLIENT_IDS: " b, ,c" }), [
    "a",
    "b",
    "c",
  ]);
  const env = { GOOGLE_CLIENT_ID: "app-client", GOOGLE_SIGNIN_CLIENT_IDS: "site-client" };
  let asked = "";
  const google = async (url: string) => {
    asked = url;
    return Response.json(good);
  };
  eq("checked with Google", await verifyGoogleIdToken(env, "tok.en/x", google, now), { email: "ada@example.com", name: "Ada Lovelace" });
  eq("at tokeninfo, the token escaped", asked, "https://oauth2.googleapis.com/tokeninfo?id_token=tok.en%2Fx");
  eq("Google saying no is null", await verifyGoogleIdToken(env, "x", async () => new Response("{}", { status: 400 }), now), null);
}

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
