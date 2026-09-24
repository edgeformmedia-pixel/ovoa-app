import { Hono } from "hono";
import { z } from "zod";
import { aiConsentFor } from "./consent";
import {
  BUCKET_MS,
  DEFAULT_BASELINE,
  fillWorkoutHeart,
  KIND_WORDS,
  MAX_GAP_MS,
  median,
  oneSeries,
  OPEN_ABOVE,
  restingEstimate,
  samplesSince,
  timeZoneOf,
  type HeartSource,
  type RestingFrom,
  type SourcedSample,
} from "./heart";
import { addDays, atLocalTime, buckets, clock, dayRange } from "./time";
import type { Env, Vars } from "./types";

// A day of health: the numbers Apple Health has that nothing else here does,
// the day views of heart rate (the Activity screen), and what the assistant's
// health_summary answers from. See migrations/0046_health_days.sql.
//
// Where each number lives (the health plan, 2026-09-23):
//   heart rate  hr_samples: the band's readings and a watch's, through Apple
//               Health (heart.ts). Every heart number is worked out from them
//               here, so the band alone is enough and the phone can be locked.
//   steps       step_days (fitness.ts PUT /steps), however the phone counted.
//   workouts    the workouts table: found in heart rate, logged by voice, or
//               recorded by a watch (source 'health', written here).
//   the rest    health_days: sleep, Apple's resting heart rate, HRV, active
//               energy, exercise, stand, blood oxygen, breathing and weight.
//
// Nothing here calls a model, so the routes are free (plans.ts); only asking
// the assistant is Base.

const DAY_MS = 86_400_000;
/**
 * Apple Health numbers older than this are said to be old (healthSyncedAgo).
 * Old means the phone hasn't read Health since, not that nothing changed: it
 * sends today on every sync, changed or not, so the newest updated_at is its
 * last read. When it sent only changed days, a quiet evening with no watch
 * looked 7 h old from a phone that had synced minutes before, and "unlock your
 * iPhone" hid "nothing is recording sleep" (review, 2026-09-23).
 */
const STALE_MS = 6 * 3_600_000;

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

// ---------- Heart rate, one day at a time ----------

/**
 * One day's resting heart rate: Apple's own when a watch worked one out,
 * otherwise from the day's readings (heart.ts restingEstimate). The lower
 * fifth needs 30 readings in a day, where the week's baseline takes 20: two
 * and a half hours of wear, not a morning's quarter.
 */
export function restingForDay(
  samples: SourcedSample[],
  timeZone: string,
  day: string,
  appleResting: number | null,
): { bpm: number; from: RestingFrom } | null {
  if (appleResting) return { bpm: appleResting, from: "apple" };
  const [from, to] = dayRange(day, timeZone);
  const nightEnd = atLocalTime(day, 6 * 60, timeZone);
  const own = oneSeries(samples.filter((s) => s.ts >= from && s.ts < to));
  return restingEstimate(
    own.filter((s) => s.ts < nightEnd).map((s) => s.bpm),
    own.map((s) => s.bpm),
    30,
  );
}

/** GET /hr/day: what the Activity screen draws. */
export type HeartDay = {
  day: string;
  /** The newest reading of the day, from either source. */
  latest: { ts: number; bpm: number; source: HeartSource; agoMin: number } | null;
  restingBpm: number | null;
  restingFrom: RestingFrom | null;
  low: number | null;
  avg: number | null;
  high: number | null;
  /** Readings used, after oneSeries. */
  count: number;
  /** Minutes at resting + 25 or more: a day's effort, where workout zones would be noise. */
  raisedMin: number;
  /** Five-minute medians, oldest first. */
  points: { ts: number; bpm: number }[];
  /** Readings stored from each source, before oneSeries. */
  sources: Record<HeartSource, number>;
};

/** A day's heart rate, from readings that may cover more than the day. Pure. */
export function dayHeart(samples: SourcedSample[], timeZone: string, day: string, appleResting: number | null, now: number): HeartDay {
  const [from, to] = dayRange(day, timeZone);
  const own = samples.filter((s) => s.ts >= from && s.ts < to).sort((a, b) => a.ts - b.ts);
  const merged = oneSeries(own);
  const resting = restingForDay(own, timeZone, day, appleResting);

  // Counted from the reading before: a raised reading stands for the minutes
  // since the last one, unless the band was off in between.
  const raisedAt = (resting?.bpm ?? DEFAULT_BASELINE) + OPEN_ABOVE;
  let raisedMs = 0;
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i].ts - merged[i - 1].ts;
    if (gap <= MAX_GAP_MS && merged[i].bpm >= raisedAt) raisedMs += gap;
  }

  const points: HeartDay["points"] = [];
  for (let i = 0; i < merged.length; ) {
    const bucket = Math.floor(merged[i].ts / BUCKET_MS);
    const inBucket: number[] = [];
    while (i < merged.length && Math.floor(merged[i].ts / BUCKET_MS) === bucket) inBucket.push(merged[i++].bpm);
    points.push({ ts: bucket * BUCKET_MS, bpm: Math.round(median(inBucket)) });
  }

  const bpms = merged.map((s) => s.bpm);
  const newest = own.at(-1);
  return {
    day,
    latest: newest ? { ts: newest.ts, bpm: newest.bpm, source: newest.source, agoMin: Math.max(0, Math.round((now - newest.ts) / 60_000)) } : null,
    restingBpm: resting?.bpm ?? null,
    restingFrom: resting?.from ?? null,
    low: bpms.length ? Math.min(...bpms) : null,
    avg: bpms.length ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null,
    high: bpms.length ? Math.max(...bpms) : null,
    count: merged.length,
    raisedMin: Math.round(raisedMs / 60_000),
    points,
    sources: { band: own.filter((s) => s.source === "band").length, health: own.filter((s) => s.source === "health").length },
  };
}

// ---------- What the phone sends ----------

/** A number Health can't really have given (a unit slip on the phone) is dropped, not the day. */
const reading = (min: number, max: number) => z.number().min(min).max(max).optional().catch(undefined);
const minutes = reading(0, 1440);
const label = z.string().trim().min(1).max(60);
const names = z.array(label).max(10).optional().catch(undefined);
const day = z.string().refine(isDay);

const sleepSchema = z
  .object({
    asleepMin: z.number().min(0).max(1440),
    inBedMin: minutes,
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    stages: z.object({ core: minutes, deep: minutes, rem: minutes, awake: minutes }).optional().catch(undefined),
    source: label,
  })
  .refine((s) => s.end >= s.start);
export type SleepIn = z.infer<typeof sleepSchema>;

const workoutSchema = z
  .object({
    uuid: z.string().min(1).max(64),
    // WorkoutActivityType's key on the phone: "running", "traditionalStrengthTraining".
    type: z.string().trim().min(1).max(80),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    kcal: reading(0, 20_000),
    distanceM: reading(0, 1_000_000),
    source: label,
  })
  .refine((w) => w.end >= w.start && w.end - w.start <= DAY_MS);
type WorkoutIn = z.infer<typeof workoutSchema>;

const healthDaysSchema = z
  .object({
    from: day,
    to: day,
    days: z
      .array(
        z.object({
          day,
          activeKcal: reading(0, 20_000),
          exerciseMin: minutes,
          standHours: reading(0, 24),
          restingHr: reading(25, 250),
          hrvMs: reading(1, 500),
          spo2Pct: reading(50, 100),
          respRate: reading(3, 80),
          weightKg: reading(10, 500),
          sleep: sleepSchema.optional().catch(undefined),
          sources: z.object({ heart: names, sleep: names, steps: names }).optional().catch(undefined),
        }),
      )
      .min(1)
      .max(31),
    // One malformed workout is left out, not the sync.
    workouts: z.array(workoutSchema.nullable().catch(null)).max(100).default([]),
  })
  .refine((b) => b.from <= b.to && b.to <= addDays(b.from, 30) && b.days.every((d) => d.day >= b.from && d.day <= b.to));
export type HealthDaysIn = z.infer<typeof healthDaysSchema>;

/** Health's workout type, said plainly: "running" is a run, "traditionalStrengthTraining" strength training. */
const WORKOUT_NAMES: Record<string, string> = {
  running: "run",
  walking: "walk",
  cycling: "bike ride",
  swimming: "swim",
  hiking: "hike",
  traditionalStrengthTraining: "strength training",
  highIntensityIntervalTraining: "HIIT",
  mixedCardio: "cardio",
  mixedMetabolicCardioTraining: "cardio",
  preparationAndRecovery: "recovery",
  other: "workout",
};
export function workoutName(type: string) {
  if (WORKOUT_NAMES[type]) return WORKOUT_NAMES[type];
  // An old phone sends the number when it has no name for it.
  if (!/^[a-z][A-Za-z]*$/.test(type)) return "workout";
  return type.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
}

/** Per person: two accounts signed in on one phone read the same Health, and ids are unique across everyone. */
const workoutId = (userId: string, uuid: string) => `hk:${userId}:${uuid}`;

const round1 = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10);
const whole = (n: number | undefined) => (n === undefined ? null : Math.round(n));

/**
 * Overwrites the days sent (the phone is the source of truth, as with /steps)
 * and replaces the watch's workouts that started in them: one deleted in
 * Health is gone from the next sync of its days. The ones still there are
 * updated in place, keeping what they said one was (workout_confirm).
 * Hand-logged workouts aren't touched.
 *
 * A session the band found that a watch workout overlaps goes, and what they
 * said it was moves to the watch's row. Detection skips a watch workout that's
 * already here, but for someone wearing both the band usually gets there
 * first: its readings arrive live, while the watch's workout waits for the
 * iPhone to be unlocked and a sync (one every 15 minutes at most). Kept, the run
 * was said twice ("Run, 31 min" and "Cardio session, 29 min") and readiness
 * counted its minutes twice (review, 2026-09-23).
 */
async function storeHealthDays(db: D1Database, userId: string, timeZone: string, body: HealthDaysIn, now = Date.now()) {
  const [from] = dayRange(body.from, timeZone);
  const [, to] = dayRange(body.to, timeZone);
  const workouts = body.workouts.filter((w): w is WorkoutIn => w !== null);
  await db.batch([
    ...body.days.map((d) =>
      db
        .prepare(
          `INSERT INTO health_days (user_id, day, active_kcal, exercise_min, stand_hours, resting_hr, hrv_ms, spo2_pct, resp_rate, weight_kg, sleep_json, sources_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, day) DO UPDATE SET
             active_kcal = excluded.active_kcal, exercise_min = excluded.exercise_min, stand_hours = excluded.stand_hours,
             resting_hr = excluded.resting_hr, hrv_ms = excluded.hrv_ms, spo2_pct = excluded.spo2_pct, resp_rate = excluded.resp_rate,
             weight_kg = excluded.weight_kg, sleep_json = excluded.sleep_json, sources_json = excluded.sources_json, updated_at = excluded.updated_at`,
        )
        .bind(
          userId,
          d.day,
          whole(d.activeKcal),
          whole(d.exerciseMin),
          whole(d.standHours),
          whole(d.restingHr),
          whole(d.hrvMs),
          round1(d.spo2Pct),
          round1(d.respRate),
          round1(d.weightKg),
          d.sleep ? JSON.stringify(d.sleep) : null,
          d.sources ? JSON.stringify(d.sources) : null,
          now,
        ),
    ),
    db
      .prepare("DELETE FROM workouts WHERE user_id = ? AND source = 'health' AND start_at >= ? AND start_at < ? AND id NOT IN (SELECT value FROM json_each(?))")
      .bind(userId, from, to, JSON.stringify(workouts.map((w) => workoutId(userId, w.uuid)))),
    ...workouts.map((w) => {
      const name = workoutName(w.type);
      const summary = [
        `${Math.round((w.end - w.start) / 60_000)} minute ${name}`,
        ...(w.distanceM ? [`${Math.round(w.distanceM / 100) / 10} km`] : []),
        ...(w.kcal ? [`${Math.round(w.kcal)} kcal`] : []),
        `recorded by ${w.source}.`,
      ].join(", ");
      return db
        .prepare(
          `INSERT INTO workouts (id, user_id, start_at, end_at, kind, confirmed_kind, summary, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'health', ?)
           ON CONFLICT (id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at, kind = excluded.kind, summary = excluded.summary`,
        )
        .bind(workoutId(userId, w.uuid), userId, w.start, w.end, w.type, name, summary, now);
    }),
    ...workouts.flatMap((w) => [
      db
        .prepare(
          `UPDATE workouts SET confirmed_kind = COALESCE((
             SELECT confirmed_kind FROM workouts
              WHERE user_id = ? AND source = 'detected' AND confirmed_kind IS NOT NULL AND start_at < ? AND end_at > ?
              ORDER BY start_at LIMIT 1), confirmed_kind)
           WHERE id = ?`,
        )
        .bind(userId, w.end, w.start, workoutId(userId, w.uuid)),
      db.prepare("DELETE FROM workouts WHERE user_id = ? AND source = 'detected' AND start_at < ? AND end_at > ?").bind(userId, w.end, w.start),
    ]),
  ]);
  if (workouts.length) {
    await fillWorkoutHeart(db, userId, Math.min(...workouts.map((w) => w.start)), Math.max(...workouts.map((w) => w.end)));
  }
  return { stored: body.days.length, workouts: workouts.length };
}

// ---------- Reading it back ----------

type HealthDayRow = {
  day: string;
  active_kcal: number | null;
  exercise_min: number | null;
  stand_hours: number | null;
  resting_hr: number | null;
  hrv_ms: number | null;
  spo2_pct: number | null;
  resp_rate: number | null;
  weight_kg: number | null;
  sleep_json: string | null;
  sources_json: string | null;
  updated_at: number;
};

type WorkoutRow = { start_at: number; end_at: number; kind: string; confirmed_kind: string | null; avg_hr: number | null; source: string };

function parsed<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** A night worth talking about: some sleep, or at least time in bed. */
function sleepOf(row: HealthDayRow | undefined) {
  const sleep = parsed<SleepIn>(row?.sleep_json ?? null);
  return sleep && (sleep.asleepMin > 0 || (sleep.inBedMin ?? 0) > 0) ? sleep : null;
}

/**
 * Everything for the last `n` local days, today included. Readings reach back
 * a whole day at least, so just after midnight there's still a latest one.
 */
async function loadDays(db: D1Database, userId: string, timeZone: string, n: number, now: number, want: { heart: boolean; activity: boolean }) {
  const today = buckets(now, timeZone).day;
  const days = Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
  const [from] = dayRange(days[0], timeZone);
  const [samples, { results: rows }, { results: steps }, { results: workouts }, synced] = await Promise.all([
    want.heart ? samplesSince(db, userId, Math.min(from, now - DAY_MS)) : Promise.resolve([]),
    db
      .prepare(
        `SELECT day, active_kcal, exercise_min, stand_hours, resting_hr, hrv_ms, spo2_pct, resp_rate, weight_kg, sleep_json, sources_json, updated_at
           FROM health_days WHERE user_id = ? AND day >= ? AND day <= ?`,
      )
      .bind(userId, days[0], today)
      .all<HealthDayRow>(),
    want.activity
      ? db.prepare("SELECT day, steps FROM step_days WHERE user_id = ? AND day >= ? AND day <= ?").bind(userId, days[0], today).all<{ day: string; steps: number }>()
      : { results: [] as { day: string; steps: number }[] },
    want.activity
      ? db
          .prepare("SELECT start_at, end_at, kind, confirmed_kind, avg_hr, source FROM workouts WHERE user_id = ? AND start_at >= ? ORDER BY start_at")
          .bind(userId, from)
          .all<WorkoutRow>()
      : { results: [] as WorkoutRow[] },
    db.prepare("SELECT MAX(updated_at) AS at FROM health_days WHERE user_id = ?").bind(userId).first<{ at: number | null }>(),
  ]);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const stepsByDay = new Map(steps.map((s) => [s.day, s.steps]));
  const workoutsOn = (day: string) => {
    const [start, end] = dayRange(day, timeZone);
    return workouts.filter((w) => w.start_at >= start && w.start_at < end);
  };
  return { days, samples, byDay, stepsByDay, workoutsOn, lastSync: synced?.at ?? null };
}

const workoutWords = (w: WorkoutRow) => w.confirmed_kind ?? KIND_WORDS[w.kind] ?? w.kind;

/** GET /health/days: one entry per day, oldest first. */
export type HealthDay = {
  day: string;
  steps: number | null;
  restingBpm: number | null;
  restingFrom: RestingFrom | null;
  heartLow: number | null;
  heartAvg: number | null;
  heartHigh: number | null;
  activeKcal: number | null;
  exerciseMin: number | null;
  standHours: number | null;
  hrvMs: number | null;
  spo2Pct: number | null;
  respRate: number | null;
  weightKg: number | null;
  sleep: SleepIn | null;
  /** from: the workouts row's source, 'detected' | 'health' | 'manual'. */
  workouts: { type: string; start: number; minutes: number; avgBpm?: number; from: string }[];
  /** When the phone last sent Apple Health's numbers for this day. */
  updatedAt: number | null;
};

async function healthDaysFor(db: D1Database, userId: string, timeZone: string, n: number, now = Date.now()): Promise<HealthDay[]> {
  const data = await loadDays(db, userId, timeZone, n, now, { heart: true, activity: true });
  return data.days.map((day) => {
    const row = data.byDay.get(day);
    const heart = dayHeart(data.samples, timeZone, day, row?.resting_hr ?? null, now);
    return {
      day,
      steps: data.stepsByDay.get(day) ?? null,
      restingBpm: heart.restingBpm,
      restingFrom: heart.restingFrom,
      heartLow: heart.low,
      heartAvg: heart.avg,
      heartHigh: heart.high,
      activeKcal: row?.active_kcal ?? null,
      exerciseMin: row?.exercise_min ?? null,
      standHours: row?.stand_hours ?? null,
      hrvMs: row?.hrv_ms ?? null,
      spo2Pct: row?.spo2_pct ?? null,
      respRate: row?.resp_rate ?? null,
      weightKg: row?.weight_kg ?? null,
      sleep: sleepOf(row),
      workouts: data.workoutsOn(day).map((w) => ({
        type: workoutWords(w),
        start: w.start_at,
        minutes: Math.round((w.end_at - w.start_at) / 60_000),
        ...(w.avg_hr && { avgBpm: w.avg_hr }),
        from: w.source,
      })),
      updatedAt: row?.updated_at ?? null,
    };
  });
}

// ---------- What the assistant hears ----------

const ABOUT = ["heart", "sleep", "activity", "body", "all"] as const;
export type HealthAbout = (typeof ABOUT)[number];

const RESTING_WORDS: Record<RestingFrom, string> = {
  apple: "Apple Health",
  band_night: "band, overnight",
  band_low: "band, the day's lowest readings",
};

// Why something asked about isn't there: what would give it, never a guess at it.
const WHY = {
  heart: "no readings: the OVOA Band takes one every few minutes while it's worn",
  resting: "not enough readings yet: wearing the band overnight gives a resting heart rate",
  sleep: "nothing is recording sleep: an Apple Watch or the iPhone's Sleep schedule would",
  steps: "the phone hasn't sent a step count for these days",
  watch: "needs an Apple Watch",
  weight: "nothing logs weight: a smart scale or the Health app would",
  notSynced: "Apple Health hasn't reached OVOA yet: the iPhone sends it when it's unlocked, from the latest OVOA app",
  stale: (ago: string) => `Apple Health numbers are from ${ago}; they update when the iPhone is next unlocked`,
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Tue 22 Sep". Built by hand: en-GB's short September is "Sept" in newer ICU. */
function dayLabel(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "7 h 10 min", "7 h", "45 min". */
export function durationWords(min: number) {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/** "just now", "3 min ago", "5 h ago", "3 days ago". */
export function agoWords(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * health_summary (heart.ts): the slice asked about, as numbers the model puts
 * in its own words, never sentences for it to recite. `missing` covers only
 * that slice, or every answer would list HRV and weight nobody asked about.
 */
export async function healthSummaryFor(
  db: D1Database,
  userId: string,
  timeZone: string,
  args: { about?: unknown; days?: unknown },
  now = Date.now(),
) {
  const about: HealthAbout = (ABOUT as readonly unknown[]).includes(args.about) ? (args.about as HealthAbout) : "all";
  const n = Math.min(14, Math.max(1, Math.round(Number(args.days)) || (about === "heart" || about === "sleep" ? 1 : 7)));
  const wants = (slice: Exclude<HealthAbout, "all">) => about === "all" || about === slice;
  const data = await loadDays(db, userId, timeZone, n, now, { heart: wants("heart"), activity: wants("activity") });

  const days: Record<string, unknown>[] = [];
  const seen = { resting: [] as number[], asleep: [] as number[], steps: [] as number[], activeKcal: [] as number[], exerciseMin: [] as number[], hrv: [] as number[] };
  let spo2 = false;
  let breathing = false;
  let weight = false;
  for (const day of [...data.days].reverse()) {
    const row = data.byDay.get(day);
    const entry: Record<string, unknown> = { day: dayLabel(day) };
    const put = (key: string, value: number | null | undefined, into?: number[]) => {
      if (value == null) return;
      entry[key] = value;
      into?.push(value);
    };
    if (wants("heart")) {
      const heart = dayHeart(data.samples, timeZone, day, row?.resting_hr ?? null, now);
      if (heart.restingFrom) {
        put("restingBpm", heart.restingBpm, seen.resting);
        entry.restingFrom = RESTING_WORDS[heart.restingFrom];
      }
      if (heart.low != null) entry.heartLowHigh = [heart.low, heart.high];
    }
    if (wants("sleep")) {
      const sleep = sleepOf(row);
      if (sleep) {
        if (sleep.asleepMin > 0) seen.asleep.push(sleep.asleepMin);
        entry.sleep = {
          ...(sleep.asleepMin > 0 && { asleep: durationWords(sleep.asleepMin) }),
          bed: clock(sleep.start, timeZone),
          wake: clock(sleep.end, timeZone),
          ...(sleep.stages?.deep != null && { deepMin: Math.round(sleep.stages.deep) }),
          ...(sleep.stages?.rem != null && { remMin: Math.round(sleep.stages.rem) }),
          ...(sleep.inBedMin && { inBed: durationWords(sleep.inBedMin) }),
          from: sleep.source,
        };
      }
    }
    if (wants("activity")) {
      put("steps", data.stepsByDay.get(day), seen.steps);
      put("activeKcal", row?.active_kcal, seen.activeKcal);
      put("exerciseMin", row?.exercise_min, seen.exerciseMin);
      put("standHours", row?.stand_hours);
      const workouts = data.workoutsOn(day);
      if (workouts.length) {
        entry.workouts = workouts.map((w) => {
          const what = workoutWords(w);
          return `${what[0].toUpperCase()}${what.slice(1)}, ${Math.round((w.end_at - w.start_at) / 60_000)} min, ${clock(w.start_at, timeZone)}`;
        });
      }
    }
    if (wants("body")) {
      put("hrvMs", row?.hrv_ms, seen.hrv);
      put("bloodOxygenPct", row?.spo2_pct);
      put("breathsPerMin", row?.resp_rate);
      put("weightKg", row?.weight_kg);
      spo2 ||= row?.spo2_pct != null;
      breathing ||= row?.resp_rate != null;
      weight ||= row?.weight_kg != null;
    }
    if (Object.keys(entry).length > 1) days.push(entry);
  }

  const newest = data.samples.at(-1);
  const heartNow = newest && {
    bpm: newest.bpm,
    ago: agoWords(now - newest.ts),
    from: newest.source === "band" ? "your OVOA Band" : watchName(data.byDay),
  };

  const averages: Record<string, unknown> = {};
  if (n > 1) {
    if (seen.resting.length > 1) averages.restingBpm = mean(seen.resting);
    if (seen.asleep.length > 1) averages.asleep = durationWords(mean(seen.asleep));
    if (seen.steps.length > 1) averages.steps = mean(seen.steps);
    if (seen.activeKcal.length > 1) averages.activeKcal = mean(seen.activeKcal);
    if (seen.exerciseMin.length > 1) averages.exerciseMin = mean(seen.exerciseMin);
    if (seen.hrv.length > 1) averages.hrvMs = mean(seen.hrv);
  }

  // Heart rate and steps are the server's own; the rest waits for the phone to
  // read Health, which it can't while locked. So an Apple Health number that
  // isn't here is first not sent yet, then old, and only then not recorded.
  const syncedAgo = data.lastSync != null && now - data.lastSync > STALE_MS ? agoWords(now - data.lastSync) : null;
  const fromHealth = (reason: string) => (data.lastSync == null ? WHY.notSynced : syncedAgo ? WHY.stale(syncedAgo) : reason);
  // Fields that share a reason share a line: "hrvMs, bloodOxygenPct: needs an Apple Watch".
  const why = new Map<string, string[]>();
  const miss = (field: string, reason: string) => why.set(reason, [...(why.get(reason) ?? []), field]);
  if (wants("heart")) {
    if (!newest && !seen.resting.length) miss("heart", WHY.heart);
    else if (!seen.resting.length) miss("restingBpm", WHY.resting);
  }
  if (wants("sleep") && !days.some((d) => d.sleep)) miss("sleep", fromHealth(WHY.sleep));
  if (wants("activity")) {
    if (!seen.steps.length) miss("steps", WHY.steps);
    if (!seen.activeKcal.length) miss("activeKcal", fromHealth(WHY.watch));
    if (!seen.exerciseMin.length) miss("exerciseMin", fromHealth(WHY.watch));
  }
  if (wants("body")) {
    if (!seen.hrv.length) miss("hrvMs", fromHealth(WHY.watch));
    if (!spo2) miss("bloodOxygenPct", fromHealth(WHY.watch));
    if (!breathing) miss("breathsPerMin", fromHealth(WHY.watch));
    if (!weight) miss("weightKg", fromHealth(WHY.weight));
  }
  const missing = Object.fromEntries([...why].map(([reason, fields]) => [fields.join(", "), reason]));

  return {
    ...(heartNow && { heartNow }),
    days,
    ...(Object.keys(averages).length && { averages }),
    ...(why.size && { missing }),
    ...(about !== "heart" && syncedAgo && { healthSyncedAgo: syncedAgo }),
  };
}

/** What a 'health' heart reading came from, as the phone named it: "Sam's Apple Watch". Never OVOA itself, which saves the band's there. */
function watchName(byDay: Map<string, HealthDayRow>) {
  for (const row of [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day))) {
    const name = parsed<{ heart?: string[] }>(row.sources_json)?.heart?.find((s) => !/ovoa/i.test(s));
    if (name) return name;
  }
  return "Apple Health";
}

// ---------- Routes ----------

export const healthDays = new Hono<{ Bindings: Env; Variables: Vars }>();

healthDays.put("/health/days", async (c) => {
  const body = healthDaysSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid health data" }, 400);
  const { userId } = c.var;
  // Heart rate goes to hr_samples for everyone, as it always has. These numbers
  // serve only the assistant, so they're kept only for someone who agreed to
  // it (the health plan, 2026-09-23); the phone stops sending on this answer.
  if ((await aiConsentFor(c.env, userId)) !== "given") return c.json({ stored: 0, skipped: "no_ai_consent" });
  return c.json(await storeHealthDays(c.env.DB, userId, await timeZoneOf(c.env.DB, userId), body.data));
});

healthDays.get("/health/days", async (c) => {
  const n = Math.min(14, Math.max(1, Math.round(Number(c.req.query("days"))) || 7));
  const { userId } = c.var;
  return c.json({ days: await healthDaysFor(c.env.DB, userId, await timeZoneOf(c.env.DB, userId), n) });
});

healthDays.get("/hr/day", async (c) => {
  const db = c.env.DB;
  const { userId } = c.var;
  const timeZone = await timeZoneOf(db, userId);
  const now = Date.now();
  const day = c.req.query("day") ?? buckets(now, timeZone).day;
  if (!isDay(day)) return c.json({ error: "day is YYYY-MM-DD" }, 400);
  const [from, to] = dayRange(day, timeZone);
  const [samples, apple] = await Promise.all([
    samplesSince(db, userId, from, to),
    db.prepare("SELECT resting_hr FROM health_days WHERE user_id = ? AND day = ?").bind(userId, day).first<{ resting_hr: number | null }>(),
  ]);
  return c.json(dayHeart(samples, timeZone, day, apple?.resting_hr ?? null, now));
});
