import type { HealthDay, HeartDay, SleepNight } from "./api";
import type { TodayHealth } from "./health";

// What the Activity screen shows about heart rate, sleep and the body, worked
// out from the server's day (GET /hr/day, GET /health/days) and from Apple
// Health on the phone. Kept apart from the components so it can be checked
// without a phone (api/test/healthView.test.ts).

export type Reading = { ts: number; bpm: number };

/** A reading older than this is greyed out: it's where heart rate was, not where it is. */
export const STALE_MIN = 20;

/** The same range lib/heart.ts keeps: anything outside it is the Band misreading. */
export const plausibleBpm = (bpm: number) => bpm >= 30 && bpm <= 230;

export type HeartView = {
  latest: { ts: number; bpm: number; source: string } | null;
  low: number | null;
  avg: number | null;
  high: number | null;
  count: number;
  restingBpm: number | null;
  restingFrom: string | null;
  raisedMin: number;
  /** Oldest first: the server's 5-minute medians, then anything newer heard on the phone. */
  points: Reading[];
};

/**
 * The server's day with the Band readings it hasn't got yet laid over it: the
 * unsent batch (lib/heart.ts pendingBand) and readings heard while the screen
 * is open. The phone sends the Band's readings five at a time or every ten
 * minutes, so without this a "Measure now" wouldn't show until the next batch
 * went up. Only readings newer than the server's latest count (anything older
 * is already there) and only since `since`, local midnight. A reading the card
 * heard itself is stamped a few milliseconds after the copy lib/heart.ts sent,
 * so once the server has that one it would pass as newer: a reading that
 * matches the server's latest (sameReading) is the server's.
 */
export function heartView(day: HeartDay, local: Reading[], since: number): HeartView {
  const base: HeartView = {
    latest: day.latest ? { ts: day.latest.ts, bpm: day.latest.bpm, source: day.latest.source } : null,
    low: day.low ?? null,
    avg: day.avg ?? null,
    high: day.high ?? null,
    count: day.count,
    restingBpm: day.restingBpm ?? null,
    restingFrom: day.restingFrom ?? null,
    raisedMin: day.raisedMin ?? 0,
    points: day.points,
  };
  const { latest } = day;
  const after = Math.max(since, latest?.ts ?? 0);
  const fresh = distinct(local.filter((r) => r.ts > after && plausibleBpm(r.bpm) && !(latest && sameReading(r, latest))));
  if (!fresh.length) return base;

  const bpms = fresh.map((r) => r.bpm);
  const newest = fresh[fresh.length - 1];
  const sum = bpms.reduce((a, b) => a + b, 0);
  const count = base.count + fresh.length;
  return {
    ...base,
    latest: { ts: newest.ts, bpm: newest.bpm, source: "band" },
    low: Math.min(base.low ?? Infinity, ...bpms),
    high: Math.max(base.high ?? -Infinity, ...bpms),
    avg: Math.round(base.avg === null ? sum / fresh.length : (base.avg * base.count + sum) / count),
    count,
    points: [...base.points, ...fresh],
  };
}

/**
 * The same reading, arrived twice: from the unsent batch or the server, and
 * from the card's own listener, stamped a few milliseconds apart. The Band is
 * asked once a minute at most, so the same bpm within 5 s is one reading.
 */
const sameReading = (a: Reading, b: Reading) => Math.abs(a.ts - b.ts) < 5_000 && a.bpm === b.bpm;

/** Oldest first, one per reading (sameReading). */
function distinct(readings: Reading[]): Reading[] {
  const out: Reading[] = [];
  for (const r of [...readings].sort((a, b) => a.ts - b.ts)) {
    const last = out[out.length - 1];
    if (last && sameReading(r, last)) continue;
    out.push(r);
  }
  return out;
}

/**
 * At most `max` points for the day's line, each the average of an even run of
 * readings, ending on the latest reading itself. A whole day is up to 288
 * five-minute points, and DrawnLine hides whatever of its path runs past three
 * times its width (its dash trick), so a jagged full day lost its newest end.
 */
export function evenOut(points: Reading[], max: number): Reading[] {
  if (points.length <= max) return points;
  const out: Reading[] = [];
  for (let i = 0; i < max; i++) {
    const run = points.slice(Math.floor((i * points.length) / max), Math.floor(((i + 1) * points.length) / max));
    out.push({ ts: run[run.length - 1].ts, bpm: Math.round(run.reduce((a, p) => a + p.bpm, 0) / run.length) });
  }
  out[out.length - 1] = points[points.length - 1];
  return out;
}

/** Where the latest reading came from, as the card says it. */
export const readingFrom = (source: string) => (source === "health" ? "Apple Health" : "your OVOA Band");

/** How the server worked out resting heart rate (api/src/healthdays.ts restingForDay). */
export const RESTING_FROM: Record<string, string> = {
  apple: "from Apple Health",
  band_night: "overnight",
  band_low: "your lowest",
};

/** Resting heart rate for each day, oldest first, for the week's bars. Null where there was none. */
export function restingWeek(days: HealthDay[]): { day: string; bpm: number | null }[] {
  return [...days].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ day: d.day, bpm: d.restingBpm ?? null }));
}

/**
 * "Last 7 days": average sleep, resting heart rate and steps, each over the
 * days that have it, and only once two days do — one day isn't a week.
 * Today's steps are left out: the day isn't over, and a morning's count would
 * drag the average down.
 */
export function weekAverages(days: HealthDay[], today: string) {
  const mean = (values: (number | null | undefined)[]) => {
    const have = values.filter((v): v is number => typeof v === "number" && v > 0);
    return have.length >= 2 ? Math.round(have.reduce((a, b) => a + b, 0) / have.length) : null;
  };
  return {
    sleepMin: mean(days.map((d) => d.sleep?.asleepMin)),
    restingBpm: mean(days.map((d) => d.restingBpm)),
    steps: mean(days.filter((d) => d.day !== today).map((d) => d.steps)),
  };
}

/** "7 h 10 min", "8 h", "45 min". */
export function hoursMinutes(min: number) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** "12 min ago", for how fresh a reading is; a clock time once it's a day old. */
export function ago(at: number, now = Date.now()) {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : clock(at);
}

// ---------- Sleep & body ----------

/** One tile's worth of each number; a number that's missing has no tile. */
export type Body = {
  /** Last night (healthMath.ts sleepNight), from the phone or as the server kept it. */
  sleep?: SleepNight;
  hrvMs?: number;
  spo2Pct?: number;
  respRate?: number;
  weightKg?: number;
  activeKcal?: number;
  exerciseMin?: number;
  standHours?: number;
  workouts: { type: string; start: number; minutes?: number; energy?: string; distance?: string; avgBpm?: number }[];
};

const num = (n: number | null | undefined) => (typeof n === "number" ? n : undefined);
/** A night with neither sleep nor time in bed in it is no night. */
const night = (s: SleepNight | null | undefined) => (s && (s.asleepMin > 0 || (s.inBedMin ?? 0) > 0) ? s : undefined);

/** Today, read from Apple Health on the phone. */
export function bodyFromPhone(t: TodayHealth): Body {
  return {
    sleep: night(t.sleep),
    hrvMs: num(t.hrvMs),
    spo2Pct: num(t.spo2Pct),
    respRate: num(t.respRate),
    weightKg: num(t.weightKg),
    activeKcal: num(t.activeEnergyKcal),
    exerciseMin: num(t.exerciseMinutes),
    standHours: num(t.standHours),
    workouts: t.workouts,
  };
}

/** A day as the server last heard it from the phone, for when Apple Health can't be read. */
export function bodyFromServer(d: HealthDay): Body {
  return {
    sleep: night(d.sleep),
    hrvMs: num(d.hrvMs),
    spo2Pct: num(d.spo2Pct),
    respRate: num(d.respRate),
    weightKg: num(d.weightKg),
    activeKcal: num(d.activeKcal),
    exerciseMin: num(d.exerciseMin),
    standHours: num(d.standHours),
    workouts: d.workouts.map((w) => ({ type: w.type, start: w.start, minutes: w.minutes, avgBpm: w.avgBpm })),
  };
}

export const hasBody = (b: Body) =>
  !!(b.sleep || b.workouts.length) ||
  [b.hrvMs, b.spo2Pct, b.respRate, b.weightKg, b.activeKcal, b.exerciseMin, b.standHours].some((n) => n !== undefined);

/** Sleep stages as shares of the night, deepest first, for the stage bar. Empty when nothing recorded stages. */
export function stageBar(stages?: SleepNight["stages"]) {
  const order = ["deep", "core", "rem", "awake"] as const;
  const parts = order.map((stage) => ({ stage, min: Math.max(0, stages?.[stage] ?? 0) })).filter((p) => p.min > 0);
  const total = parts.reduce((a, p) => a + p.min, 0);
  return total ? parts.map((p) => ({ ...p, share: p.min / total })) : [];
}

/** At most one line under the tiles: what's switched off, or else what a watch would add. */
export function healthHint(body: Body, cantRead: boolean): "cant_read" | "watch" | null {
  if (cantRead) return "cant_read";
  return !body.sleep && body.hrvMs === undefined ? "watch" : null;
}
