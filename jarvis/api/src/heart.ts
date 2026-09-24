import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import { validTimeZone } from "./google/assistant";
import { generateText, type CallTool, type ToolSpec } from "./llm";
import { distanceM, placeFor, type Place } from "./location";
import { push } from "./push";
import { addDays, atLocalTime, buckets, clock, startOfDay } from "./time";
import { mayRunFor } from "./plans";
import type { Env, Vars } from "./types";

// Heart rate (F11) and the workouts found in it (F12). See migrations/0021_heart.sql.
//
// Two sources, either one enough: the band ('band'), which the phone asks for a
// reading every five minutes while it's linked (every minute while it's
// raised), and Apple Health ('health'), where a watch writes. The phone also
// saves the band's readings to Apple Health, and leaves OVOA's own out when it
// reads Health back, so a 'health' row is always someone else's reading. Where
// both have readings in the same five minutes, the one with more of them there
// is used, the watch on a tie (oneSeries). With neither, workouts can still be
// logged by voice.
//
// The day views, Apple Health's other numbers and the health_summary answer
// are healthdays.ts; this file keeps the readings and finds workouts in them.
//
// Samples are deleted after 14 days by the nightly purge (retention.ts), and so
// are the workouts found in them; one logged by voice (source 'manual') stays.
// A resting baseline needs a week of them (baselineFor).
/** Resting heart rate when there's too little data to work one out. */
export const DEFAULT_BASELINE = 65;
/** A session opens this far above resting, and a minute this far up counts as raised (healthdays.ts)... */
export const OPEN_ABOVE = 25;
/** ...and has to stay up this long to count. */
const MIN_SESSION_MS = 10 * 60_000;
/** It's over once heart rate falls back to within this of resting. */
const CLOSE_ABOVE = 10;
/** Readings further apart than this can't be one continuous session. */
export const MAX_GAP_MS = 6 * 60_000;
/** Detection looks this far back, and an upload whose newest reading is older than this starts none. */
const DETECT_WINDOW_MS = 6 * 3_600_000;
/** Readings are grouped this finely to choose between band and watch, and for a day's chart. */
export const BUCKET_MS = 5 * 60_000;

export type Sample = { ts: number; bpm: number };
export type HeartSource = "band" | "health";
export type SourcedSample = Sample & { source: HeartSource };
/** Where a resting heart rate came from: Apple's own (a watch), or worked out here from the night or the day's low. */
export type RestingFrom = "apple" | "band_night" | "band_low";

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/**
 * One series from two sources: in each five minutes, the readings of whichever
 * has more there, the watch's on a tie. Both at once would weigh the same
 * minutes twice and zig-zag between two sensors, which classify counts as
 * sets. Not always the watch: it reads every few seconds only in a workout,
 * and every few minutes otherwise, while the band reads every minute once
 * heart rate is up. Keeping a watch's one reading over the band's five threw
 * away half a raised hour, left 7-minute gaps (MAX_GAP_MS is 6) and hid a
 * 40-minute session (review, 2026-09-23). Oldest first.
 */
export function oneSeries<T extends SourcedSample>(samples: T[]): T[] {
  const counts = new Map<number, Record<HeartSource, number>>();
  for (const s of samples) {
    const bucket = Math.floor(s.ts / BUCKET_MS);
    const n = counts.get(bucket) ?? { band: 0, health: 0 };
    n[s.source]++;
    counts.set(bucket, n);
  }
  return samples
    .filter((s) => {
      const n = counts.get(Math.floor(s.ts / BUCKET_MS))!;
      return s.source === (n.health >= n.band ? "health" : "band");
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Resting heart rate from readings. Overnight ones (midnight to 6am, when
 * they're most likely home and still) are the honest measure when there are 20
 * of them; otherwise the lower fifth of everything, once there are `minAll`.
 * Null when there's too little to say.
 */
export function restingEstimate(night: number[], all: number[], minAll: number): { bpm: number; from: "band_night" | "band_low" } | null {
  if (night.length >= 20) return { bpm: Math.round(median(night)), from: "band_night" };
  if (all.length >= minAll) return { bpm: Math.round(percentile(all, 0.2)), from: "band_low" };
  return null;
}

/**
 * The readings taken between local midnight and 6am. The window is worked out
 * once per day the samples cover rather than per reading: a watch's week at one
 * reading every 30 s is 20,160 of them, which took 4.9 s with a clock reading
 * each and 0.13 s this way (Node, 2026-09-23), on every upload's detection.
 */
export function overnight<T extends Sample>(samples: T[], timeZone: string): T[] {
  if (!samples.length) return [];
  let first = Infinity;
  let last = -Infinity;
  for (const s of samples) {
    first = Math.min(first, s.ts);
    last = Math.max(last, s.ts);
  }
  const nights: [number, number][] = [];
  for (let day = buckets(first, timeZone).day, end = buckets(last, timeZone).day; day <= end; day = addDays(day, 1)) {
    nights.push([startOfDay(day, timeZone), atLocalTime(day, 6 * 60, timeZone)]);
  }
  return samples.filter((s) => nights.some(([from, to]) => s.ts >= from && s.ts < to));
}

/** Resting heart rate from the last week, for finding workouts; the default when there's too little. */
export function restingBaseline(samples: Sample[], timeZone: string) {
  const resting = restingEstimate(
    overnight(samples, timeZone).map((s) => s.bpm),
    samples.map((s) => s.bpm),
    20,
  );
  return resting?.bpm ?? DEFAULT_BASELINE;
}

export type Session = {
  start: number;
  end: number;
  avg: number;
  peak: number;
  /** Minutes in each of five zones, set relative to resting heart rate. */
  zones: number[];
  kind: "strength" | "run_walk" | "cardio";
  /** Still going: the latest readings are still raised. */
  open: boolean;
};

/**
 * Finds stretches of raised heart rate. A stretch opens on a reading more than
 * 25 above resting, runs while readings stay above resting + 10 with no gap
 * over six minutes, and counts if it lasted ten minutes. Pure, for testing.
 *
 * What kind: heart rate that keeps climbing and dropping every minute or three
 * is sets and rests — strength. A long plateau while the phone moved is a run or
 * a walk. A plateau in one spot is cardio (a bike, a machine).
 */
export function findSessions(samples: Sample[], baseline: number, opts: { movedM?: (from: number, to: number) => number; now?: number } = {}) {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  const sessions: Session[] = [];
  let run: Sample[] = [];

  const close = (open: boolean) => {
    if (run.length < 2) return void (run = []);
    const start = run[0].ts;
    const end = run[run.length - 1].ts;
    if (end - start < MIN_SESSION_MS) return void (run = []);
    const bpms = run.map((s) => s.bpm);
    const zones = [0, 0, 0, 0, 0];
    for (let i = 1; i < run.length; i++) {
      const mins = (run[i].ts - run[i - 1].ts) / 60_000;
      const over = run[i].bpm - baseline;
      zones[over < 30 ? 0 : over < 50 ? 1 : over < 70 ? 2 : over < 90 ? 3 : 4] += mins;
    }
    sessions.push({
      start,
      end,
      avg: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
      peak: Math.max(...bpms),
      zones: zones.map((z) => Math.round(z)),
      kind: classify(run, opts.movedM?.(start, end) ?? 0),
      open,
    });
    run = [];
  };

  for (const s of sorted) {
    const last = run[run.length - 1];
    if (last && s.ts - last.ts > MAX_GAP_MS) close(false);
    if (run.length) {
      if (s.bpm >= baseline + CLOSE_ABOVE) run.push(s);
      else close(false);
    } else if (s.bpm >= baseline + OPEN_ABOVE) {
      run.push(s);
    }
  }
  const now = opts.now ?? Date.now();
  const tail = run[run.length - 1];
  close(!!tail && now - tail.ts < MAX_GAP_MS);
  return sessions;
}

/** Counts rise-then-fall swings of at least 12 bpm; one every one to three minutes is sets and rests. */
function classify(run: Sample[], movedM: number): Session["kind"] {
  const minutes = (run[run.length - 1].ts - run[0].ts) / 60_000;
  let swings = 0;
  let low = run[0].bpm;
  let high = run[0].bpm;
  let rising = true;
  for (const s of run) {
    if (rising) {
      if (s.bpm > high) high = s.bpm;
      else if (high - s.bpm >= 12) {
        if (high - low >= 12) swings++;
        rising = false;
        low = s.bpm;
      }
    } else if (s.bpm < low) {
      low = s.bpm;
    } else if (s.bpm - low >= 12) {
      rising = true;
      high = s.bpm;
    }
  }
  if (movedM > 800) return "run_walk";
  if (swings >= minutes / 4) return "strength";
  return "cardio";
}

export const KIND_WORDS: Record<string, string> = { strength: "strength session", run_walk: "run or walk", cardio: "cardio session" };

// ---------- Storage ----------

export async function timeZoneOf(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  return validTimeZone(row?.time_zone);
}

export async function ingestHeartRate(env: Env, userId: string, samples: Sample[], source: HeartSource) {
  const db = env.DB;
  const clean = samples.filter((s) => s.bpm >= 30 && s.bpm <= 230);
  for (let i = 0; i < clean.length; i += 50) {
    await db.batch(
      clean
        .slice(i, i + 50)
        .map((s) => db.prepare("INSERT OR IGNORE INTO hr_samples (user_id, ts, bpm, source) VALUES (?, ?, ?, ?)").bind(userId, s.ts, s.bpm, source)),
    );
  }
  return clean.length;
}

/** Both sources' readings from `since` (to `until`), oldest first. */
export async function samplesSince(db: D1Database, userId: string, since: number, until = Number.MAX_SAFE_INTEGER) {
  const { results } = await db
    .prepare("SELECT ts, bpm, source FROM hr_samples WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
    .bind(userId, since, until)
    .all<SourcedSample>();
  return results;
}

export async function baselineFor(db: D1Database, userId: string, timeZone: string) {
  return restingBaseline(oneSeries(await samplesSince(db, userId, Date.now() - 7 * 86_400_000)), timeZone);
}

/**
 * Average and peak heart rate for the workouts Apple Health recorded (source
 * 'health', healthdays.ts) that overlap [from, to], from the readings here now.
 * A watch's workout arrives before its heart rate does (the phone sends
 * workouts first, so detection already knows them when the readings land), so
 * this runs again for every upload that overlaps one.
 */
export async function fillWorkoutHeart(db: D1Database, userId: string, from: number, to: number) {
  const { results: spans } = await db
    .prepare("SELECT id, start_at, end_at FROM workouts WHERE user_id = ? AND source = 'health' AND start_at <= ? AND end_at >= ?")
    .bind(userId, to, from)
    .all<{ id: string; start_at: number; end_at: number }>();
  if (!spans.length) return 0;
  const reads = await db.batch<SourcedSample>(
    spans.map((w) =>
      db.prepare("SELECT ts, bpm, source FROM hr_samples WHERE user_id = ? AND ts >= ? AND ts <= ? ORDER BY ts").bind(userId, w.start_at, w.end_at),
    ),
  );
  const updates = spans.flatMap((w, i) => {
    const bpms = oneSeries(reads[i].results).map((s) => s.bpm);
    if (!bpms.length) return [];
    const avg = Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length);
    return [db.prepare("UPDATE workouts SET avg_hr = ?, peak_hr = ? WHERE id = ? AND user_id = ?").bind(avg, Math.max(...bpms), w.id, userId)];
  });
  if (updates.length) await db.batch(updates);
  return updates.length;
}

/**
 * Runs after each upload: looks at the last six hours for sessions that have
 * finished and aren't recorded yet, records them, and says so.
 */
export async function detectWorkouts(env: Env, userId: string) {
  const db = env.DB;
  const timeZone = await timeZoneOf(db, userId);
  const since = Date.now() - DETECT_WINDOW_MS;
  const [samples, baseline, { results: points }, { results: known }, { results: places }] = await Promise.all([
    samplesSince(db, userId, since).then(oneSeries),
    baselineFor(db, userId, timeZone),
    db.prepare("SELECT ts, lat, lng FROM location_points WHERE user_id = ? AND ts >= ? ORDER BY ts").bind(userId, since).all<{ ts: number; lat: number; lng: number }>(),
    db.prepare("SELECT start_at, end_at FROM workouts WHERE user_id = ? AND end_at >= ?").bind(userId, since).all<{ start_at: number; end_at: number }>(),
    db.prepare("SELECT id, name, kind, lat, lng, radius, address, visit_count FROM places WHERE user_id = ?").bind(userId).all<Place>(),
  ]);
  const movedM = (from: number, to: number) => {
    const inside = points.filter((p) => p.ts >= from && p.ts <= to);
    let d = 0;
    for (let i = 1; i < inside.length; i++) d += distanceM(inside[i - 1], inside[i]);
    return d;
  };
  // Workouts a watch recorded are in `known` too (source 'health'), so a run the
  // watch already has isn't found again and asked about. One the watch's sync
  // brings later replaces what was found here (healthdays.ts storeHealthDays).
  const found = findSessions(samples, baseline, { movedM }).filter(
    (s) => !s.open && !known.some((k) => s.start < k.end_at && s.end > k.start_at),
  );

  let recorded = 0;
  for (const s of found) {
    const spot = points.find((p) => p.ts >= s.start && p.ts <= s.end);
    const place = spot ? placeFor(spot, places) : null;
    // A strength-looking session at the gym is a strength session, whatever the swings said.
    const kind = place?.kind === "gym" && s.kind === "cardio" ? "strength" : s.kind;
    const id = crypto.randomUUID();
    const minutes = Math.round((s.end - s.start) / 60_000);
    const plain = `${minutes} minute ${KIND_WORDS[kind]}, average ${s.avg} bpm, peak ${s.peak}.`;
    // Health is free, but the model's sentence about it is Base's (plans.ts):
    // free gets the plain one, which is also what anyone gets when the model fails.
    const summary = (await mayRunFor(env, userId, "base"))
      ? await summarize(env, userId, { ...s, kind, baseline, minutes, place: place?.name ?? null, timeZone }).catch(() => plain)
      : plain;
    // Two uploads close together can both get this far with the same session (a
    // band reading and a watch's catch-up a moment apart each start a
    // detection, and the model's sentence takes seconds). The row only goes in
    // if nothing overlapping is there by then, and only the one that wrote it
    // logs it and says so.
    const { meta } = await db
      .prepare(
        `INSERT INTO workouts (id, user_id, start_at, end_at, kind, avg_hr, peak_hr, zones_json, place_id, summary, source, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detected', ?
         WHERE NOT EXISTS (SELECT 1 FROM workouts WHERE user_id = ? AND start_at < ? AND end_at > ?)`,
      )
      .bind(id, userId, s.start, s.end, kind, s.avg, s.peak, JSON.stringify(s.zones), place?.id ?? null, summary, Date.now(), userId, s.end, s.start)
      .run();
    if (!meta.changes) continue;
    recorded++;
    await logAction(db, userId, "workout_log", `Logged a ${minutes} min ${KIND_WORDS[kind]}`, "system", id);
    await push(env, userId, {
      title: `Workout: ${minutes} min`,
      body: `${summary} Was it a ${KIND_WORDS[kind]}? Tell OVOA what it was.`.slice(0, 180),
      data: { type: "workout", workoutId: id },
    });
  }
  return recorded;
}

async function summarize(
  env: Env,
  userId: string,
  w: Session & { baseline: number; minutes: number; place: string | null; timeZone: string },
) {
  const text = await generateText(env, {
    model: env.MEMORY_MODEL,
    fast: true,
    usage: { userId, purpose: "workout" },
    system:
      "Write one or two short, plain sentences summarising a workout for the person who did it, from heart-rate numbers. No emoji, no praise inflation, no medical claims. Say when and how long, how hard (from the zones), and one useful observation.",
    turns: [
      {
        role: "user",
        text: JSON.stringify({
          started: clock(w.start, w.timeZone),
          minutes: w.minutes,
          guessedKind: KIND_WORDS[w.kind],
          averageBpm: w.avg,
          peakBpm: w.peak,
          restingBpm: w.baseline,
          minutesPerZone: { easy: w.zones[0], moderate: w.zones[1], hard: w.zones[2], veryHard: w.zones[3], max: w.zones[4] },
          place: w.place,
        }),
      },
    ],
  });
  return text.trim().slice(0, 400);
}

// ---------- Routes ----------

export const heart = new Hono<{ Bindings: Env; Variables: Vars }>();

heart.post("/hr", async (c) => {
  const parsed = z
    .object({
      source: z.enum(["health", "band"]),
      samples: z.array(z.object({ ts: z.number().int().positive(), bpm: z.number().min(0).max(300) })).min(1).max(2000),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid samples" }, 400);
  const { userId } = c.var;
  const samples = parsed.data.samples.map((s) => ({ ts: s.ts, bpm: Math.round(s.bpm) }));
  const stored = await ingestHeartRate(c.env, userId, samples, parsed.data.source);
  const oldest = Math.min(...samples.map((s) => s.ts));
  const newest = Math.max(...samples.map((s) => s.ts));
  // After the phone has its answer: detection writes to the log and may call
  // the model. A watch's backlog (up to two weeks, sent oldest first) is
  // history, and a push about a workout from days ago is news to nobody, so
  // only an upload that reaches into the last six hours looks. The heart rate
  // of a watch's workouts is filled in whenever it arrives.
  if (Date.now() - newest < DETECT_WINDOW_MS) {
    c.executionCtx.waitUntil(detectWorkouts(c.env, userId).catch((err) => console.error("workouts: detection failed", err)));
  }
  c.executionCtx.waitUntil(fillWorkoutHeart(c.env.DB, userId, oldest, newest).catch((err) => console.error("workouts: heart fill failed", err)));
  return c.json({ stored });
});

heart.get("/hr/today", async (c) => {
  const tz = await timeZoneOf(c.env.DB, c.var.userId);
  const samples = await samplesSince(c.env.DB, c.var.userId, Date.now() - 24 * 3_600_000);
  return c.json({ baseline: await baselineFor(c.env.DB, c.var.userId, tz), latest: samples.at(-1) ?? null, count: samples.length });
});

heart.get("/workouts", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, start_at, end_at, kind, confirmed_kind, avg_hr, peak_hr, zones_json, summary, source FROM workouts WHERE user_id = ? ORDER BY start_at DESC LIMIT 30",
  )
    .bind(c.var.userId)
    .all();
  return c.json({ workouts: results });
});

// ---------- In conversation ----------

/**
 * Every health number, read from the server (healthdays.ts healthSummaryFor):
 * answered with the phone locked, which Apple Health on the phone can't do
 * (HealthKit Code=6 "Protected health data is inaccessible", /chat/resume on
 * 2026-09-21 23:31:51). Exported for the background agent's tools.
 */
export const healthSummaryTool: ToolSpec = {
  name: "health_summary",
  description:
    "Their health numbers from the OVOA Band and Apple Health, kept on the server so this works with the phone locked. about: 'heart' (latest reading and how long ago, resting, the day's range), 'sleep' (time asleep, bed and wake times, stages), 'activity' (steps, active energy, exercise minutes, workouts), 'body' (HRV, blood oxygen, breathing rate, weight) or 'all'. Returns only what exists; `missing` says why something asked about isn't there.",
  parameters: {
    type: "object",
    properties: {
      about: { type: "string", enum: ["heart", "sleep", "activity", "body", "all"] },
      days: {
        type: "number",
        description: "Days back including today, 1 to 14. Leave out for today (heart, sleep) or the last week (activity, body, all).",
      },
    },
  },
};

const TOOLS: ToolSpec[] = [
  healthSummaryTool,
  {
    name: "workout_list",
    description: "Their recent workouts — detected from heart rate, recorded in Apple Health or logged by voice — with length, kind and heart rate.",
    parameters: { type: "object", properties: { days: { type: "number", description: "How far back, default 7." } } },
  },
  {
    name: "workout_summary",
    description: "One workout in detail: time in each heart-rate zone, average and peak. Get the id from workout_list.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "workout_confirm",
    description: "Records what a detected workout actually was, when they say ('that was legs', 'it was a run'). Without an id, the most recent one.",
    parameters: { type: "object", properties: { id: { type: "string" }, what: { type: "string" } }, required: ["what"] },
  },
  {
    name: "workout_log",
    description: "Logs a workout by hand, for when there's no heart-rate source or it was missed: 'I did 30 minutes of yoga this morning'.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string" },
        minutes: { type: "number" },
        startedAt: { type: "string", description: "Local YYYY-MM-DDTHH:MM; leave out for 'just now'." },
      },
      required: ["what", "minutes"],
    },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isHeartTool = (name: string) => NAMES.has(name);

export function heartAssistant(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    if (name === "health_summary") {
      // Imported here: healthdays.ts builds on this file.
      const { healthSummaryFor } = await import("./healthdays");
      return healthSummaryFor(db, userId, timeZone, args);
    }
    if (name === "workout_list") {
      const days = Math.min(60, Math.max(1, Number(args.days) || 7));
      const { results } = await db
        .prepare("SELECT id, start_at, end_at, kind, confirmed_kind, avg_hr, peak_hr, source FROM workouts WHERE user_id = ? AND start_at > ? ORDER BY start_at DESC")
        .bind(userId, Date.now() - days * 86_400_000)
        .all<{ id: string; start_at: number; end_at: number; kind: string; confirmed_kind: string | null; avg_hr: number | null; peak_hr: number | null; source: string }>();
      if (!results.length) return { workouts: 0 };
      return {
        workouts: results.map((w) => ({
          id: w.id,
          when: `${buckets(w.start_at, timeZone).day} ${clock(w.start_at, timeZone)}`,
          minutes: Math.round((w.end_at - w.start_at) / 60_000),
          what: w.confirmed_kind ?? KIND_WORDS[w.kind] ?? w.kind,
          ...(w.avg_hr && { avgBpm: w.avg_hr, peakBpm: w.peak_hr }),
          ...(w.source === "manual" && { logged: "by hand" }),
          ...(w.source === "health" && { from: "Apple Health" }),
        })),
      };
    }
    if (name === "workout_summary") {
      const w = await db.prepare("SELECT * FROM workouts WHERE id = ? AND user_id = ?").bind(String(args.id ?? ""), userId).first<Record<string, unknown>>();
      if (!w) return { error: "No such workout" };
      const zones = JSON.parse(String(w.zones_json ?? "[]")) as number[];
      return { summary: w.summary, minutesPerZone: { easy: zones[0], moderate: zones[1], hard: zones[2], veryHard: zones[3], max: zones[4] }, avgBpm: w.avg_hr, peakBpm: w.peak_hr };
    }
    if (name === "workout_confirm") {
      const what = String(args.what ?? "").trim().slice(0, 60);
      if (!what) return { error: "what is required" };
      const target = args.id
        ? String(args.id)
        : (await db.prepare("SELECT id FROM workouts WHERE user_id = ? ORDER BY start_at DESC LIMIT 1").bind(userId).first<{ id: string }>())?.id;
      if (!target) return { error: "No workout to confirm" };
      const { meta } = await db.prepare("UPDATE workouts SET confirmed_kind = ? WHERE id = ? AND user_id = ?").bind(what, target, userId).run();
      return meta.changes ? { saved: true } : { error: "No such workout" };
    }
    if (name === "workout_log") {
      const what = String(args.what ?? "").trim().slice(0, 60);
      const minutes = Math.round(Number(args.minutes));
      if (!what || !(minutes > 0 && minutes <= 600)) return { error: "what and minutes (1-600) are required" };
      const { resolveDue } = await import("./context");
      const start = (args.startedAt ? resolveDue(String(args.startedAt), timeZone) : null) ?? Date.now() - minutes * 60_000;
      const id = crypto.randomUUID();
      await db
        .prepare(
          "INSERT INTO workouts (id, user_id, start_at, end_at, kind, confirmed_kind, source, summary, created_at) VALUES (?, ?, ?, ?, 'manual', ?, 'manual', ?, ?)",
        )
        .bind(id, userId, start, start + minutes * 60_000, what, `${minutes} minutes of ${what}, logged by hand.`, Date.now())
        .run();
      await logAction(db, userId, "workout_log", `Logged ${minutes} min of ${what}`, "chat", id);
      return { logged: true };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt:
      "Heart rate, sleep, steps and other health numbers come from the OVOA Band (a heart-rate reading every few minutes while it's worn) and Apple Health (a watch, the iPhone's steps, a scale, a sleep tracker). For any question about them call health_summary; it works with the phone locked. Give the number first, said the way a person says it ('sixty-two', 'about seven hours'), and compare with their own recent days only when that adds something. Mention something missing only if they asked about it, and say what would give it; never estimate a number that isn't there. Don't diagnose: if resting heart rate is over 100 or under 40, or blood oxygen under 92%, say so plainly and suggest a doctor if it keeps up. When they say what a detected workout was, record it with workout_confirm; log one with no heart-rate source with workout_log.",
  };
}
