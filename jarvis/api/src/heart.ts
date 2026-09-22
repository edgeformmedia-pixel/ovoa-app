import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import { validTimeZone } from "./google/assistant";
import { generateText, type CallTool, type ToolSpec } from "./llm";
import { distanceM, placeFor, type Place } from "./location";
import { push } from "./push";
import { buckets, clock, localMinutes } from "./time";
import type { Env, Vars } from "./types";

// Heart rate (F11) and the workouts found in it (F12). See migrations/0021_heart.sql.
//
// Two sources: the band, which the phone asks for a reading every few minutes
// while it's linked, and Apple Health, where a watch writes. Either is enough.
// With neither, workouts can still be logged by voice.

export const HR_RETAIN_DAYS = 30;
/** Resting heart rate when there's too little data to work one out. */
export const DEFAULT_BASELINE = 65;
/** A session opens this far above resting... */
const OPEN_ABOVE = 25;
/** ...and has to stay up this long to count. */
const MIN_SESSION_MS = 10 * 60_000;
/** It's over once heart rate falls back to within this of resting. */
const CLOSE_ABOVE = 10;
/** Readings further apart than this can't be one continuous session. */
const MAX_GAP_MS = 6 * 60_000;

export type Sample = { ts: number; bpm: number };

const median = (xs: number[]) => {
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
 * Resting heart rate, from the last week. Overnight readings (midnight to 6am,
 * when they're most likely home and still) are the honest measure when there
 * are enough of them; otherwise the lower fifth of everything.
 */
export function restingBaseline(samples: Sample[], timeZone: string) {
  const night = samples.filter((s) => localMinutes(s.ts, timeZone) < 6 * 60).map((s) => s.bpm);
  if (night.length >= 20) return Math.round(median(night));
  if (samples.length >= 20) return Math.round(percentile(samples.map((s) => s.bpm), 0.2));
  return DEFAULT_BASELINE;
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

const KIND_WORDS: Record<string, string> = { strength: "strength session", run_walk: "run or walk", cardio: "cardio session" };

// ---------- Storage ----------

export async function ingestHeartRate(env: Env, userId: string, samples: Sample[], source: "health" | "band") {
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

async function samplesSince(db: D1Database, userId: string, since: number) {
  const { results } = await db
    .prepare("SELECT ts, bpm FROM hr_samples WHERE user_id = ? AND ts >= ? ORDER BY ts")
    .bind(userId, since)
    .all<Sample>();
  return results;
}

export async function baselineFor(db: D1Database, userId: string, timeZone: string) {
  return restingBaseline(await samplesSince(db, userId, Date.now() - 7 * 86_400_000), timeZone);
}

/**
 * Runs after each upload: looks at the last six hours for sessions that have
 * finished and aren't recorded yet, records them, and says so.
 */
export async function detectWorkouts(env: Env, userId: string) {
  const db = env.DB;
  const tz = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  const timeZone = validTimeZone(tz?.time_zone);
  const since = Date.now() - 6 * 3_600_000;
  const [samples, baseline, { results: points }, { results: known }, { results: places }] = await Promise.all([
    samplesSince(db, userId, since),
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
  const found = findSessions(samples, baseline, { movedM }).filter(
    (s) => !s.open && !known.some((k) => s.start < k.end_at && s.end > k.start_at),
  );

  for (const s of found) {
    const spot = points.find((p) => p.ts >= s.start && p.ts <= s.end);
    const place = spot ? placeFor(spot, places) : null;
    // A strength-looking session at the gym is a strength session, whatever the swings said.
    const kind = place?.kind === "gym" && s.kind === "cardio" ? "strength" : s.kind;
    const id = crypto.randomUUID();
    const minutes = Math.round((s.end - s.start) / 60_000);
    const summary = await summarize(env, userId, { ...s, kind, baseline, minutes, place: place?.name ?? null, timeZone }).catch(
      () => `${minutes} minute ${KIND_WORDS[kind]}, average ${s.avg} bpm, peak ${s.peak}.`,
    );
    await db
      .prepare(
        `INSERT INTO workouts (id, user_id, start_at, end_at, kind, avg_hr, peak_hr, zones_json, place_id, summary, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detected', ?)`,
      )
      .bind(id, userId, s.start, s.end, kind, s.avg, s.peak, JSON.stringify(s.zones), place?.id ?? null, summary, Date.now())
      .run();
    await logAction(db, userId, "workout_log", `Logged a ${minutes} min ${KIND_WORDS[kind]}`, "system", id);
    await push(env, userId, {
      title: `Workout: ${minutes} min`,
      body: `${summary} Was it a ${KIND_WORDS[kind]}? Tell OVOA what it was.`.slice(0, 180),
      data: { type: "workout", workoutId: id },
    });
  }
  return found.length;
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
  const stored = await ingestHeartRate(
    c.env,
    c.var.userId,
    parsed.data.samples.map((s) => ({ ts: s.ts, bpm: Math.round(s.bpm) })),
    parsed.data.source,
  );
  // Detection writes to the log and may call the model: done after the phone has its answer.
  c.executionCtx.waitUntil(detectWorkouts(c.env, c.var.userId).catch((err) => console.error("workouts: detection failed", err)));
  return c.json({ stored });
});

heart.get("/hr/today", async (c) => {
  const tz = validTimeZone(
    (await c.env.DB.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(c.var.userId).first<{ time_zone: string | null }>())?.time_zone,
  );
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

const TOOLS: ToolSpec[] = [
  {
    name: "workout_list",
    description: "Their recent workouts — detected from heart rate or logged by voice — with length, kind and heart rate.",
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
    prompt: "Workouts are found from heart rate (the band, or a watch through Apple Health) and summarised; they can also be logged by voice. When they say what a detected one was, record it with workout_confirm.",
  };
}
