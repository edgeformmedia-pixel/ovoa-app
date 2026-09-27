// Games for two (together.ts + sites.ts kind 'game'), plans followed up
// (lifeplans.ts) and budgets whose purchases wait for a YES (budget.ts), on the
// real schema over Node's own SQLite, with a fake GLM that streams a page.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bookingAdvice, lifePlansAssistant, plansTick, usefulQuestion } from "../src/lifeplans";
import { budgetAssistant, budgetContext, fits, linkProblem, periodStart } from "../src/budget";
import { namesFor, relationIn, resolvePartner, togetherAssistant, togetherTick } from "../src/together";
import { cleanGameHtml, forgetWildcard, GAME_POLICY, gamePolicy, gamePrompt, sitesTick } from "../src/sites";
import { networkTick } from "../src/network";
import { FORBIDDEN_FOR_COMMANDS } from "../src/commands";
import { READ_ALONE, WRITE_ON_ACT } from "../src/agent";
import { TABLES } from "../src/retention";
import { addDays, buckets } from "../src/time";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- Pure ----------

eq("my girlfriend", relationIn("me and my girlfriend"), "girlfriend");
eq("my gf is a girlfriend", relationIn("my gf"), "girlfriend");
eq("a name is no relation", relationIn("Maria"), null);
eq("names from memories", namesFor("girlfriend", ["Thomas's girlfriend is Maria", "Maria is my girlfriend", "He went to the store"]), ["Maria"]);
eq("my girlfriend Ana", namesFor("girlfriend", ["Going to dinner with my girlfriend Ana on Friday"]), ["Ana"]);

{
  const html = cleanGameHtml(
    `<!doctype html><html><head><script src="https://evil.example/x.js"></script><link rel="stylesheet" href="https://evil.example/a.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body><form action="https://evil.example"><button>Go</button></form><iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">x</a><input type="password" name="pw"><script>let score = 0;</script></body></html>`,
  );
  eq("a game keeps its inline script", html.includes("<script>let score = 0;</script>"), true);
  eq("but no external one", html.includes("evil.example/x.js"), false);
  eq("nor a style sheet from elsewhere", html.includes("a.css"), false);
  eq("Google Fonts stay", html.includes("fonts.googleapis.com"), true);
  eq("no redirect, form, frame, script link or password", /http-equiv|<form|<iframe|javascript:|type="password"/i.test(html), false);
  eq("the button stays", html.includes("<button>Go</button>"), true);
}
eq("the game policy is a sandbox", GAME_POLICY.startsWith("sandbox allow-scripts "), true);
eq("a game can reach its own room and nothing else", gamePolicy("wss://t.ovoa.ai/g/room").includes("connect-src wss://t.ovoa.ai/g/room;") && !gamePolicy("x").includes("connect-src 'none'"), true);
eq("the game maker knows the shared server is there, not required", /ovoaRoom/.test(gamePrompt("https://x/")) && /Use it only when the game calls for it/.test(gamePrompt("https://x/")), true);
eq("with no same-origin", GAME_POLICY.includes("allow-same-origin"), false);
eq("and no network", GAME_POLICY.includes("connect-src 'none'") && GAME_POLICY.includes("form-action 'none'"), true);
eq("the game maker is told there's no network or storage", /No network at all/.test(gamePrompt("https://x/")) && /localStorage/.test(gamePrompt("https://x/")), true);

eq("a trip 50 days out", bookingAdvice("trip", "2026-11-15", "2026-09-26"), {
  daysAway: 50,
  advice:
    "Flights are often cheapest around 3 weeks to 3 months out, so now through the next few weeks is a good window; prices tend to climb inside 3 weeks.",
  remindOn: "2026-10-11",
  followupOn: "2026-11-10",
});
eq("a trip 10 days out: book now", bookingAdvice("trip", "2026-10-06", "2026-09-26").remindOn, null);
eq("far out: remind 90 days before", bookingAdvice("trip", "2027-03-01", "2026-09-26").remindOn, "2026-12-01");
eq("a check-in isn't useful", usefulQuestion("Any updates on your trip?"), false);
eq("an offer is", usefulQuestion("Want me to find a dinner spot near Union Square for Friday night?"), true);

eq("under the cap and the budget", fits({ amount_cents: 50000, per_purchase_cents: 30000 }, 10000, 25000), { ok: true, left: 15000 });
eq("over one purchase's cap", fits({ amount_cents: 50000, per_purchase_cents: 20000 }, 0, 25000), { ok: false, why: "over the $200 limit for one purchase" });
eq("over what's left", fits({ amount_cents: 50000, per_purchase_cents: null }, 40000, 25000), { ok: false, why: "only $100 left in the budget" });
eq("a link must be https", linkProblem("http://hotel.example.com/"), "not https");
eq("a good link", linkProblem("https://www.booking.com/hotel/x"), null);
{
  const NY = "America/New_York";
  const now = Date.parse("2026-09-26T16:00:00Z"); // a Saturday
  eq("a month starts on the 1st", new Date(periodStart("month", now, NY, 0)).toISOString(), "2026-09-01T04:00:00.000Z");
  eq("a week on Monday", new Date(periodStart("week", now, NY, 0)).toISOString(), "2026-09-21T04:00:00.000Z");
}

// ---------- The rules around them ----------

for (const t of ["game_make", "budget_set", "purchase_propose", "purchase_confirm"]) {
  eq(`${t}: never for the agent's commands`, FORBIDDEN_FOR_COMMANDS.has(t), true);
  eq(`${t}: never for a background run`, READ_ALONE.has(t) || WRITE_ON_ACT.has(t), false);
}
for (const t of ["life_plans", "spend_budgets", "purchases", "ovoa_suggestions"]) eq(`${t} is classified for retention`, t in TABLES, true);

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

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
sqlite.exec("PRAGMA foreign_keys = ON");
const DB = d1(sqlite);
const sql = (q: string, ...args: unknown[]) => sqlite.prepare(q).run(...(args as never[]));
const one = <T>(q: string, ...args: unknown[]) => sqlite.prepare(q).get(...(args as never[])) as T | undefined;
const count = (q: string, ...args: unknown[]) => Number((one<{ n: number }>(q, ...args) ?? { n: 0 }).n);

const NY = "America/New_York";
const T = "user-thomas";
const M = "user-maria";
const J = "user-jake";
for (const [id, email, name, username] of [
  [T, "t@example.com", "Thomas Lancheros", "thomas"],
  [M, "m@example.com", "Maria Diaz", "maria"],
  [J, "j@example.com", "Jake Park", "jake"],
]) {
  sql("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, username) VALUES (?, ?, '', '', ?, ?, ?)", id, email, name, Date.now(), username);
  sql("INSERT INTO settings (user_id, assistant_name, time_zone, updated_at) VALUES (?, 'OVOA', ?, ?)", id, NY, Date.now());
}
const connect = (a: string, b: string) => {
  const id = crypto.randomUUID();
  sql("INSERT INTO connections (id, requester_id, addressee_id, status, created_at, decided_at) VALUES (?, ?, ?, 'accepted', ?, ?)", id, a, b, Date.now(), Date.now());
  for (const u of [a, b]) sql("INSERT INTO connection_perms (connection_id, user_id, updated_at) VALUES (?, ?, ?)", id, u, Date.now());
};
connect(T, M);
connect(T, J);
sql("INSERT INTO memories (id, user_id, content, created_at) VALUES ('m1', ?, 'Thomas''s girlfriend is Maria; they love movie nights', ?)", T, Date.now());

// A model that streams a page, as GLM does: GLM_API_KEY makes GLM the only engine.
let modelSays = "";
let modelSystem = "";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://glm.test/")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    modelSystem = JSON.stringify(body.messages?.[0] ?? "");
    const pieces = modelSays.match(/[\s\S]{1,400}/g) ?? [];
    const sse = [
      ...pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 4000 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  if (url.startsWith("https://cloudflare-dns.com/")) return new Response(JSON.stringify({ Status: 3 }), { headers: { "content-type": "application/dns-json" } });
  throw new Error(`unexpected fetch in a test: ${url}`);
}) as typeof fetch;

const env = {
  DB,
  SITES_DOMAIN: "ovoa.ai",
  PUBLIC_URL: "https://api.ovoa.ai",
  CHAT_MODEL: "gemini-3.5-flash-lite",
  MEMORY_MODEL: "gemini-3.5-flash-lite",
  GLM_API_KEY: "test",
  GLM_BASE_URL: "https://glm.test/v4",
  GLM_MODEL: "glm-5.3-flash",
  TOKEN_ENC_KEY: "k",
} as unknown as Env;

async function main() {
  forgetWildcard();

  // ---------- Who "my girlfriend" is ----------
  eq("my girlfriend is Maria, from memory and the connection", await resolvePartner(DB, T, "my girlfriend"), {
    name: "Maria",
    username: "maria",
    how: "their girlfriend, from what you remember, and connected on OVOA",
  });
  eq("@jake", await resolvePartner(DB, T, "@jake"), { name: "Jake", username: "jake", how: "their connection" });
  eq("a name that isn't on OVOA", await resolvePartner(DB, T, "Sofia"), { name: "Sofia", username: null, how: "not connected on OVOA" });
  const unknown = await resolvePartner(DB, J, "my wife");
  eq("a relation nobody named: ask, don't guess", "ask" in unknown && unknown.ask.includes("Thomas (@thomas)"), true);

  // ---------- A game, built, handed to her OVOA ----------
  const games = togetherAssistant(env, T);
  const made = (await games.callTool("game_make", { with: "my girlfriend", idea: "A movie night quiz about each other", name: "Movie Night Showdown" })) as Record<string, unknown>;
  eq("it's being made", made.making, true);
  eq("for Maria", made.for, "Maria");
  eq("under his username, as a game", one<{ slug: string; kind: string; share_to: string }>("SELECT slug, kind, share_to FROM sites WHERE user_id = ?", T), {
    slug: "thomas/game-maria",
    kind: "game",
    share_to: "maria",
  });
  modelSays = `<!doctype html><html><head><title>Movie Night Showdown</title></head><body><h1>Thomas vs Maria</h1><button id="go">Start</button><script>let turn = 0;</script><script src="https://evil.example/x.js"></script></body></html>`;
  eq("the lane builds it", await sitesTick(env), { built: 1, failed: 0 });
  eq("with the game maker's instructions", modelSystem.includes("OVOA's game maker"), true);
  const kept = one<{ html: string; status: string; shared_at: number | null }>("SELECT html, status, shared_at FROM sites WHERE user_id = ?", T)!;
  eq("live, with its script and not the external one", kept.status === "live" && kept.html.includes("let turn = 0;") && !kept.html.includes("evil.example"), true);
  eq("shared once", kept.shared_at !== null, true);
  eq("a share is queued to Maria's OVOA with the link", count("SELECT COUNT(*) AS n FROM ovoa_messages WHERE from_user = ? AND to_user = ? AND kind = 'share' AND body LIKE '%thomas/game-maria%'", T, M), 1);
  eq("Thomas is told, with the link", count("SELECT COUNT(*) AS n FROM agent_notes WHERE user_id = ? AND body LIKE '%game for you and Maria is ready%' AND body LIKE '%sent it to Maria''s OVOA%'", T), 1);
  await networkTick(env);
  eq("and Maria's OVOA tells her", count("SELECT COUNT(*) AS n FROM agent_notes WHERE user_id = ? AND body LIKE '%make a game for the two of you%'", M), 1);

  const solo = (await games.callTool("game_make", { with: "Sofia", idea: "tic tac toe" })) as Record<string, unknown>;
  eq("someone not on OVOA: the link is to forward", String(solo.note).includes("forward it to Sofia") || String(solo.note).includes("forward to Sofia"), true);
  const mine = (await games.callTool("game_make", { idea: "Connect 4 against the computer", name: "Connect 4" })) as Record<string, unknown>;
  eq("a game just for them needs no second player", mine.making, true);
  eq("kept with no one to share it with", one<{ slug: string; share_for: string | null }>("SELECT slug, share_for FROM sites WHERE user_id = ? AND name = 'Connect 4'", T), { slug: "thomas/connect-4", share_for: null });

  // ---------- The occasional offer ----------
  sql("INSERT INTO text_links (user_id, phone, linked_at, proactive) VALUES (?, '+15550000001', ?, 1)", T, Date.now());
  sql("INSERT INTO people (id, user_id, name, relation, created_at) VALUES ('p1', ?, 'Maria', 'girlfriend', ?)", T, Date.now());
  const evening = Date.parse(`${buckets(Date.now(), NY).day}T22:30:00Z`); // 6:30 pm in New York
  const offered = await togetherTick(env, undefined, evening);
  eq("offered once in the evening", offered.offered, 1);
  eq("and not again this month", (await togetherTick(env, undefined, evening + 60_000)).offered, 0);

  // ---------- Plans ----------
  const plans = lifePlansAssistant(env, T, NY);
  const today = buckets(Date.now(), NY).day;
  const start = addDays(today, 40);
  const added = (await plans.callTool("plan_add", {
    title: "SF trip",
    kind: "trip",
    place: "San Francisco",
    startsOn: start,
    followupQuestion: "Want me to find a dinner spot near Union Square for your first night?",
  })) as Record<string, unknown>;
  eq("kept, with when to book", added.saved === "SF trip" && added.remindToBookOn === addDays(start, -35), true);
  eq("and the follow-up day", String(added.followUp).startsWith(`On ${addDays(start, -5)}`), true);
  const generic = (await plans.callTool("plan_add", { title: "Austin", kind: "trip", startsOn: addDays(today, 60), followupQuestion: "Any updates?" })) as Record<string, unknown>;
  eq("a generic follow-up isn't kept", generic.followUp, "none");
  // The day comes: asked once (no Sendblue here, so it's a notification).
  sql("UPDATE life_plans SET followup_on = ? WHERE title = 'SF trip'", today);
  const noon = Date.parse(`${today}T16:00:00Z`);
  eq("asked on its day", await plansTick(env, undefined, noon), { asked: 1 });
  eq("once", await plansTick(env, undefined, noon + 60_000), { asked: 0 });

  // ---------- Budgets ----------
  const before = Date.now();
  const b1 = budgetAssistant(env, T, NY, before);
  eq("a budget", String(((await b1.callTool("budget_set", { category: "travel", amount: 500, period: "month", perPurchaseMax: 300 })) as Record<string, unknown>).set), "travel: $500 a month, at most $300 a purchase");
  const tooMuch = (await b1.callTool("purchase_propose", { what: "Hotel, 3 nights", price: 420, url: "https://hotel.example.com/book", category: "travel" })) as Record<string, unknown>;
  eq("over the per-purchase cap is refused", String(tooMuch.error).includes("$300 limit"), true);
  const prop = (await b1.callTool("purchase_propose", { what: "Hotel Zephyr, 2 nights", price: 280, url: "https://hotel.example.com/book", merchant: "Hotel Zephyr", category: "travel" })) as Record<string, unknown>;
  eq("prepared, asking for a YES", prop.ask, "Book this for $280? Reply YES");
  const id = String(prop.prepared);
  eq("not confirmable in the same turn", String(((await b1.callTool("purchase_confirm", { id, decision: "yes" })) as Record<string, unknown>).error).includes("only just prepared"), true);
  eq("the next turn knows it waits", (await budgetContext(env, T)).carry, ["purchase_confirm"]);
  const b2 = budgetAssistant(env, T, NY, Date.now() + 1);
  const yes = (await b2.callTool("purchase_confirm", { id, decision: "yes" })) as Record<string, unknown>;
  eq("their YES records it and gives the link", yes.link, "https://hotel.example.com/book");
  eq("counted", count("SELECT COUNT(*) AS n FROM purchases WHERE id = ? AND status = 'approved'", id), 1);
  eq("and says what's left", String(yes.note).includes("$220"), true);
  eq("twice is refused", String(((await b2.callTool("purchase_confirm", { id, decision: "yes" })) as Record<string, unknown>).error).includes("already approved"), true);
  const status = (await b2.callTool("budget_status", {})) as { budgets: { left: string }[] };
  eq("what's left", status.budgets[0].left, "$220");
  const b3 = budgetAssistant(env, T, NY, Date.now() + 1);
  const over = (await b3.callTool("purchase_propose", { what: "Flight", price: 250, url: "https://air.example.com/x", category: "travel" })) as Record<string, unknown>;
  eq("past what's left is refused", String(over.error).includes("only $220 left"), true);

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
