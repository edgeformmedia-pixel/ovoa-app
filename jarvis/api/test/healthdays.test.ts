// A day of health (healthdays.ts): resting heart rate for one day, the band
// and a watch merged, the day's chart and raised minutes, what the phone sends
// from Apple Health (overwritten, workouts replaced, kept only with AI
// consent), the day views read back, and what health_summary tells the model.
//
// The numbers are the part the assistant says out loud with the phone locked,
// so a wrong one is heard, not just shown. The SQL runs on Node's own SQLite
// with every migration applied, as in retention.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AI_CONSENT_VERSION } from "../src/consent";
import { agoWords, dayHeart, durationWords, healthDays, healthSummaryFor, restingForDay, workoutName } from "../src/healthdays";
import { findSessions, oneSeries, type SourcedSample } from "../src/heart";
import { addDays, atLocalTime, buckets, clock } from "../src/time";
import type { Env, Vars } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

const M = 60_000;
const band = (ts: number, bpm: number): SourcedSample => ({ ts, bpm, source: "band" });
const watch = (ts: number, bpm: number): SourcedSample => ({ ts, bpm, source: "health" });

// ---------- The band and a watch ----------

const T0 = Date.UTC(2026, 8, 22, 12);
eq(
  "five minutes with one reading each: the watch's",
  oneSeries([band(T0, 80), watch(T0 + 2 * M, 90), band(T0 + 6 * M, 84)]),
  [watch(T0 + 2 * M, 90), band(T0 + 6 * M, 84)],
);
eq(
  "the band read more there: the band's, and the watch's one goes",
  oneSeries([band(T0, 80), band(T0 + M, 82), watch(T0 + 2 * M, 90), band(T0 + 3 * M, 84)]).map((s) => s.source),
  ["band", "band", "band"],
);
eq(
  "a watch workout, every 30 s: the watch's",
  oneSeries([...Array.from({ length: 5 }, (_, i) => band(T0 + i * M, 140)), ...Array.from({ length: 10 }, (_, i) => watch(T0 + i * 30_000, 142))]).map((s) => s.source),
  Array(10).fill("health"),
);
eq("with no watch, the band is the series", oneSeries([band(T0 + M, 70), band(T0, 71)]).map((s) => s.bpm), [71, 70]);

// Someone wearing both, not in a watch workout: the band every five minutes at
// rest and every minute once heart rate is up, the watch every seven minutes.
const sparse = (() => {
  const out: SourcedSample[] = [];
  const t = T0 + 30_000;
  for (let m = 0; m < 30; m += 5) out.push(band(t + m * M, 64));
  for (let m = 30; m < 70; m++) out.push(band(t + m * M, 140));
  for (let m = 70; m < 100; m += 5) out.push(band(t + m * M, 66));
  for (let m = 1; m < 100; m += 7) out.push(watch(t + m * M, m >= 30 && m < 70 ? 140 : 65));
  return out;
})();
eq(
  "a watch reading every seven minutes doesn't hide the band's 40 raised minutes",
  findSessions(oneSeries(sparse), 65, { now: T0 + 200 * M }).map((s) => Math.round((s.end - s.start) / M)),
  [39],
);
eq("and they're all counted as raised", dayHeart(sparse, "UTC", "2026-09-22", 60, T0 + 200 * M).raisedMin, 40);

// ---------- Resting, one day ----------

const NY = "America/New_York";
const DAY = "2026-09-22";
const at = (day: string, minutes: number, tz = NY) => atLocalTime(day, minutes, tz);
const nights = (day: string, n: number, bpm: (i: number) => number, tz = NY) =>
  Array.from({ length: n }, (_, i) => band(at(day, i * 5, tz), bpm(i)));
const days = (day: string, n: number, bpm: (i: number) => number, tz = NY) =>
  Array.from({ length: n }, (_, i) => band(at(day, 12 * 60 + i * 5, tz), bpm(i)));

eq("30 night readings: their median", restingForDay(nights(DAY, 30, (i) => (i % 2 ? 58 : 54)), NY, DAY, null), { bpm: 56, from: "band_night" });
eq(
  "10 at night and 40 by day: the lower fifth of all 50",
  restingForDay([...nights(DAY, 10, () => 50), ...days(DAY, 40, (i) => 70 + i)], NY, DAY, null),
  { bpm: 70, from: "band_low" },
);
eq("too few: nothing, not a made-up 65", restingForDay([...nights(DAY, 10, () => 50), ...days(DAY, 10, () => 70)], NY, DAY, null), null);
eq("Apple's own wins when a watch gave one", restingForDay(nights(DAY, 30, () => 60), NY, DAY, 52), { bpm: 52, from: "apple" });
eq("the night before is another day's", restingForDay(nights(addDays(DAY, -1), 30, () => 60), NY, DAY, null), null);

// ---------- A day's heart ----------

// Resting 60 from the night; then 70 at noon, 100 for twenty minutes, 70 again.
const U = "UTC";
const noon = at(DAY, 12 * 60, U);
const worked = [
  ...nights(DAY, 30, () => 60, U),
  band(noon, 70),
  ...Array.from({ length: 20 }, (_, i) => band(noon + (i + 1) * M, 100)),
  band(noon + 21 * M, 70),
];
const plain = dayHeart(worked, U, DAY, null, noon + 25 * M);
eq("resting from the night", [plain.restingBpm, plain.restingFrom], [60, "band_night"]);
eq("twenty minutes at resting + 25 or more", plain.raisedMin, 20);
eq("low, average and high", [plain.low, plain.high], [60, 100]);
eq("a point per five minutes", plain.points.length, 35);
eq("each the median of its five", plain.points[30], { ts: noon, bpm: 100 });
eq("an even five-minute takes the middle two", plain.points.at(-1)?.bpm, 85);
eq("the latest is the band's, four minutes ago", plain.latest, { ts: noon + 21 * M, bpm: 70, source: "band", agoMin: 4 });

const both = dayHeart([...worked, watch(noon + 22 * M, 72), watch(noon + 23 * M, 72), watch(noon + 24 * M, 72)], U, DAY, null, noon + 25 * M);
eq("a watch reading is the latest, and says so", [both.latest?.bpm, both.latest?.source, both.latest?.agoMin], [72, "health", 1]);
eq("and its five minutes, where it read more, are the watch's alone", both.points.at(-1)?.bpm, 72);
eq("every stored reading counted by source", both.sources, { band: 52, health: 3 });
eq("the day before and after stay out", dayHeart([band(at(DAY, -5, U), 90), band(at(addDays(DAY, 1), 5, U), 90)], U, DAY, null, noon).count, 0);

// ---------- Words ----------

eq("three minutes", agoWords(3 * M), "3 min ago");
eq("under a minute", agoWords(20_000), "just now");
eq("hours", agoWords(5 * 60 * M), "5 h ago");
eq("days", agoWords(3 * 24 * 60 * M), "3 days ago");
eq("a night", durationWords(430), "7 h 10 min");
eq("on the hour", durationWords(420), "7 h");
eq("a nap", durationWords(45), "45 min");
eq("Health's running is a run", workoutName("running"), "run");
eq("its strength training", workoutName("traditionalStrengthTraining"), "strength training");
eq("a type in camel case", workoutName("stairClimbing"), "stair climbing");
eq("a number from an old phone", workoutName("3000"), "workout");

// ---------- Against the real schema ----------

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    sql,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    // Reads in a batch come back as results (fillWorkoutHeart reads that way).
    batch: async (list: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(/^\s*SELECT/i.test(s.sql) ? await s.all() : await s.run());
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
sqlite.exec("PRAGMA foreign_keys = ON");
const DB = d1(sqlite);
const env = { DB } as unknown as Env;

function addUser(id: string, { consent = true, timeZone = NY } = {}) {
  sqlite
    .prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, ai_consent_at, ai_consent_version) VALUES (?, ?, '', '', 'Sam', 0, ?, ?)")
    .run(id, `${id}@example.com`, consent ? 1 : null, consent ? AI_CONSENT_VERSION : null);
  sqlite.prepare("INSERT INTO settings (user_id, time_zone, updated_at) VALUES (?, ?, 0)").run(id, timeZone);
}
const rows = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...(args as never[])) as Record<string, unknown>[];

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("userId", c.req.header("x-user") ?? "");
  await next();
});
app.route("/", healthDays);
const call = async (user: string, method: string, path: string, body?: unknown) => {
  const res = await app.request(
    path,
    { method, headers: { "x-user": user, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) },
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

// ---------- What the phone sends ----------

addUser("sam");
addUser("noai", { consent: false });
const now = Date.now();
const today = buckets(now, NY).day;
const yesterday = addDays(today, -1);
const run = { uuid: "RUN-1", type: "running", start: at(today, 6 * 60), end: at(today, 6 * 60 + 32), distanceM: 5200, source: "Sam's Apple Watch" };
const lift = { uuid: "LIFT-1", type: "traditionalStrengthTraining", start: at(yesterday, 18 * 60), end: at(yesterday, 19 * 60), source: "Sam's Apple Watch" };
// Watch readings through the run, before it's sent.
sqlite.prepare("INSERT INTO hr_samples (user_id, ts, bpm, source) VALUES ('sam', ?, 140, 'health'), ('sam', ?, 160, 'health')").run(run.start + 5 * M, run.start + 20 * M);
// What detection found, and one said by voice: a sync never touches them.
sqlite
  .prepare("INSERT INTO workouts (id, user_id, start_at, end_at, kind, source, created_at) VALUES ('found', 'sam', ?, ?, 'cardio', 'detected', 0), ('said', 'sam', ?, ?, 'manual', 'manual', 0)")
  .run(at(today, 9 * 60), at(today, 9 * 60 + 20), at(today, 10 * 60), at(today, 10 * 60 + 30));

const sleep = { asleepMin: 430, inBedMin: 480, start: at(yesterday, 23 * 60 + 40), end: at(today, 7 * 60 + 5), stages: { deep: 65, rem: 100 }, source: "Sam's Apple Watch" };
const first = await call("sam", "PUT", "/health/days", {
  from: yesterday,
  to: today,
  days: [
    { day: yesterday, activeKcal: 510, restingHr: 57 },
    { day: today, activeKcal: 300, hrvMs: 48, spo2Pct: 0.97, sleep, sources: { heart: ["OVOA", "Sam's Apple Watch"] } },
  ],
  workouts: [run, lift, { uuid: "BAD", type: "running", start: 10, end: 5, source: "x" }],
});
eq("stored, the malformed workout left out", first.body, { stored: 2, workouts: 2 });
eq("a blood oxygen of 0.97 is dropped, not the day", rows("SELECT spo2_pct, hrv_ms FROM health_days WHERE user_id = 'sam' AND day = ?", today), [{ spo2_pct: null, hrv_ms: 48 }]);
eq("a watch's run keeps its readings' average and peak", rows("SELECT avg_hr, peak_hr, confirmed_kind FROM workouts WHERE id = ?", "hk:sam:RUN-1"), [
  { avg_hr: 150, peak_hr: 160, confirmed_kind: "run" },
]);
eq("and a plain sentence", rows("SELECT summary FROM workouts WHERE id = ?", "hk:sam:RUN-1")[0]?.summary, "32 minute run, 5.2 km, recorded by Sam's Apple Watch.");

// They said what the run was; the lift is deleted in Health, and today's numbers change.
sqlite.prepare("UPDATE workouts SET confirmed_kind = 'tempo run' WHERE id = 'hk:sam:RUN-1'").run();
const second = await call("sam", "PUT", "/health/days", { from: yesterday, to: today, days: [{ day: today, activeKcal: 420 }], workouts: [run] });
eq("the second sync is stored", second.body, { stored: 1, workouts: 1 });
eq("the day is overwritten: its sleep went with the old sync", rows("SELECT active_kcal, sleep_json FROM health_days WHERE user_id = 'sam' AND day = ?", today), [
  { active_kcal: 420, sleep_json: null },
]);
eq("a day not sent again is left as it was", rows("SELECT active_kcal FROM health_days WHERE user_id = 'sam' AND day = ?", yesterday), [{ active_kcal: 510 }]);
eq(
  "the workout deleted in Health is gone; detected and hand-logged stay",
  rows("SELECT id FROM workouts WHERE user_id = 'sam' ORDER BY id").map((r) => r.id),
  ["found", "hk:sam:RUN-1", "said"],
);
eq("what they said the run was is kept", rows("SELECT confirmed_kind FROM workouts WHERE id = 'hk:sam:RUN-1'")[0]?.confirmed_kind, "tempo run");

// Wearing both: the band found the run and the lift before the watch's
// workouts arrived, and they said what the run was.
addUser("wore");
sqlite
  .prepare(
    `INSERT INTO workouts (id, user_id, start_at, end_at, kind, confirmed_kind, source, created_at) VALUES
       ('det-run', 'wore', ?, ?, 'run_walk', 'hill reps', 'detected', 0),
       ('det-lift', 'wore', ?, ?, 'strength', NULL, 'detected', 0),
       ('det-noon', 'wore', ?, ?, 'cardio', NULL, 'detected', 0)`,
  )
  .run(run.start + 2 * M, run.end - M, lift.start + 5 * M, lift.end - 10 * M, at(today, 12 * 60), at(today, 12 * 60 + 30));
await call("wore", "PUT", "/health/days", { from: yesterday, to: today, days: [{ day: today }], workouts: [run, lift] });
eq(
  "a session the watch also recorded is its row alone; one it didn't stays",
  rows("SELECT id, confirmed_kind FROM workouts WHERE user_id = 'wore' ORDER BY id"),
  [
    { id: "det-noon", confirmed_kind: null },
    { id: "hk:wore:LIFT-1", confirmed_kind: "strength training" },
    { id: "hk:wore:RUN-1", confirmed_kind: "hill reps" },
  ],
);
eq(
  "so the run is said once, as what they called it",
  ((await healthSummaryFor(DB, "wore", NY, { about: "activity", days: 1 })).days[0] as Record<string, unknown>)?.workouts,
  [`Hill reps, 32 min, ${clock(run.start, NY)}`, `Cardio session, 30 min, ${clock(at(today, 12 * 60), NY)}`],
);

const refused = await call("noai", "PUT", "/health/days", { from: today, to: today, days: [{ day: today, activeKcal: 1 }] });
eq("without AI consent nothing is kept", [refused.body, rows("SELECT * FROM health_days WHERE user_id = 'noai'").length], [{ stored: 0, skipped: "no_ai_consent" }, 0]);
eq("a day outside from..to is refused", (await call("sam", "PUT", "/health/days", { from: today, to: today, days: [{ day: yesterday }] })).status, 400);

// ---------- Read back ----------

addUser("hr");
const twelve = Array.from({ length: 12 }, (_, i) => now - (i + 1) * M).filter((ts) => buckets(ts, NY).day === today);
for (const ts of twelve) sqlite.prepare("INSERT INTO hr_samples (user_id, ts, bpm, source) VALUES ('hr', ?, 64, 'band')").run(ts);
const day = await call("hr", "GET", "/hr/day");
eq("GET /hr/day counts the band's readings", [day.body.count, day.body.latest?.source], [twelve.length, twelve.length ? "band" : undefined]);
eq("a day that isn't one is refused", (await call("hr", "GET", "/hr/day?day=2026-13-45")).status, 400);

addUser("week", { timeZone: U });
for (const s of nights(yesterday, 30, () => 58, U)) sqlite.prepare("INSERT INTO hr_samples (user_id, ts, bpm, source) VALUES ('week', ?, ?, 'band')").run(s.ts, s.bpm);
sqlite.prepare("INSERT INTO step_days (user_id, day, steps, updated_at) VALUES ('week', ?, 6400, 0)").run(yesterday);
const weekToday = buckets(now, U).day;
const week = (await call("week", "GET", "/health/days?days=3")).body.days as Record<string, unknown>[];
eq("three days, oldest first", week.map((d) => d.day), [addDays(weekToday, -2), addDays(weekToday, -1), weekToday]);
const wy = week.find((d) => d.day === yesterday);
eq("steps from step_days, resting from the band's night", [wy?.steps, wy?.restingBpm, wy?.restingFrom], [6400, 58, "band_night"]);

// ---------- What health_summary says ----------

const NOW = Date.UTC(2026, 8, 22, 9);
const TODAY = "2026-09-22";
const said = (user: string, args: Record<string, unknown>, when = NOW) => healthSummaryFor(DB, user, U, args, when) as Promise<Record<string, any>>;
const putDay = (user: string, dayOf: string, fields: Record<string, unknown>, updatedAt = NOW - 30 * M) =>
  sqlite
    .prepare(
      `INSERT INTO health_days (user_id, day, hrv_ms, weight_kg, sleep_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(user, dayOf, (fields.hrvMs as number) ?? null, (fields.weightKg as number) ?? null, fields.sleep ? JSON.stringify(fields.sleep) : null, updatedAt);

addUser("slept", { timeZone: U });
putDay("slept", TODAY, { sleep: { asleepMin: 430, start: at(TODAY, -20, U), end: at(TODAY, 7 * 60 + 5, U), stages: { deep: 65, rem: 100 }, source: "Sam's Apple Watch" } });
sqlite.prepare("INSERT INTO hr_samples (user_id, ts, bpm, source) VALUES ('slept', ?, 61, 'band')").run(NOW - 3 * M);
const sleptSaid = await said("slept", { about: "sleep" });
eq("about sleep: only sleep", Object.keys(sleptSaid), ["days"]);
eq("the night in numbers", sleptSaid.days, [
  {
    day: "Tue 22 Sep",
    sleep: { asleep: "7 h 10 min", bed: clock(at(TODAY, -20, U), U), wake: clock(at(TODAY, 7 * 60 + 5, U), U), deepMin: 65, remMin: 100, from: "Sam's Apple Watch" },
  },
]);
const heartSaid = await said("slept", { about: "heart" });
eq("about heart: the latest reading and its age", heartSaid.heartNow, { bpm: 61, ago: "3 min ago", from: "your OVOA Band" });
eq("and why there's no resting yet, nothing else", heartSaid.missing, { restingBpm: "not enough readings yet: wearing the band overnight gives a resting heart rate" });

addUser("nosleep", { timeZone: U });
putDay("nosleep", TODAY, { hrvMs: 40 });
eq("no sleep recorded: why, and only that", (await said("nosleep", { about: "sleep" })).missing, {
  sleep: "nothing is recording sleep: an Apple Watch or the iPhone's Sleep schedule would",
});
const body = await said("nosleep", { about: "body" });
eq("about body: HRV, and one line for what needs a watch", [body.days[0]?.hrvMs, Object.keys(body.missing)], [40, ["bloodOxygenPct, breathsPerMin", "weightKg"]]);

addUser("never", { timeZone: U });
eq("Health never sent: says so, not 'nothing records sleep'", (await said("never", { about: "sleep" })).missing?.sleep, "Apple Health hasn't reached OVOA yet: the iPhone sends it when it's unlocked, from the latest OVOA app");

addUser("locked", { timeZone: U });
putDay("locked", addDays(TODAY, -1), { hrvMs: 44 }, NOW - 9 * 60 * M);
const lockedSaid = await said("locked", { about: "sleep" });
eq("a phone locked all night: the numbers are old, and when they'll come", [lockedSaid.missing?.sleep, lockedSaid.healthSyncedAgo], [
  "Apple Health numbers are from 9 h ago; they update when the iPhone is next unlocked",
  "9 h ago",
]);

// Nothing in Health changed for seven hours, but the phone read it just now:
// it sends today anyway, and that's what "old" is measured from.
addUser("quiet", { timeZone: U });
const quietDay = buckets(Date.now(), U).day;
putDay("quiet", quietDay, {}, Date.now() - 7 * 60 * M);
eq("seven hours since the last send: old", (await said("quiet", { about: "sleep" }, Date.now())).healthSyncedAgo, "7 h ago");
await call("quiet", "PUT", "/health/days", { from: quietDay, to: quietDay, days: [{ day: quietDay }] });
const quietSaid = await said("quiet", { about: "sleep" }, Date.now());
eq("today sent again, unchanged: not old, and the real reason", [quietSaid.healthSyncedAgo, quietSaid.missing?.sleep], [
  undefined,
  "nothing is recording sleep: an Apple Watch or the iPhone's Sleep schedule would",
]);

addUser("walker", { timeZone: U });
for (const [i, steps] of [8000, 6000, 7000].entries()) {
  sqlite.prepare("INSERT INTO step_days (user_id, day, steps, updated_at) VALUES ('walker', ?, ?, 0)").run(addDays(TODAY, -i), steps);
}
putDay("walker", TODAY, {});
const walked = await said("walker", { about: "activity", days: 7 });
eq("a week of activity, newest first", walked.days.map((d: Record<string, unknown>) => d.steps), [8000, 6000, 7000]);
eq("with the average", walked.averages, { steps: 7000 });
eq("sleep isn't in an activity answer", "sleep" in (walked.missing ?? {}), false);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
