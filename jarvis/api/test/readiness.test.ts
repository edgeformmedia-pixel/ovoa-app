// The morning's readiness line (extras.ts) against the real schema: which
// night it calls "last night".
//
// device_state.sleep_hours is kept until a new value comes, and its updated_at
// moves with the phone's five-minute heartbeat, so "the phone reported today"
// let the night before last be read out as last night (review, 2026-09-23).
// A phone that syncs Health days is taken at its word, today's row or nothing.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readiness } from "../src/extras";
import { addDays, buckets, dayRange } from "../src/time";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
const statement = (sql: string, args: unknown[] = []) => ({
  bind: (...next: unknown[]) => statement(sql, next),
  first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
  all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
  run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
});
const env = { DB: { prepare: (sql: string) => statement(sql) } } as unknown as Env;

const NY = "America/New_York";
const H = 3_600_000;
const u = "u1";
const today = buckets(Date.now(), NY).day;
const [midnight] = dayRange(today, NY);
sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(u, "a@b.c", "x", "x", "T", Date.now());

/** The phone's device report: sleep_hours as capabilities.ts keeps it, and when the row last moved. */
function reported(sleepHours: number, at: number) {
  sqlite
    .prepare("INSERT INTO device_state (user_id, band_linked, updated_at, sleep_hours) VALUES (?, 1, ?, ?) ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at, sleep_hours = excluded.sleep_hours")
    .run(u, at, sleepHours);
}
function synced(day: string, sleep: { asleepMin: number; inBedMin?: number } | null) {
  sqlite
    .prepare("INSERT OR REPLACE INTO health_days (user_id, day, sleep_json, updated_at) VALUES (?, ?, ?, ?)")
    .run(u, day, sleep && JSON.stringify({ ...sleep, start: midnight - 7 * H, end: midnight + H, source: "Apple Watch" }), Date.now());
}

(async () => {
  eq("nothing known: no line", await readiness(env, u, NY), null);

  // A phone that has never synced a day (build 67, or no AI consent): the device report alone.
  reported(8.2, midnight - H);
  eq("a device report from before midnight isn't last night", await readiness(env, u, NY), null);
  reported(8.2, midnight + 5 * 60_000);
  eq("one since midnight is", await readiness(env, u, NY), "You're well set for a hard day: 8.2 hours of sleep.");

  // The phone syncs Health days: the device report's 8.2 (a heartbeat at
  // 00:05 moved its updated_at) is never used again.
  synced(addDays(today, -1), { asleepMin: 492 });
  eq("yesterday's row but not today's (locked since): no sleep line", await readiness(env, u, NY), null);
  synced(today, null);
  eq("today's row with no night (Watch not worn): no sleep line", await readiness(env, u, NY), null);
  synced(today, { asleepMin: 0, inBedMin: 420 });
  eq("time in bed alone isn't sleep: no sleep line", await readiness(env, u, NY), null);
  synced(today, { asleepMin: 334, inBedMin: 420 });
  eq("today's night, asleep not in bed", await readiness(env, u, NY), "Take it easier today: 5.6 hours of sleep.");

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
