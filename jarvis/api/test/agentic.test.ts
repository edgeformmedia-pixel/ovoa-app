// More agentic (2026-09-29): group polls and bill splits over OVOA to OVOA
// (network.ts ovoa_group), what OVOA remembers shown and edited by text
// (memorytools.ts), the heads-up sweep seeded for anyone with Google
// (agent.ts seedHeadsUp / backfillSystemJobs), and a watch that ends itself
// (agent_finish_job). On the real schema over Node's own SQLite.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { backfillSystemJobs, HEADS_UP, seedSystemJobs } from "../src/agent";
import { isMemoryTool, memoryAssistant } from "../src/memorytools";
import { isNetworkTool, networkAssistant, networkTick, payLink, setCalendar, shares, tally } from "../src/network";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

const NY = "America/New_York";

// ---------- Pure parts ----------

eq("a tally by what each answer names", tally(["Sushi", "Tacos", "Pizza"], ["sushi please", "Tacos!", "def sushi", null]).winner, "Sushi");
eq("counts, most first", tally(["Sushi", "Tacos"], ["sushi", "tacos", "sushi"]).counts, [
  { option: "Sushi", votes: 2 },
  { option: "Tacos", votes: 1 },
]);
eq("a tie has no winner", tally(["Fri", "Sat"], ["fri", "sat"]).winner, null);
eq("a long word of an option counts", tally(["Nopa on Divisadero", "Zuni Cafe"], ["nopa!"]).winner, "Nopa on Divisadero");
eq("nobody answered, no winner", tally(["A", "B"], [null, null]).winner, null);
eq("shares add up to the bill", shares(10_000, 3), [3334, 3333, 3333]);
eq("an even bill splits evenly", shares(9_000, 3), [3000, 3000, 3000]);
eq("nobody to split with", shares(1_000, 0), []);
eq("a Venmo link", payLink("@thomas-l", 3334, "dinner at Nopa"), "https://venmo.com/thomas-l?txn=pay&amount=33.34&note=dinner%20at%20Nopa");
eq("a Cash App link", payLink("$thomasl", 1250, "x"), "https://cash.app/$thomasl/12.50");
eq("no link for anything else", payLink("thomas@example.com", 100, "x"), null);
eq("the tools are known", isNetworkTool("ovoa_group") && ["memory_list", "memory_forget", "memory_edit"].every(isMemoryTool), true);

// ---------- A D1 over node:sqlite, with every migration ----------

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
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.exec("PRAGMA foreign_keys = ON");
const DB = d1(sqlite);
const sql = (q: string, ...args: unknown[]) => sqlite.prepare(q).run(...(args as never[]));
const one = <T>(q: string, ...args: unknown[]) => sqlite.prepare(q).get(...(args as never[])) as T | undefined;
const all = <T>(q: string, ...args: unknown[]) => sqlite.prepare(q).all(...(args as never[])) as T[];

const T = "user-thomas";
const M = "user-maria";
const J = "user-jake";
for (const [id, email, name, username] of [
  [T, "thomas@example.com", "Thomas Lancheros", "thomas"],
  [M, "maria@example.com", "Maria Diaz", "maria"],
  [J, "jake@example.com", "Jake Park", "jake"],
]) {
  sql("INSERT INTO users (id, email, password_hash, password_salt, name, username, created_at) VALUES (?, ?, '', '', ?, ?, ?)", id, email, name, username, Date.now());
  sql("INSERT INTO settings (user_id, assistant_name, time_zone, updated_at) VALUES (?, 'OVOA', ?, ?)", id, NY, Date.now());
}
setCalendar({ busy: async () => [], book: async () => true, events: async () => [] });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`unexpected fetch in a test: ${String(input)}`);
}) as typeof fetch;

const env = { DB, SITES_DOMAIN: "ovoa.ai", PUBLIC_URL: "https://api.ovoa.ai", TOKEN_ENC_KEY: "k" } as unknown as Env;
const notesOf = (userId: string) => all<{ title: string; body: string }>("SELECT title, body FROM agent_notes WHERE user_id = ? ORDER BY created_at, rowid", userId);
const lastNote = (userId: string) => notesOf(userId).at(-1);

async function main() {
  const as = (who: { callTool: (n: string, a: Record<string, unknown>) => Promise<unknown> }) => (name: string, args: Record<string, unknown> = {}) =>
    who.callTool(name, args) as Promise<Record<string, unknown>>;
  const t = as(networkAssistant(env, T, NY));
  const m = as(networkAssistant(env, M, NY));
  const j = as(networkAssistant(env, J, NY));

  await t("ovoa_connect", { username: "maria" });
  await m("ovoa_connect_answer", { username: "thomas", answer: "yes" });
  await t("ovoa_connect", { username: "jake" });
  await j("ovoa_connect_answer", { username: "thomas", answer: "yes" });

  // ---------- A poll ----------
  eq("a poll needs a question", String((await t("ovoa_group", { kind: "poll", usernames: ["maria"] })).error), "question is needed.");
  const poll = await t("ovoa_group", { kind: "poll", usernames: ["maria", "@jake", "nobody"], question: "Dinner Friday, where?", options: ["Sushi", "Tacos"] });
  eq("asked the two connected", (poll.asked as string[]).length, 2);
  eq("the stranger is named, not asked", String((poll.couldNotAsk as string[])[0]).startsWith("@nobody"), true);
  eq("one group, two threads", one<{ n: number }>("SELECT COUNT(*) AS n FROM ovoa_threads WHERE group_id IS NOT NULL")?.n, 2);
  await networkTick(env);
  const qm = one<{ id: string; summary: string }>("SELECT id, summary FROM ovoa_approvals WHERE user_id = ? AND status = 'pending'", M)!;
  eq("she's asked, with the options", qm.summary.includes("Dinner Friday, where? (Sushi / Tacos)"), true);
  await m("ovoa_approve", { id: qm.id, decision: "yes", text: "sushi for sure" });
  await networkTick(env);
  const before = notesOf(T).length;
  eq("one answer in: nothing told yet", notesOf(T).filter((n) => n.title === "Group answers").length, 0);
  const qj = one<{ id: string }>("SELECT id FROM ovoa_approvals WHERE user_id = ? AND status = 'pending'", J)!;
  await j("ovoa_approve", { id: qj.id, decision: "yes", text: "Sushi works" });
  await networkTick(env);
  const told = lastNote(T)!;
  eq("both in: one tally", told.title, "Group answers");
  eq("with the winner and an offer to book", told.body.startsWith('"Dinner Friday, where?" Sushi 2, Tacos 0. Sushi wins. Want me to book it?'), true);
  eq("and each answer", told.body.includes('Maria (@maria): "sushi for sure"'), true);
  eq("told once", notesOf(T).length, before + 1);
  eq("the group is done", one<{ status: string }>("SELECT status FROM ovoa_groups")?.status, "told");

  // A poll nobody answers is told when the day is up.
  await t("ovoa_group", { kind: "poll", usernames: ["maria"], question: "Movie Sunday?", options: ["Yes", "No"] });
  sql("UPDATE ovoa_groups SET closes_at = 0 WHERE status = 'open'");
  await networkTick(env);
  eq("lapsed: told what came in", lastNote(T)?.body.includes("1 didn't answer."), true);
  eq("and its thread is closed", one<{ n: number }>("SELECT COUNT(*) AS n FROM ovoa_threads WHERE status = 'open' AND group_id IS NOT NULL")?.n, 0);

  // ---------- A bill split ----------
  sql("UPDATE connection_perms SET take_reminders = 1");
  const split = await t("ovoa_group", { kind: "split", usernames: ["maria", "jake"], total: 120, what: "dinner at Nopa", others: ["Sam"], payTo: "@thomas-l" });
  eq("four people, $30 each", [split.people, split.theirOwnShare], [4, "$30.00"]);
  eq("sent to both OVOAs", (split.sentTo as string[]).length, 2);
  eq("Sam's line to forward, with the link", (split.forwardThese as { text: string }[])[0].text, "Your share of dinner at Nopa: $30.00. Pay here: https://venmo.com/thomas-l?txn=pay&amount=30.00&note=dinner%20at%20Nopa");
  await networkTick(env);
  eq("Maria is told her share", lastNote(M)?.body.includes("Your share of dinner at Nopa with Thomas: $30.00."), true);
  eq("a bad total", String((await t("ovoa_group", { kind: "split", usernames: ["maria"], total: -5 })).error).startsWith("total"), true);

  // ---------- What OVOA remembers ----------
  const mem = as(memoryAssistant(env, T));
  eq("nothing yet", (await mem("memory_list")).memories, 0);
  await mem("memory_edit", { text: "Thomas's girlfriend is Maria." });
  sql("INSERT INTO memories (id, user_id, content, created_at) VALUES ('m2', ?, 'Thomas lives in Miami.', ?)", T, Date.now() + 1);
  sql("INSERT INTO memories (id, user_id, content, created_at) VALUES ('m3', ?, 'Thomas is vegan.', ?)", T, Date.now() + 2);
  eq("numbered, oldest first", (await mem("memory_list")).memories, ["1. Thomas's girlfriend is Maria.", "2. Thomas lives in Miami.", "3. Thomas is vegan."]);
  eq("an added one is kept as asked", one<{ source: string }>("SELECT source FROM memories WHERE content LIKE '%girlfriend%'")?.source, "asked");
  eq("fixed by number", (await mem("memory_edit", { number: 2, text: "Thomas lives in Austin." })).changed, { from: "Thomas lives in Miami.", to: "Thomas lives in Austin." });
  eq("and kept as asked from then on", one<{ source: string }>("SELECT source FROM memories WHERE id = 'm2'")?.source, "asked");
  eq("forgotten by number", (await mem("memory_forget", { numbers: [3] })).forgot, ["Thomas is vegan."]);
  eq("a number that isn't there", String((await mem("memory_forget", { numbers: [9] })).error).startsWith("numbers"), true);
  eq("Maria's aren't his to see", (await as(memoryAssistant(env, M))("memory_list")).memories, 0);

  // ---------- The heads-up sweep ----------
  sql("UPDATE settings SET agent_enabled = 1, agent_autonomy = 'suggest'");
  eq("no Google, no sweep", await backfillSystemJobs(env), 0);
  sql(
    "INSERT INTO google_accounts (id, user_id, email, is_default, scopes, refresh_token_enc, connected_at) VALUES ('g1', ?, 'thomas@gmail.com', 1, '', 'x', ?)",
    T,
    Date.now(),
  );
  eq("Google connected: seeded for him", await backfillSystemJobs(env), 1);
  eq("once", await backfillSystemJobs(env), 0);
  eq("as a daily system job at 8:30, speaking only when useful", one("SELECT kind, at_minutes, notify, source FROM agent_jobs WHERE user_id = ? AND title = ?", T, HEADS_UP), {
    kind: "daily",
    at_minutes: 510,
    notify: "ifuseful",
    source: "system",
  });
  await seedSystemJobs(env, T);
  eq("turning the agent on still seeds the others alongside it", all<{ title: string }>("SELECT title FROM agent_jobs WHERE user_id = ? AND source = 'system' ORDER BY title", T).length, 3);
  await seedSystemJobs(env, T);
  eq("and never twice", all("SELECT 1 FROM agent_jobs WHERE user_id = ? AND source = 'system'", T).length, 3);
}

main()
  .catch((err) => {
    fails++;
    console.error(err);
  })
  .finally(() => {
    setCalendar(null);
    globalThis.fetch = realFetch;
    console.log(fails ? `\n${fails} FAILED` : "\nall passed");
    process.exit(fails ? 1 : 0);
  });
