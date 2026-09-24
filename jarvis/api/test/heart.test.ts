// Finding workouts in heart rate (heart.ts) against the real schema: a run a
// watch already recorded isn't found again, two detections at once record a
// session once, a watch's two-week backlog starts no detection, and a watch
// workout gets its heart rate when the readings arrive after it. The overnight
// window that the resting baseline reads, per day rather than per reading.
//
// The pushes are the part a person notices: "Was it a strength session?" twice,
// or about a run their watch already logged, is OVOA not paying attention.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { detectWorkouts, fillWorkoutHeart, heart, overnight, restingBaseline, type Sample } from "../src/heart";
import { atLocalTime } from "../src/time";
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
const NY = "America/New_York";

// ---------- The night, per day ----------

const week = Array.from({ length: 7 }, (_, i) => `2026-09-${String(15 + i).padStart(2, "0")}`);
const readings: Sample[] = week.flatMap((day) => [
  { ts: atLocalTime(day, 3 * 60, NY), bpm: 55 },
  { ts: atLocalTime(day, 6 * 60, NY), bpm: 90 },
  { ts: atLocalTime(day, 12 * 60, NY), bpm: 90 },
]);
eq("each night's readings, midnight to six, and no others", overnight(readings, NY).map((s) => s.bpm), Array(7).fill(55));
// 3am on the first of November: the clocks went back at 2am.
eq("the night the clocks change is still a night", overnight([{ ts: atLocalTime("2026-11-01", 3 * 60, NY), bpm: 50 }], NY).length, 1);
const nights20 = Array.from({ length: 20 }, (_, i) => ({ ts: atLocalTime("2026-09-15", i * 10, NY), bpm: 52 }));
eq("twenty of them are the baseline", restingBaseline([...nights20, ...readings], NY), 52);

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
const DB = d1(sqlite);
const env = { DB } as unknown as Env;

// On the free plan, so a found workout gets the plain sentence and no model is asked.
function addUser(id: string) {
  sqlite
    .prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at, plan_override) VALUES (?, ?, '', '', 'Sam', 0, 'free')")
    .run(id, `${id}@example.com`);
}
const count = (sql: string, ...args: unknown[]) => (sqlite.prepare(sql).get(...(args as never[])) as { n: number }).n;

/** Half an hour at rest, half an hour at 140, half an hour back down, a reading a minute, ending `endsAgo` before now. */
function session(endsAgo: number) {
  const start = Date.now() - endsAgo - 90 * M;
  return Array.from({ length: 90 }, (_, m) => ({ ts: start + m * M, bpm: m < 30 ? 64 : m < 60 ? 140 : 68 }));
}
const store = (user: string, samples: Sample[], source = "band") => {
  for (const s of samples) sqlite.prepare("INSERT OR IGNORE INTO hr_samples (user_id, ts, bpm, source) VALUES (?, ?, ?, ?)").run(user, s.ts, s.bpm, source);
};

addUser("twice");
store("twice", session(30 * M));
const [a, b] = await Promise.all([detectWorkouts(env, "twice"), detectWorkouts(env, "twice")]);
eq("two detections at once record the half hour once", [a + b, count("SELECT COUNT(*) AS n FROM workouts WHERE user_id = 'twice'")], [1, 1]);
eq("and only the one that recorded it logs it", count("SELECT COUNT(*) AS n FROM action_log WHERE user_id = 'twice'"), 1);

addUser("watched");
const raised = session(30 * M);
store("watched", raised);
sqlite
  .prepare("INSERT INTO workouts (id, user_id, start_at, end_at, kind, confirmed_kind, source, created_at) VALUES ('hk:watched:1', 'watched', ?, ?, 'running', 'run', 'health', 0)")
  .run(raised[28].ts, raised[62].ts);
eq("a run the watch recorded isn't found again", [await detectWorkouts(env, "watched"), count("SELECT COUNT(*) AS n FROM workouts WHERE user_id = 'watched'")], [0, 1]);

// Wearing both, no watch workout: the band every five minutes at rest and every
// minute once heart rate is up, the watch every seven minutes throughout.
addUser("wearsboth");
// The baseline takes midnight to six as the night, so these two hours have to
// be daytime where the user is: run at 01:41 UTC they were the night, the
// band's forty readings at 140 were its median, and nothing counted as raised
// (2026-09-23). Tokyo is nine hours on from UTC, so one of the two is day.
const dayZone = ["UTC", "Asia/Tokyo"].find(
  (tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date())) >= 8,
)!;
sqlite.prepare("INSERT INTO settings (user_id, time_zone, updated_at) VALUES ('wearsboth', ?, 0)").run(dayZone);
const began = Date.now() - 2 * 60 * M;
const rest = (from: number, to: number) => Array.from({ length: (to - from) / 5 }, (_, i) => ({ ts: began + (from + i * 5) * M, bpm: 64 }));
store("wearsboth", [...rest(0, 30), ...Array.from({ length: 40 }, (_, i) => ({ ts: began + (30 + i) * M, bpm: 140 })), ...rest(70, 100)]);
store(
  "wearsboth",
  Array.from({ length: 15 }, (_, i) => ({ ts: began + (1 + i * 7) * M, bpm: i >= 5 && i < 10 ? 140 : 65 })),
  "health",
);
eq("a watch reading every seven minutes doesn't hide the band's session", await detectWorkouts(env, "wearsboth"), 1);

// ---------- Uploads ----------

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", async (c, next) => {
  c.set("userId", c.req.header("x-user") ?? "");
  await next();
});
app.route("/", heart);
const later: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void later.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
async function upload(user: string, source: string, samples: Sample[]) {
  const res = await app.request(
    "/hr",
    { method: "POST", headers: { "x-user": user, "content-type": "application/json" }, body: JSON.stringify({ source, samples }) },
    env,
    ctx,
  );
  await Promise.all(later.splice(0));
  return res.status;
}

// A session in the last hours is already stored; then a backlog from yesterday arrives.
addUser("backlog");
store("backlog", session(30 * M));
await upload("backlog", "health", session(20 * 60 * M));
eq("a backlog from hours ago starts no detection", count("SELECT COUNT(*) AS n FROM workouts WHERE user_id = 'backlog'"), 0);
await upload("backlog", "band", [{ ts: Date.now() - M, bpm: 66 }]);
eq("a reading from now does", count("SELECT COUNT(*) AS n FROM workouts WHERE user_id = 'backlog'"), 1);

// The watch's run arrives first (PUT /health/days), its heart rate after.
addUser("filled");
const run = session(26 * 60 * M).slice(30, 60);
sqlite
  .prepare("INSERT INTO workouts (id, user_id, start_at, end_at, kind, confirmed_kind, source, created_at) VALUES ('hk:filled:1', 'filled', ?, ?, 'running', 'run', 'health', 0)")
  .run(run[0].ts, run.at(-1)!.ts);
eq("nothing to fill before the readings come", await fillWorkoutHeart(DB, "filled", run[0].ts, run.at(-1)!.ts), 0);
await upload("filled", "health", run.map((s, i) => ({ ts: s.ts, bpm: 130 + (i % 3) * 10 })));
eq(
  "the run gets its average and peak when they do",
  sqlite.prepare("SELECT avg_hr, peak_hr FROM workouts WHERE id = 'hk:filled:1'").get(),
  { avg_hr: 140, peak_hr: 150 },
);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
