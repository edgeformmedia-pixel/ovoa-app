import { pruneEmailAuth } from "./emailauth";
import { pruneSignin } from "./signin";
import { validTimeZone } from "./google/assistant";
import { KEEP_MS as DEVICE_LOG_KEEP_MS } from "./logs";
import { recordError } from "./obs";
import { settleStreak } from "./routines";
import { sweepStaleSetup } from "./setup/turn";
import type { Env } from "./types";

// Retention (the v1 release, 2026-09-23). docs/retention.md is the table, in
// words; this is the same table, enforced.
//
// After 14 days everything is deleted except two things: each day's summary
// (daysummary.ts, written just before this runs) and what the person entered or
// set up themselves. Where one table holds both kinds, the rows are told apart
// by a source column or by how the row gets made: a memory they asked OVOA to
// keep vs one it learned, a place they named vs one it guessed, a to-do they
// added vs one it built, the car it parked vs the passport they said is in the
// safe. Two tables hold counts rather than content and are kept 35 days,
// because a month's cap and a pay cycle's warnings have to outlive their
// period. The phone's own log keeps its 7 days, and finished one-off agent jobs
// their week.
//
// Once a night, in the 04:13 cron (index.ts runTick), after the day summaries.
// Every table is deleted in chunks (DELETE ... WHERE rowid IN (SELECT ... LIMIT
// n)) until a chunk comes back short, so the first night on a lot of old rows
// can't run into D1's limits, and each rule is caught on its own: one failing
// table is written down (obs.ts error_events) and the rest still run.
//
// Order matters in three places. Promises go before the timeline blocks they
// hang off (a block with a promise still being kept stays with it, and a
// block's delete would otherwise take its promises with it), and orphaned
// nudges go after the promises. Routine streaks are brought forward before
// their events go (routines.ts settleStreak), and a routine whose streak
// couldn't be keeps its events for another night. Visits go before the
// unnamed places that no visit points at any more.
//
// The full-text index on the timeline (context_search) follows context_blocks
// on its own: the delete trigger in migrations/0010_context.sql hands FTS5 its
// 'delete' command with the old values for every row removed here.

/** Everything that isn't kept is deleted this long after it happened. */
export const RETAIN_DAYS = 14;
/** Counts, not content: usage_daily (a month's cap reads from the 1st) and daily_marks (month and pay-cycle marks). */
export const COUNTS_RETAIN_DAYS = 35;
/** Finished one-off agent jobs, as before. */
const DONE_JOB_DAYS = 7;
const DAY_MS = 86_400_000;
/** Rows per DELETE. Small enough for D1's per-query limits with a trigger firing per row. */
const CHUNK = 500;
/** Past this the rest waits for tomorrow night; the rules furthest down go last. */
const BUDGET_MS = 6 * 60_000;

export type Cutoffs = {
  now: number;
  /** RETAIN_DAYS ago, in ms. */
  cutoff: number;
  /** The UTC date of `cutoff`, for tables keyed by a date. */
  cutoffDay: string;
  /** COUNTS_RETAIN_DAYS ago. */
  counts: number;
  countsDay: string;
};

export function cutoffsAt(now: number): Cutoffs {
  const cutoff = now - RETAIN_DAYS * DAY_MS;
  const counts = now - COUNTS_RETAIN_DAYS * DAY_MS;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { now, cutoff, cutoffDay: day(cutoff), counts, countsDay: day(counts) };
}

export type Rule = {
  /** For the log and the cron's record: table, and which rows when a table has more than one rule. */
  name: string;
  table: string;
  /** Which rows go. */
  where: string;
  args: (c: Cutoffs) => unknown[];
  /** The columns that name a row, for a table WITHOUT ROWID (rowid otherwise). */
  key?: string[];
  chunk?: number;
};

const at = (column: string, table: string, name = table): Rule => ({ name, table, where: `${column} < ?`, args: (c) => [c.cutoff] });

/** Every delete, in the order it runs. The people trim, the streaks and the name clocks are steps of their own (purgeExpired). */
export const RULES: Rule[] = [
  // ---- What was said and what was learned from it ----
  // Promises: 14 days after they were settled, or 14 days past their date, or
  // (with no date) 14 days after they were heard. Never an open one still to come.
  {
    name: "context_commitments",
    table: "context_commitments",
    where: `(status != 'open' AND COALESCE(settled_at, created_at) < ?)
         OR (status = 'open' AND due_at IS NOT NULL AND due_at < ?)
         OR (status = 'open' AND due_at IS NULL AND created_at < ?)`,
    args: (c) => [c.cutoff, c.cutoff, c.cutoff],
  },
  // The nudges scheduled to chase a promise that's gone (agent.ts scheduleNudges).
  {
    name: "agent_jobs.orphaned",
    table: "agent_jobs",
    where: "about IS NOT NULL AND source = 'agent' AND NOT EXISTS (SELECT 1 FROM context_commitments c WHERE c.id = agent_jobs.about)",
    args: () => [],
  },
  // Timeline blocks the transcript titler filed (transcripts.ts fileInTimeline),
  // and any signal block. A block the user made through POST /context/blocks (a
  // recording, a note on the Day screen) stays, and so does a pinned one, and
  // one a kept promise still hangs off.
  {
    name: "context_blocks",
    table: "context_blocks",
    where: `started_at < ? AND pinned = 0 AND (category = 'transcript' OR source IN ('calendar', 'location', 'health'))
        AND NOT EXISTS (SELECT 1 FROM context_commitments c WHERE c.block_id = context_blocks.id)`,
    args: (c) => [c.cutoff],
    chunk: 200,
  },
  // Cached hour, day and week titles. The day's summary lives in transcript_titles.
  at("updated_at", "context_rollups"),
  // Every line but a recording's: those are the words of something recorded on purpose.
  { name: "raw_captures", table: "raw_captures", where: "ts < ? AND source != 'recording'", args: (c) => [c.cutoff] },
  // Five-minute and hour titles. The day row is the day's summary.
  { name: "transcript_titles", table: "transcript_titles", where: "start < ? AND grain != 'day'", args: (c) => [c.cutoff] },
  at("created_at", "messages"),
  // Learned in the background; 'asked' ones were theirs to keep.
  { name: "memories", table: "memories", where: "source != 'asked' AND created_at < ?", args: (c) => [c.cutoff] },
  // The car, parked automatically (location.ts noticeParking). object_save rows (lat NULL) are what they told OVOA.
  { name: "objects", table: "objects", where: "lat IS NOT NULL AND ts < ?", args: (c) => [c.cutoff] },
  at("last_heard_at", "name_candidates"),

  // ---- What OVOA built or found on its own ----
  // Built lists and copies; 'user' rows are the ones they added.
  { name: "todos", table: "todos", where: "source != 'user' AND created_at < ?", args: (c) => [c.cutoff] },
  // Bill reminders found in mail (extras.ts, source 'mail'), once any reminder
  // has had its day. Before they had their own source they were 'typed', like
  // a note the user asked for, so those older ones are known by extras' exact
  // wording ("Pay Acme (£20) — due 2026-10-01"), not by any note about paying.
  {
    name: "notes.bills",
    table: "notes",
    where: `(source = 'mail' OR (source = 'typed' AND tags LIKE '%"bill"%' AND text LIKE 'Pay % — due ____-__-__'))
        AND ts < ? AND (remind_at IS NULL OR remind_at < ?)`,
    args: (c) => [c.cutoff, c.cutoff],
  },
  // Bills found in mail (money.ts recordBillFromMail), 14 days past the last
  // due date their mail gave: one that's still coming, or that mail brings
  // every month, stays. The ones they told OVOA are 'user'.
  {
    name: "money_bills.mail",
    table: "money_bills",
    where: "source = 'mail' AND created_at < ? AND COALESCE(found_due, next_due) < ?",
    args: (c) => [c.cutoff, c.cutoffDay],
  },
  at("started_at", "agent_runs"),
  at("created_at", "agent_notes"),
  { name: "agent_budget", table: "agent_budget", where: "day < ?", args: (c) => [c.cutoffDay] },
  {
    name: "agent_jobs.done",
    table: "agent_jobs",
    where: "status = 'done' AND next_run_at < ?",
    args: (c) => [c.now - DONE_JOB_DAYS * DAY_MS],
  },
  at("created_at", "pending_actions"),
  at("created_at", "paused_turns"),
  at("created_at", "command_queue"),
  at("ts", "action_log"),
  at("created_at", "shortcuts"),
  // What each Google account is for, relearned nightly while it's connected.
  {
    name: "account_profiles",
    table: "account_profiles",
    where: "COALESCE(learned_at, 0) < ? OR NOT EXISTS (SELECT 1 FROM google_accounts g WHERE g.id = account_profiles.account_id)",
    args: (c) => [c.cutoff],
  },

  // ---- Where they went, and their health ----
  at("ts", "location_points"),
  at("left_at", "visits"),
  at("ts", "place_events"),
  // A place nobody named (Home and Work are named when they're learned) that
  // nobody has been to for 14 days, and no open note is waiting at. Its place
  // events and expectations go with it (ON DELETE CASCADE); visits and workouts
  // keep their row without it (SET NULL).
  {
    name: "places.unnamed",
    table: "places",
    where: `name IS NULL AND kind = 'other' AND created_at < ?
        AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.place_id = places.id AND v.left_at >= ?)
        AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.place_id = places.id AND n.done = 0)`,
    args: (c) => [c.cutoff, c.cutoff],
  },
  at("updated_at", "expectations"),
  at("checked_at", "commute_checks"),
  at("ts", "hr_samples"),
  // Local dates; the UTC date of the cutoff is within a day of them either way.
  { name: "step_days", table: "step_days", where: "day < ?", args: (c) => [c.cutoffDay] },
  // Apple Health's day numbers (healthdays.ts), kept only for accounts that agreed to AI.
  { name: "health_days", table: "health_days", where: "day < ?", args: (c) => [c.cutoffDay] },
  // Found in heart rate, or recorded by a watch (healthdays.ts). The ones they logged by voice are 'manual'.
  { name: "workouts.detected", table: "workouts", where: "source IN ('detected', 'health') AND start_at < ?", args: (c) => [c.cutoff] },
  at("created_at", "safety_events"),
  // After routines.ts settleStreak has folded them into each routine's streak.
  at("due_at", "routine_events"),
  at("ts", "food_log"),
  // "The same meal costs the same" holds inside the window it's used in.
  at("used_at", "food_catalog"),

  // ---- Counts, and the server's own records ----
  { name: "daily_marks", table: "daily_marks", where: "at < ?", args: (c) => [c.counts] },
  {
    name: "usage_daily",
    table: "usage_daily",
    where: "day < ?",
    args: (c) => [c.countsDay],
    key: ["user_id", "day", "kind", "engine", "model"],
  },
  { name: "device_logs", table: "device_logs", where: "received_at < ?", args: (c) => [c.now - DEVICE_LOG_KEEP_MS] },
  at("last_seen", "error_events"),
  at("last_at", "engine_stats"),
  at("last_at", "cron_ticks"),

  // ---- Things with their own expiry ----
  { name: "sessions", table: "sessions", where: "expires_at < ?", args: (c) => [c.now] },
  { name: "oauth_states", table: "oauth_states", where: "expires_at < ?", args: (c) => [c.now] },
  // The confirmation email's one-tap links (verify.ts): a day, used or not.
  { name: "verify_links", table: "verify_links", where: "expires_at < ?", args: (c) => [c.now] },
  // email_codes and signup_tickets: emailauth.ts pruneEmailAuth, a step of its own (purgeExpired);
  // signin_states and signin_codes: signin.ts pruneSignin, likewise.
];

/**
 * What the purge does with every table in migrations/, for docs/retention.md
 * and the test that fails when a new table isn't in it.
 *   keep     nothing is deleted
 *   delete   every row, RETAIN_DAYS after it happened (or its own window, above)
 *   mixed    the rows OVOA made on its own go; the ones the person made stay
 *   expires  rows that are useless once past their own expiry
 *   index    kept in step with its table by triggers
 */
export const TABLES = {
  users: "keep",
  sessions: "expires",
  settings: "keep",
  messages: "delete",
  memories: "mixed",
  step_days: "delete",
  health_days: "delete",
  emergency_contacts: "keep",
  safety_events: "delete",
  google_accounts: "keep",
  oauth_states: "expires",
  pending_actions: "delete",
  paused_turns: "delete",
  shortcuts: "delete",
  device_logs: "delete",
  context_blocks: "mixed",
  context_commitments: "mixed",
  context_rollups: "delete",
  context_search: "index",
  agent_jobs: "mixed",
  agent_goals: "keep",
  agent_runs: "delete",
  agent_notes: "delete",
  push_tokens: "keep",
  agent_budget: "delete",
  action_log: "delete",
  device_state: "keep",
  command_queue: "delete",
  routines: "keep",
  routine_events: "delete",
  profile: "keep",
  notes: "mixed",
  todos: "mixed",
  daily_marks: "delete",
  location_points: "delete",
  places: "mixed",
  visits: "delete",
  place_events: "delete",
  hr_samples: "delete",
  workouts: "mixed",
  raw_captures: "mixed",
  transcript_titles: "mixed",
  people: "mixed",
  objects: "mixed",
  name_candidates: "delete",
  expectations: "delete",
  commute_checks: "delete",
  account_profiles: "delete",
  alarms: "keep",
  money_settings: "keep",
  money_accounts: "keep",
  money_income: "keep",
  money_paychecks: "keep",
  money_bills: "mixed",
  money_spend: "keep",
  money_plans: "keep",
  error_events: "delete",
  engine_stats: "delete",
  cron_ticks: "delete",
  cron_lock: "keep",
  usage_daily: "delete",
  server_settings: "keep",
  user_apps: "keep",
  email_codes: "expires",
  verify_links: "expires",
  signup_tickets: "expires",
  signin_states: "expires",
  signin_codes: "expires",
  food_catalog: "delete",
  food_log: "delete",
} as const satisfies Record<string, "keep" | "delete" | "mixed" | "expires" | "index">;

/** Tables whose purge is a step of its own rather than a rule. */
export const STEPS: Record<string, string> = {
  people: "trimPeople",
  email_codes: "pruneEmailAuth",
  signup_tickets: "pruneEmailAuth",
  signin_states: "pruneSignin",
  signin_codes: "pruneSignin",
};

/** One rule, a chunk at a time, until a chunk comes back short or the night's time is up. */
async function deleteInChunks(db: D1Database, rule: Rule, c: Cutoffs, deadline: number) {
  const key = rule.key ?? ["rowid"];
  const n = rule.chunk ?? CHUNK;
  const row = key.length === 1 ? key[0] : `(${key.join(", ")})`;
  const sql = `DELETE FROM ${rule.table} WHERE ${row} IN (SELECT ${key.join(", ")} FROM ${rule.table} WHERE ${rule.where} LIMIT ${n})`;
  let total = 0;
  for (;;) {
    const { meta } = await db.prepare(sql).bind(...rule.args(c)).run();
    const changed = meta.changes ?? 0;
    total += changed;
    if (changed < n || Date.now() > deadline) return total;
  }
}

/**
 * People: facts that were only heard in a conversation go after 14 days; what
 * the user said about someone stays (people.ts rememberPerson, 'said'). A
 * person left with nothing they said, no relation, no birthday and no other
 * names, and not mentioned for 14 days, goes.
 */
async function trimPeople(db: D1Database, c: Cutoffs) {
  const heardOld = "json_extract(f.value, '$.from') = 'heard' AND COALESCE(json_extract(f.value, '$.at'), 0) < ?";
  const trimmed = await db
    .prepare(
      `UPDATE people SET facts = (
         SELECT COALESCE(json_group_array(json(f.value)), '[]') FROM json_each(people.facts) f WHERE NOT (${heardOld})
       )
       WHERE CASE WHEN json_valid(facts) THEN EXISTS (SELECT 1 FROM json_each(people.facts) f WHERE ${heardOld}) ELSE 0 END`,
    )
    .bind(c.cutoff, c.cutoff)
    .run();
  const gone = await deleteInChunks(
    db,
    {
      name: "people",
      table: "people",
      where: `relation IS NULL AND birthday IS NULL AND (aliases IS NULL OR aliases = '[]') AND COALESCE(last_seen, created_at) < ?
          AND CASE WHEN json_valid(facts)
                   THEN NOT EXISTS (SELECT 1 FROM json_each(people.facts) f WHERE COALESCE(json_extract(f.value, '$.from'), '') != 'heard')
                   ELSE 0 END`,
      args: (x) => [x.cutoff],
    },
    c,
    Infinity,
  );
  return (trimmed.meta.changes ?? 0) + gone;
}

/** Names from before last_heard_at existed (or copied without it) start their 14 days now. */
async function startNameClocks(db: D1Database, c: Cutoffs) {
  const { meta } = await db.prepare("UPDATE name_candidates SET last_heard_at = ? WHERE last_heard_at IS NULL").bind(c.now).run();
  return meta.changes ?? 0;
}

/**
 * Every routine with events about to go has them folded into its streak first.
 * One that can't be (a D1 error on it) doesn't stop the rest: it's named in
 * `failed`, and its events wait for another night (purgeExpired).
 */
async function settleRoutines(db: D1Database, c: Cutoffs) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT e.routine_id, s.time_zone FROM routine_events e
         LEFT JOIN settings s ON s.user_id = e.user_id
        WHERE e.due_at < ?`,
    )
    .bind(c.cutoff)
    .all<{ routine_id: string; time_zone: string | null }>();
  let moved = 0;
  const failed: string[] = [];
  for (const r of results) {
    try {
      if (await settleStreak(db, r.routine_id, validTimeZone(r.time_zone), c.cutoff)) moved++;
    } catch (err) {
      failed.push(r.routine_id);
      console.error("ovoa.err retention: a routine's streak couldn't be brought forward", err);
    }
  }
  return { moved, failed };
}

/**
 * The nightly purge. Returns what it deleted per rule (and what it couldn't),
 * for the cron's record. `now` is for the tests; the cron runs it as of now.
 */
export async function purgeExpired(env: Env, now = Date.now(), budgetMs = BUDGET_MS) {
  const db = env.DB;
  const c = cutoffsAt(now);
  const deadline = Date.now() + budgetMs;
  const out: Record<string, number> = {};
  const step = async (name: string, work: () => Promise<number>) => {
    if (Date.now() > deadline) {
      out.unfinished = (out.unfinished ?? 0) + 1;
      return;
    }
    try {
      const n = await work();
      if (n) out[name] = (out[name] ?? 0) + n;
    } catch (err) {
      out.failed = (out.failed ?? 0) + 1;
      console.error(`ovoa.err retention: ${name} failed`, err);
      await recordError(env, {
        kind: "cron",
        route: `cron retention ${name}`,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }).catch(() => undefined);
    }
  };

  await step("name_candidates.clock", () => startNameClocks(db, c));
  // Routine events only go once folded into their streak: the routines that
  // couldn't be keep theirs tonight, and if the step itself failed, all do.
  const settle = { failed: null as string[] | null };
  await step("routines.settled", async () => {
    const { moved, failed } = await settleRoutines(db, c);
    settle.failed = failed;
    if (failed.length) throw new Error(`${failed.length} routine streak(s) couldn't be brought forward; their events wait`);
    return moved;
  });
  for (const rule of RULES) {
    if (rule.name === "routine_events") {
      const failed = settle.failed;
      if (failed === null) continue;
      if (failed.length) {
        const kept = `${rule.where} AND routine_id NOT IN (${failed.map(() => "?").join(", ")})`;
        await step(rule.name, () => deleteInChunks(db, { ...rule, where: kept, args: (x) => [...rule.args(x), ...failed] }, c, deadline));
        continue;
      }
    }
    await step(rule.name, () => deleteInChunks(db, rule, c, deadline));
    // People with the rest of what was learned from conversations.
    if (rule.name === "name_candidates") await step("people", () => trimPeople(db, c));
  }
  // A setup conversation nobody came back to (setup/state.ts): it can hold an
  // emergency number and medication names. The profile row itself stays.
  await step("profile.setup_state", () => sweepStaleSetup(db, c.cutoff));
  // A handful of rows at most, each with its own expiry.
  await step("email_auth", async () => (await db.batch(pruneEmailAuth(db, c.now))).reduce((n, r) => n + (r.meta.changes ?? 0), 0));
  await step("signin", async () => (await db.batch(pruneSignin(db, c.now))).reduce((n, r) => n + (r.meta.changes ?? 0), 0));
  return out;
}
