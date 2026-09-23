// 14-day retention (retention.ts, docs/retention.md): every table classified,
// the streak carried past its deleted events, and the purge itself run against
// the real schema. The SQL runs for real, on Node's own SQLite with every
// migration applied, behind a small stand-in for D1's calls, so a rule that
// names a wrong column or deletes a kept row fails here and not on the first
// night in production.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { contextAssistant } from "../src/context";
import { keptDaySummary, summaryInput, writeDaySummary } from "../src/daysummary";
import { purgeExpired, RETAIN_DAYS, RULES, STEPS, TABLES } from "../src/retention";
import { dayOutcomes, foldStreak, STREAK_SETTLED_DAYS, streak, streakFrom } from "../src/routines";
import { addDays, atLocalTime, buckets } from "../src/time";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

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
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
// D1 enforces foreign keys; the cascades are part of what's being tested.
sqlite.exec("PRAGMA foreign_keys = ON");
const DB = d1(sqlite);
const env = { DB, MEMORY_MODEL: "test" } as unknown as Env;

// ---------- Every table has a rule ----------

const tables = (
  sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'context_search_%'`,
    )
    .all() as { name: string }[]
).map((t) => t.name);
const classified = TABLES as Record<string, string>;
const ruled = new Set([...RULES.map((r) => r.table), ...Object.keys(STEPS)]);
eq("every table in migrations/ is classified", tables.filter((t) => !(t in classified)).join(", "), "");
eq("and nothing classified is missing from them", Object.keys(classified).filter((t) => !tables.includes(t)).join(", "), "");
eq(
  "everything not kept has a rule",
  Object.entries(classified)
    .filter(([t, how]) => how !== "keep" && how !== "index" && !ruled.has(t))
    .map(([t]) => t)
    .join(", "),
  "",
);
eq("nothing kept has one", RULES.filter((r) => classified[r.table] === "keep").map((r) => r.name).join(", "), "");
eq("rule names are unique", new Set(RULES.map((r) => r.name)).size, RULES.length);
eq("streaks settle on the purge's own window", STREAK_SETTLED_DAYS, RETAIN_DAYS);

// ---------- The streak outlives its events ----------

{
  const tz = "America/New_York";
  const today = "2026-10-20";
  const events = (days: [number, string][]) =>
    days.map(([ago, status]) => ({ due_at: atLocalTime(addDays(today, -ago), 9 * 60, tz), status }));
  const twenty = events(Array.from({ length: 20 }, (_, i) => [i + 1, "done"] as [number, string]));
  const all = dayOutcomes(twenty, tz);
  eq("twenty days done, counted from the events", streakFrom(all, today), 20);
  // Folded through 14 days ago, then everything older than that deleted.
  const carry = foldStreak({ streak: 0, day: null }, all, addDays(today, -14));
  eq("the fold carries the old days", carry, { streak: 7, day: addDays(today, -14) });
  const kept = dayOutcomes(twenty.filter((e) => e.due_at >= atLocalTime(addDays(today, -14), 0, tz)), tz);
  eq("the same streak with the old events gone", streakFrom(kept, today, carry), 20);
  eq("folding again changes nothing", foldStreak(carry, all, addDays(today, -14)), carry);
  eq("without the carry it would stop at the purge", streakFrom(dayOutcomes(twenty.filter((e) => e.due_at >= atLocalTime(addDays(today, -13), 0, tz)), tz), today), 13);

  const broken = dayOutcomes(events([[1, "done"], [2, "done"], [3, "missed"], [4, "done"]]), tz);
  eq("a miss ends it", streakFrom(broken, today), 2);
  eq("a miss in the folded days starts the carry again", foldStreak({ streak: 9, day: addDays(today, -5) }, broken, addDays(today, -2)), {
    streak: 1,
    day: addDays(today, -2),
  });
  eq("a miss after the carry still ends it", streakFrom(broken, today, { streak: 30, day: addDays(today, -10) }), 2);
  const gap = dayOutcomes(events([[1, "done"], [5, "done"]]), tz);
  eq("days with nothing due don't break it, up to the carry", streakFrom(gap, today, { streak: 4, day: addDays(today, -8) }), 6);
  eq("nothing since the carry: the carry stands", streakFrom(new Map(), today, { streak: 4, day: addDays(today, -14) }), 4);
  eq("today counts once it's all done", streakFrom(dayOutcomes(events([[0, "done"], [1, "done"]]), tz), today), 2);
}

// ---------- The purge, on the real schema ----------

const now = Date.now();
const DAY = 86_400_000;
const OLD = now - 20 * DAY;
const NEW = now - 2 * DAY;
const U = "u1";
const TZ = "America/New_York";
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...(args as never[]));
const count = (sql: string, ...args: unknown[]) => Number((sqlite.prepare(sql).get(...(args as never[])) as { n: number }).n);
const has = (table: string, id: string, key = "id") => count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${key} = ?`, id) === 1;

run("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, 'u1@example.com', '', '', 'Sam', ?)", U, OLD);
run("INSERT INTO settings (user_id, time_zone, updated_at) VALUES (?, ?, ?)", U, TZ, OLD);

// What was said and learned from it.
run("INSERT INTO messages (id, user_id, role, content, created_at) VALUES ('m_old', ?, 'user', 'hi', ?), ('m_new', ?, 'user', 'hi', ?)", U, OLD, U, NEW);
run(
  `INSERT INTO memories (id, user_id, content, source, created_at) VALUES
     ('mem_asked', ?, 'Is vegan.', 'asked', ?), ('mem_learned_old', ?, 'Likes jazz.', 'learned', ?), ('mem_learned_new', ?, 'Has a dog.', 'learned', ?)`,
  U, OLD, U, OLD, U, NEW,
);
const block = (id: string, at: number, source: string, category: string | null, title: string, pinned = 0) =>
  run(
    "INSERT INTO context_blocks (id, user_id, started_at, ended_at, source, title, summary, category, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, 'x', ?, ?, ?)",
    id, U, at, at, source, title, category, pinned, at,
  );
block("b_recorded", OLD, "voice", "work", "violin lesson");
block("b_note", OLD, "chat", null, "typed note");
block("b_transcript", OLD, "voice", "transcript", "zebra crossing");
block("b_pinned", OLD, "voice", "transcript", "pinned stretch", 1);
block("b_promise", OLD, "voice", "transcript", "plumber call");
block("b_calendar", OLD, "calendar", null, "dentist");
block("b_transcript_new", NEW, "voice", "transcript", "recent stretch");
const promise = (id: string, blockId: string, status: string, created: number, due: number | null, settled: number | null = null) =>
  run(
    "INSERT INTO context_commitments (id, user_id, block_id, text, status, created_at, due_at, settled_at) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)",
    id, U, blockId, status, created, due, settled,
  );
promise("c_future", "b_promise", "open", OLD, now + 5 * DAY);
promise("c_recent_due", "b_promise", "open", OLD, now - 3 * DAY);
promise("c_settled_recently", "b_promise", "done", OLD, null, NEW);
promise("c_long_past_due", "b_recorded", "open", OLD, OLD);
promise("c_undated_old", "b_recorded", "open", OLD, null);
promise("c_done_old", "b_recorded", "done", OLD, null, OLD);
const job = (id: string, source: string, status: string, about: string | null, next: number) =>
  run(
    "INSERT INTO agent_jobs (id, user_id, title, instruction, kind, next_run_at, status, source, about, created_at) VALUES (?, ?, 't', 'i', 'once', ?, ?, ?, ?, ?)",
    id, U, next, status, source, about, OLD,
  );
job("j_nudge_gone", "agent", "active", "c_done_old", now + DAY);
job("j_nudge_kept", "agent", "active", "c_future", now + 4 * DAY);
job("j_user", "user", "active", null, now + DAY);
job("j_done_old", "user", "done", null, now - 10 * DAY);
job("j_done_recent", "user", "done", null, now - 2 * DAY);
run("INSERT INTO context_rollups (user_id, grain, bucket, title, summary, updated_at) VALUES (?, 'day', 'old', 't', 's', ?), (?, 'week', 'new', 't', 's', ?)", U, OLD, U, NEW);
run(
  "INSERT INTO raw_captures (id, user_id, ts, text, source) VALUES ('rc_recording', ?, ?, 'x', 'recording'), ('rc_mic_old', ?, ?, 'x', 'mic'), ('rc_mic_new', ?, ?, 'x', 'mic')",
  U, OLD, U, OLD, U, NEW,
);
run(
  `INSERT INTO transcript_titles (user_id, grain, bucket, start, title, updated_at, summarised_at) VALUES
     (?, 'day', 'd_old', ?, 'Summary', ?, ?), (?, '5m', 'b_old', ?, 't', ?, NULL), (?, 'hour', 'h_new', ?, 't', ?, NULL)`,
  U, OLD, OLD, OLD, U, OLD, OLD, U, NEW, NEW,
);
run(
  `INSERT INTO objects (id, user_id, name, location_text, lat, lng, ts) VALUES
     ('o_told', ?, 'passport', 'in the safe', NULL, NULL, ?), ('o_car_old', ?, 'car', 'parked', 1, 2, ?), ('o_car_new', ?, 'car', 'parked', 1, 2, ?)`,
  U, OLD, U, OLD, U, NEW,
);
run("INSERT INTO name_candidates (user_id, name, count, last_heard_at) VALUES (?, 'Old', 1, ?), (?, 'New', 1, ?), (?, 'Unclocked', 1, NULL)", U, OLD, U, NEW, U);
const fact = (f: string, at: number, from: string) => ({ fact: f, at, from });
const person = (id: string, facts: object[], lastSeen: number, relation: string | null = null) =>
  run("INSERT INTO people (id, user_id, name, facts, relation, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, U, id, JSON.stringify(facts), relation, lastSeen, OLD);
person("p_said", [fact("heard old", OLD, "heard"), fact("told", OLD, "said")], OLD);
person("p_heard_old", [fact("heard old", OLD, "heard")], OLD);
person("p_heard_new", [fact("heard old", OLD, "heard"), fact("heard new", NEW, "heard")], NEW);
person("p_relation", [fact("heard old", OLD, "heard")], OLD, "brother");

// What OVOA built or found on its own.
run(
  "INSERT INTO todos (id, user_id, date, text, source, created_at) VALUES ('t_user', ?, 'd', 'x', 'user', ?), ('t_built_old', ?, 'd', 'x', 'note', ?), ('t_built_new', ?, 'd', 'x', 'carried', ?)",
  U, OLD, U, OLD, U, NEW,
);
run(
  `INSERT INTO notes (id, user_id, ts, text, tags, remind_at) VALUES
     ('n_user', ?, ?, 'wifi is on the fridge', '[]', NULL),
     ('n_bill_old', ?, ?, 'Pay Acme — due 2026-01-01', '["todo","bill"]', ?),
     ('n_bill_waiting', ?, ?, 'Pay Acme — due 2099-01-01', '["todo","bill"]', ?)`,
  U, OLD, U, OLD, OLD, U, OLD, now + 30 * DAY,
);
run(
  "INSERT INTO money_bills (id, user_id, name, next_due, source, created_at) VALUES ('bill_user', ?, 'Rent', '2099-01-01', 'user', ?), ('bill_mail', ?, 'Acme', '2099-01-01', 'mail', ?)",
  U, OLD, U, OLD,
);
run("INSERT INTO agent_runs (id, user_id, trigger, started_at) VALUES ('r_old', ?, 'job', ?), ('r_new', ?, 'job', ?)", U, OLD, U, NEW);
run("INSERT INTO action_log (id, user_id, ts, kind, summary, source) VALUES ('a_old', ?, ?, 'x', 'x', 'chat'), ('a_new', ?, ?, 'x', 'x', 'chat')", U, OLD, U, NEW);
run(
  `INSERT INTO google_accounts (id, user_id, email, scopes, refresh_token_enc, connected_at) VALUES ('g1', ?, 'sam@example.com', '', '', ?)`,
  U, OLD,
);
run(
  "INSERT INTO account_profiles (account_id, user_id, learned_at) VALUES ('g1', ?, ?), ('g_gone', ?, ?), ('g1_stale', ?, ?)",
  U, NEW, U, NEW, U, OLD,
);

// Where they went, and their health.
run("INSERT INTO location_points (user_id, ts, lat, lng) VALUES (?, ?, 0, 0), (?, ?, 0, 0)", U, OLD, U, NEW);
const place = (id: string, name: string | null, kind: string) =>
  run("INSERT INTO places (id, user_id, name, kind, lat, lng, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)", id, U, name, kind, OLD);
place("pl_home", "Home", "home");
place("pl_named", "The gym", "other");
place("pl_unnamed_gone", null, "other");
place("pl_unnamed_visited", null, "other");
place("pl_unnamed_note", null, "other");
run(
  "INSERT INTO visits (id, user_id, lat, lng, arrived, left_at, place_id) VALUES ('v_old', ?, 0, 0, ?, ?, 'pl_unnamed_gone'), ('v_new', ?, 0, 0, ?, ?, 'pl_unnamed_visited')",
  U, OLD, OLD, U, NEW, NEW,
);
run("INSERT INTO place_events (id, user_id, place_id, kind, ts) VALUES ('pe_new_on_gone', ?, 'pl_unnamed_gone', 'enter', ?), ('pe_home', ?, 'pl_home', 'enter', ?)", U, NEW, U, NEW);
run(
  "INSERT INTO expectations (id, user_id, kind, place_id, what, window_start, window_end, days, strength, updated_at) VALUES ('e_gone', ?, 'visit', 'pl_unnamed_gone', 'x', 0, 1, '[]', 1, ?)",
  U, NEW,
);
run("INSERT INTO notes (id, user_id, ts, text, place_id) VALUES ('n_at_place', ?, ?, 'buy stamps', 'pl_unnamed_note')", U, OLD);
run("INSERT INTO hr_samples (user_id, ts, bpm, source) VALUES (?, ?, 60, 'health'), (?, ?, 60, 'health')", U, OLD, U, NEW);
run(
  "INSERT INTO step_days (user_id, day, steps, updated_at) VALUES (?, ?, 100, ?), (?, ?, 100, ?)",
  U, new Date(OLD).toISOString().slice(0, 10), OLD, U, new Date(NEW).toISOString().slice(0, 10), NEW,
);
run(
  "INSERT INTO workouts (id, user_id, start_at, end_at, kind, source, created_at) VALUES ('w_detected', ?, ?, ?, 'run', 'detected', ?), ('w_manual', ?, ?, ?, 'run', 'manual', ?)",
  U, OLD, OLD, OLD, U, OLD, OLD, OLD,
);
run("INSERT INTO food_log (id, user_id, day, ts, name, key, kcal, source, created_at) VALUES ('f_old', ?, 'd', ?, 'x', 'x', 1, 'model', ?), ('f_new', ?, 'd', ?, 'x', 'x', 1, 'model', ?)", U, OLD, OLD, U, NEW, NEW);
run("INSERT INTO food_catalog (user_id, key, name, kcal_100g, category, source, used_at) VALUES (?, 'old', 'x', 1, 'mixed', 'model', ?), (?, 'new', 'x', 1, 'mixed', 'model', ?)", U, OLD, U, NEW);

// A routine done every day for 20 days.
run("INSERT INTO routines (id, user_id, kind, title, times, created_at, updated_at) VALUES ('rt', ?, 'habit', 'Walk', '[540]', ?, ?)", U, OLD, OLD);
const today = buckets(now, TZ).day;
for (let i = 1; i <= 20; i++) {
  run(
    "INSERT INTO routine_events (id, routine_id, user_id, due_at, status, created_at) VALUES (?, 'rt', ?, ?, 'done', ?)",
    `ev${i}`, U, atLocalTime(addDays(today, -i), 9 * 60, TZ), OLD,
  );
}

// Counts and the server's own records.
run("INSERT INTO daily_marks (user_id, kind, day, at) VALUES (?, 'cap', 'm20', ?), (?, 'cap', 'm40', ?)", U, now - 20 * DAY, U, now - 40 * DAY);
run(
  "INSERT INTO usage_daily (user_id, day, kind, last_at) VALUES (?, ?, 'turn', 0), (?, ?, 'turn', 0)",
  U, new Date(now - 20 * DAY).toISOString().slice(0, 10), U, new Date(now - 40 * DAY).toISOString().slice(0, 10),
);
run(
  "INSERT INTO device_logs (device_id, session_id, time, kind, text, received_at) VALUES ('d', 's', 0, 'x', 'week old', ?), ('d', 's', 0, 'x', 'fresh', ?)",
  now - 8 * DAY, NEW,
);
run("INSERT INTO error_events (fingerprint, kind, route, message, first_seen, last_seen) VALUES ('e_old', 'error', '/', 'x', ?, ?), ('e_new', 'error', '/', 'x', ?, ?)", OLD, OLD, NEW, NEW);
run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('s_gone', ?, ?, ?), ('s_live', ?, ?, ?)", U, OLD, now - 1, U, OLD, now + DAY);
run("INSERT INTO email_codes (email, code_hash, expires_at, sent_at, window_start) VALUES ('a@example.com', 'h', ?, ?, ?)", OLD, OLD, OLD);

const streakBefore = await streak(DB, "rt", TZ);
const searchFor = (word: string) =>
  (sqlite.prepare("SELECT b.id FROM context_search s JOIN context_blocks b ON b.rowid = s.rowid WHERE context_search MATCH ?").all(word) as { id: string }[]).map(
    (r) => r.id,
  );
eq("before: the transcript block is searchable", searchFor("zebra").join(), "b_transcript");

const done = await purgeExpired(env, now);
eq("nothing failed", done.failed ?? 0, 0);

// The timeline and its promises.
eq("a block the user recorded stays", has("context_blocks", "b_recorded"), true);
eq("a note typed on the Day screen stays", has("context_blocks", "b_note"), true);
eq("a block the transcript titler filed goes", has("context_blocks", "b_transcript"), false);
eq("a pinned one stays", has("context_blocks", "b_pinned"), true);
eq("one a kept promise hangs off stays", has("context_blocks", "b_promise"), true);
eq("a signal block goes", has("context_blocks", "b_calendar"), false);
eq("a recent one stays", has("context_blocks", "b_transcript_new"), true);
eq("the search index lets go of the deleted block", searchFor("zebra").join(), "");
eq("and still finds the kept one", searchFor("violin").join(), "b_recorded");
sqlite.exec("INSERT INTO context_search(context_search) VALUES ('integrity-check')");
eq("the search index is consistent", true, true);
eq("an open promise still to come stays", has("context_commitments", "c_future"), true);
eq("one due three days ago stays", has("context_commitments", "c_recent_due"), true);
eq("one settled two days ago stays", has("context_commitments", "c_settled_recently"), true);
eq("one 20 days past its date goes", has("context_commitments", "c_long_past_due"), false);
eq("an undated one heard 20 days ago goes", has("context_commitments", "c_undated_old"), false);
eq("one settled 20 days ago goes", has("context_commitments", "c_done_old"), false);
eq("the nudge for a gone promise goes", has("agent_jobs", "j_nudge_gone"), false);
eq("the nudge for a kept one stays", has("agent_jobs", "j_nudge_kept"), true);
eq("a job the user set up stays", has("agent_jobs", "j_user"), true);
eq("a finished one goes after a week", has("agent_jobs", "j_done_old"), false);
eq("but not before", has("agent_jobs", "j_done_recent"), true);
eq("cached titles go", count("SELECT COUNT(*) AS n FROM context_rollups WHERE bucket = 'old'"), 0);
eq("recent cached titles stay", count("SELECT COUNT(*) AS n FROM context_rollups WHERE bucket = 'new'"), 1);

// Words, memories, people.
eq("a recording's words stay", has("raw_captures", "rc_recording"), true);
eq("other old lines go", has("raw_captures", "rc_mic_old"), false);
eq("new lines stay", has("raw_captures", "rc_mic_new"), true);
eq("the day's summary stays", count("SELECT COUNT(*) AS n FROM transcript_titles WHERE bucket = 'd_old'"), 1);
eq("old five-minute titles go", count("SELECT COUNT(*) AS n FROM transcript_titles WHERE bucket = 'b_old'"), 0);
eq("new hour titles stay", count("SELECT COUNT(*) AS n FROM transcript_titles WHERE bucket = 'h_new'"), 1);
eq("old messages go", has("messages", "m_old"), false);
eq("new ones stay", has("messages", "m_new"), true);
eq("a memory they asked for stays", has("memories", "mem_asked"), true);
eq("an old learned one goes", has("memories", "mem_learned_old"), false);
eq("a new learned one stays", has("memories", "mem_learned_new"), true);
eq("where they said the passport is stays", has("objects", "o_told"), true);
eq("where the car was parked 20 days ago goes", has("objects", "o_car_old"), false);
eq("where it's parked now stays", has("objects", "o_car_new"), true);
eq("a name not heard for 20 days goes", count("SELECT COUNT(*) AS n FROM name_candidates WHERE name = 'Old'"), 0);
eq("one heard lately stays", count("SELECT COUNT(*) AS n FROM name_candidates WHERE name = 'New'"), 1);
eq("one with no clock gets one, and stays", count("SELECT COUNT(*) AS n FROM name_candidates WHERE name = 'Unclocked' AND last_heard_at = ?", now), 1);
const factsOf = (id: string) =>
  (JSON.parse((sqlite.prepare("SELECT facts FROM people WHERE id = ?").get(id) as { facts: string }).facts) as { fact: string }[]).map((f) => f.fact).join("|");
eq("what they said about someone stays, what was only heard goes", factsOf("p_said"), "told");
eq("someone only heard about, long ago, goes", has("people", "p_heard_old"), false);
eq("someone heard about lately stays, with the new fact", factsOf("p_heard_new"), "heard new");
eq("a relation keeps the person", factsOf("p_relation"), "");

// Built, found, and theirs.
eq("a to-do they added stays", has("todos", "t_user"), true);
eq("an old built one goes", has("todos", "t_built_old"), false);
eq("a new built one stays", has("todos", "t_built_new"), true);
eq("a note they made stays", has("notes", "n_user"), true);
eq("an old bill reminder found in mail goes", has("notes", "n_bill_old"), false);
eq("one whose reminder hasn't come yet stays", has("notes", "n_bill_waiting"), true);
eq("a bill they told OVOA stays", has("money_bills", "bill_user"), true);
eq("one found in mail 20 days ago goes", has("money_bills", "bill_mail"), false);
eq("old agent runs go", has("agent_runs", "r_old"), false);
eq("new ones stay", has("agent_runs", "r_new"), true);
eq("the old action log goes", has("action_log", "a_old"), false);
eq("the new one stays", has("action_log", "a_new"), true);
eq("a connected account's profile stays", has("account_profiles", "g1", "account_id"), true);
eq("a disconnected account's goes", has("account_profiles", "g_gone", "account_id"), false);
eq("a stale one goes", has("account_profiles", "g1_stale", "account_id"), false);

// Places and health.
eq("old location points go", count("SELECT COUNT(*) AS n FROM location_points WHERE ts = ?", OLD), 0);
eq("new ones stay", count("SELECT COUNT(*) AS n FROM location_points WHERE ts = ?", NEW), 1);
eq("old visits go", has("visits", "v_old"), false);
eq("Home stays", has("places", "pl_home"), true);
eq("a place they named stays", has("places", "pl_named"), true);
eq("an unnamed place nobody went to for 14 days goes", has("places", "pl_unnamed_gone"), false);
eq("and its place events and expectations with it", has("place_events", "pe_new_on_gone") || has("expectations", "e_gone"), false);
eq("an unnamed one visited lately stays", has("places", "pl_unnamed_visited"), true);
eq("one a note is waiting at stays", has("places", "pl_unnamed_note"), true);
eq("old heart rate goes", count("SELECT COUNT(*) AS n FROM hr_samples WHERE ts = ?", OLD), 0);
eq("new heart rate stays", count("SELECT COUNT(*) AS n FROM hr_samples WHERE ts = ?", NEW), 1);
eq("old step days go, new stay", count("SELECT COUNT(*) AS n FROM step_days"), 1);
eq("a detected workout goes", has("workouts", "w_detected"), false);
eq("one they logged stays", has("workouts", "w_manual"), true);
eq("old food goes", has("food_log", "f_old"), false);
eq("new food stays", has("food_log", "f_new"), true);
eq("the catalog keeps what's in use", count("SELECT COUNT(*) AS n FROM food_catalog").toString() + count("SELECT COUNT(*) AS n FROM food_catalog WHERE key = 'new'"), "11");

// The streak.
eq(
  "routine events older than 14 days go",
  count("SELECT COUNT(*) AS n FROM routine_events WHERE routine_id = 'rt'"),
  Array.from({ length: 20 }, (_, i) => atLocalTime(addDays(today, -(i + 1)), 9 * 60, TZ)).filter((t) => t >= now - RETAIN_DAYS * DAY).length,
);
eq("the routine carries what they held", count("SELECT streak AS n FROM routines WHERE id = 'rt'") > 0, true);
eq("and the streak is what it was", await streak(DB, "rt", TZ), streakBefore);
eq("which is all twenty days", streakBefore, 20);

// Counts and records.
eq("a mark from 20 days ago stays (35 days)", count("SELECT COUNT(*) AS n FROM daily_marks WHERE day = 'm20'"), 1);
eq("one from 40 days ago goes", count("SELECT COUNT(*) AS n FROM daily_marks WHERE day = 'm40'"), 0);
eq("usage from 20 days ago stays, from 40 goes", count("SELECT COUNT(*) AS n FROM usage_daily"), 1);
eq("the phone's log keeps 7 days", (sqlite.prepare("SELECT group_concat(text) AS t FROM device_logs").get() as { t: string }).t, "fresh");
eq("old errors go", has("error_events", "e_old", "fingerprint"), false);
eq("new ones stay", has("error_events", "e_new", "fingerprint"), true);
eq("an expired session goes", has("sessions", "s_gone", "token_hash"), false);
eq("a live one stays", has("sessions", "s_live", "token_hash"), true);
eq("an expired email code goes", count("SELECT COUNT(*) AS n FROM email_codes"), 0);
eq("the account and settings stay", count("SELECT COUNT(*) AS n FROM users") + count("SELECT COUNT(*) AS n FROM settings"), 2);

const again = await purgeExpired(env, now);
eq("a second run deletes nothing more", Object.keys(again).filter((k) => k !== "routines.settled").join(), "");

// ---------- The day summary, and reading it back ----------

eq("nothing to summarise, no model", summaryInput("2026-10-01", TZ, { said: [], blocks: [], titled: null, rollup: null }), null);
const input = summaryInput("2026-10-01", TZ, {
  said: [{ created_at: atLocalTime("2026-10-01", 9 * 60, TZ), content: "remind me to call  the vet" }],
  blocks: [{ started_at: atLocalTime("2026-10-01", 10 * 60, TZ), title: "Vet call", summary: "Booked the dog in." }],
  titled: null,
  rollup: null,
});
eq("the day's input names the weekday", input?.startsWith("Thursday 2026-10-01"), true);
eq("with the timeline and what they said", !!input?.includes('10:00 AM Vet call: Booked the dog in.') && !!input?.includes('"remind me to call the vet"'), true);

{
  // Food and nothing else: written without a model, with the day's number for someone who tracks.
  const day = addDays(today, -3);
  const at = atLocalTime(day, 12 * 60, TZ);
  run("INSERT INTO profile (user_id, food_detail, updated_at) VALUES (?, 'normal', ?)", U, now);
  run(
    "INSERT INTO food_log (id, user_id, day, ts, name, key, kcal, protein_g, source, created_at) VALUES ('f_day', ?, ?, ?, 'Burrito', 'burrito', 900, 40, 'model', ?)",
    U, day, at, at,
  );
  eq("a food-only day is written", await writeDaySummary(env, U, day, TZ, now), "written");
  const kept = await keptDaySummary(DB, U, day);
  eq("with the day's total", kept?.summary, "Ate 900 kcal and 40 g protein: Burrito.");
  eq("an empty day isn't", await writeDaySummary(env, U, addDays(today, -4), TZ, now), "empty");

  // Past 14 days the timeline answers from the summary.
  const timeline = contextAssistant(env, U, TZ, true);
  const answer = (await timeline.callTool("context_day", { date: day })) as { title?: string; summary?: string; blocks?: unknown[] };
  eq("context_day falls back to the summary", [answer.title, answer.summary, answer.blocks?.length].join("|"), "Food noted|Ate 900 kcal and 40 g protein: Burrito.|0");
  const nothing = (await timeline.callTool("context_day", { date: addDays(today, -4) })) as { nothing?: string };
  eq("and says so when there's nothing", !!nothing.nothing, true);
  // A day with a block left (a recording) uses the summary as its title: no model call.
  block("b_on_summary_day", at, "voice", "work", "kept recording");
  const withBlock = (await timeline.callTool("context_day", { date: day })) as { title?: string; blocks?: unknown[] };
  eq("a kept block's day is titled by its summary", [withBlock.title, withBlock.blocks?.length].join("|"), "Food noted|1");
}

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
