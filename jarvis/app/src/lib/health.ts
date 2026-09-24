import type { QueryStatisticsResponse } from "@kingstinct/react-native-healthkit/types";
import { isRunningInExpoGo } from "expo";
import { Platform } from "react-native";
import type { HealthDayIn, HealthWorkoutIn, SleepNight } from "./api";
import { devlog, logFail } from "./devlog";
import { dayKey, daysBetween, localTime, nightSamples, sleepNight, sourceLabel, thinReadings, type SleepSample } from "./healthMath";
import { storage } from "./storage";

/**
 * Apple Health. HealthKit is a native module that Expo Go doesn't include, so
 * the library is only loaded in a development build of OVOA.
 *
 * OVOA reads it, and since 2026-09-23 writes one thing to it: the heart rate
 * the OVOA Band measures. The phone in the logs had steps in Health and no
 * heart rate or sleep at all — nothing there writes them, and the Band's
 * readings only went to OVOA's server (device_logs, 2026-09-21 23:32).
 */

type HealthKitModule = typeof import("@kingstinct/react-native-healthkit");
type HealthKitTypes = typeof import("@kingstinct/react-native-healthkit/types");

export const healthAvailable = Platform.OS === "ios" && !isRunningInExpoGo();

function healthKit(): HealthKitModule {
  if (!healthAvailable) {
    throw new Error("Apple Health needs the installed OVOA app (a development build), not Expo Go.");
  }
  // Loaded lazily: importing it at the top would crash Expo Go.
  return require("@kingstinct/react-native-healthkit");
}

const hkTypes = (): HealthKitTypes => require("@kingstinct/react-native-healthkit/types");

const HEART = "HKQuantityTypeIdentifierHeartRate";

/** What builds up to 67 asked to read. A phone that answered for these was asked (healthAsked). */
const READ_V1 = [
  "HKQuantityTypeIdentifierStepCount",
  HEART,
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierAppleExerciseTime",
  "HKQuantityTypeIdentifierAppleStandTime",
  "HKCategoryTypeIdentifierSleepAnalysis",
  "HKWorkoutTypeIdentifier",
] as const;

const READ = [
  ...READ_V1,
  "HKQuantityTypeIdentifierOxygenSaturation",
  "HKQuantityTypeIdentifierRespiratoryRate",
  "HKQuantityTypeIdentifierBodyMass",
] as const;

/** Written: the Band's heart rate, and nothing else. */
const SHARE = [HEART] as const;

/** Set once the Health sheet has been shown on this phone. A phone fact, so sign-out keeps it. */
const ASKED_KEY = "ovoa.healthAsked";

/** Heart rate from Health comes in pages this size, at most this many a sync; the rest waits for the next. */
const HEART_PAGE = 2000;
const HEART_PAGES = 5;
/** One reading per this long reaches the server: a watch writes every few seconds through a workout. */
const HEART_GAP_MS = 30_000;
/** How far back anything is read: what the server keeps (docs/retention.md). */
const KEEP_DAYS = 14;

const round = (n: number | undefined, digits = 0) =>
  n === undefined ? undefined : Math.round(n * 10 ** digits) / 10 ** digits;

const withUnit = (q?: { quantity: number; unit: string }) => (q ? `${round(q.quantity, 1)} ${q.unit}` : undefined);

/**
 * HealthKit refuses every read while the iPhone is locked: Code=6, "Protected
 * health data is inaccessible" (the /chat/resume body in device_logs,
 * 2026-09-21 23:31:51).
 */
export const lockedHealthError = (err: unknown) =>
  /Code=6\b|Protected health data is inaccessible/i.test(err instanceof Error ? err.message : String(err));

/** The iPhone is locked, so Health can't be read until it's unlocked. */
export async function healthLocked() {
  if (!healthAvailable) return false;
  return !(await healthKit().isProtectedDataAvailableAsync());
}

/** Sleep samples between two times, in sleepNight's shape. */
async function sleepSamples(from: Date, to: Date): Promise<SleepSample[]> {
  const rows = await healthKit().queryCategorySamples("HKCategoryTypeIdentifierSleepAnalysis", {
    filter: { date: { startDate: from, endDate: to } },
    limit: 0,
  });
  return rows.map((s) => ({
    start: new Date(s.startDate).getTime(),
    end: new Date(s.endDate).getTime(),
    value: Number(s.value),
    source: sourceLabel(s.sourceRevision.source, s.sourceRevision.productType),
  }));
}

/** Per-day statistics, keyed by local day. */
const byDay = (rows: readonly QueryStatisticsResponse[]) =>
  new Map(rows.filter((r) => r.startDate).map((r) => [dayKey(new Date(r.startDate as Date)), r]));

/** Per-day steps, heart rate, sleep, and energy, plus workouts, for the last `days` days. */
export async function healthSummary({ days = 7 }: { days?: number }) {
  const hk = healthKit();
  const count = Math.min(Math.max(days, 1), 14);
  if ((await healthPermission()) !== "ok") throw new Error("Apple Health isn't available on this device.");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today.getTime() - (count - 1) * 86400_000);
  const now = new Date();

  const perDay = [];
  for (let i = 0; i < count; i++) {
    const startDate = new Date(from.getTime() + i * 86400_000);
    const endDate = new Date(Math.min(startDate.getTime() + 86400_000, now.getTime()));
    const filter = { date: { startDate, endDate } };
    const [steps, heart, resting, energy] = await Promise.all([
      hk.queryStatisticsForQuantity("HKQuantityTypeIdentifierStepCount", ["cumulativeSum"], { filter }),
      hk.queryStatisticsForQuantity(HEART, ["discreteAverage", "discreteMin", "discreteMax"], { filter, unit: "count/min" }),
      hk.queryStatisticsForQuantity("HKQuantityTypeIdentifierRestingHeartRate", ["discreteAverage"], {
        filter,
        unit: "count/min",
      }),
      hk.queryStatisticsForQuantity("HKQuantityTypeIdentifierActiveEnergyBurned", ["cumulativeSum"], {
        filter,
        unit: "kcal",
      }),
    ]);
    perDay.push({
      day: dayKey(startDate),
      steps: round(steps.sumQuantity?.quantity),
      heartRateAvg: round(heart.averageQuantity?.quantity),
      heartRateMin: round(heart.minimumQuantity?.quantity),
      heartRateMax: round(heart.maximumQuantity?.quantity),
      restingHeartRate: round(resting.averageQuantity?.quantity),
      activeEnergyKcal: round(energy.sumQuantity?.quantity),
      sleepHours: undefined as number | undefined,
      inBedHours: undefined as number | undefined,
    });
  }

  // Last night's sleep belongs to today (healthMath.ts sleepNight).
  const sleep = await sleepSamples(localTime(dayKey(from), -1, 18), now);
  for (const d of perDay) {
    const night = sleepNight(sleep, d.day);
    d.sleepHours = night?.asleepMin ? round(night.asleepMin / 60, 1) : undefined;
    d.inBedHours = !night?.asleepMin && night?.inBedMin ? round(night.inBedMin / 60, 1) : undefined;
  }

  const workouts = await hk.queryWorkoutSamples({ filter: { date: { startDate: from, endDate: now } }, limit: 30 });
  const { WorkoutActivityType } = hkTypes();

  return {
    days: perDay,
    workouts: workouts.map((w) => ({
      type: WorkoutActivityType[w.workoutActivityType] ?? String(w.workoutActivityType),
      start: new Date(w.startDate).toISOString(),
      minutes: round(new Date(w.endDate).getTime() / 60000 - new Date(w.startDate).getTime() / 60000),
      energy: withUnit(w.totalEnergyBurned),
      distance: withUnit(w.totalDistance),
    })),
    note: "Missing values mean Apple Health has no data for that day. inBedHours is time in bed with no sleep recorded, not sleep.",
  };
}

// ---------- Sync (healthSync.ts) ----------
//
// Health's numbers go to the server so the assistant can answer with the phone
// locked, when HealthKit refuses every read. The day numbers are what's asked
// about; heart rate goes up reading by reading, where the server merges it with
// the Band's.

/** Source names in words, OVOA's own left out: it can always read back what it wrote, whatever reading is set to. */
const labels = (sources: readonly { name: string; bundleIdentifier: string }[] | undefined, own: string) => [
  ...new Set((sources ?? []).filter((s) => s.bundleIdentifier !== own).map((s) => sourceLabel(s))),
];

/** Apple Health's step count for each day from `from` to `to`, with what counted them. Health merges the iPhone's and a watch's without counting twice. */
export async function stepDays(from: string, to: string) {
  const hk = healthKit();
  const start = localTime(from);
  const own = hk.currentAppSource().bundleIdentifier;
  const rows = byDay(
    await hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierStepCount", ["cumulativeSum"], start, { day: 1 }, {
      unit: "count",
      filter: { date: { startDate: start, endDate: new Date(Math.min(localTime(to, 1).getTime(), Date.now())) } },
    }),
  );
  return daysBetween(from, to).map((day) => ({
    day,
    steps: Math.round(rows.get(day)?.sumQuantity?.quantity ?? 0),
    sources: labels(rows.get(day)?.sources, own),
  }));
}

/**
 * Apple Health's numbers for each local day from `from` to `to`: one
 * statistics query per type across the whole range, the nights of sleep, and
 * the workouts that started in it. Throws only when nothing could be read (a
 * locked phone); a type that fails on its own is logged and left out.
 */
export async function healthDays(from: string, to: string) {
  const hk = healthKit();
  const start = localTime(from);
  const end = new Date(Math.min(localTime(to, 1).getTime(), Date.now()));
  const own = hk.currentAppSource().bundleIdentifier;
  const filter = { date: { startDate: start, endDate: end } };
  const daily = { day: 1 };

  const failures: unknown[] = [];
  const soft = <T,>(read: Promise<T>, empty: T) =>
    read.catch((err: unknown) => {
      failures.push(err);
      return empty;
    });
  const none: readonly QueryStatisticsResponse[] = [];

  const [steps, energy, exercise, stand, resting, hrv, spo2, breathing, weight, heart, sleep, workouts] = await Promise.all([
    soft(stepDays(from, to), []),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierActiveEnergyBurned", ["cumulativeSum"], start, daily, { unit: "kcal", filter }), none),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierAppleExerciseTime", ["cumulativeSum"], start, daily, { unit: "min", filter }), none),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierAppleStandTime", ["cumulativeSum"], start, daily, { unit: "min", filter }), none),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierRestingHeartRate", ["discreteAverage"], start, daily, { unit: "count/min", filter }), none),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", ["discreteAverage"], start, daily, { unit: "ms", filter }), none),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierOxygenSaturation", ["discreteAverage"], start, daily, { unit: "%", filter }), none),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierRespiratoryRate", ["discreteAverage"], start, daily, { unit: "count/min", filter }), none),
    soft(hk.queryStatisticsCollectionForQuantity("HKQuantityTypeIdentifierBodyMass", ["mostRecent"], start, daily, { unit: "kg", filter }), none),
    // Only for what wrote it: the numbers come from the readings themselves, on the server.
    soft(hk.queryStatisticsCollectionForQuantity(HEART, ["discreteMax"], start, daily, { unit: "count/min", filter }), none),
    soft(sleepSamples(localTime(from, -1, 18), end), []),
    soft(hk.queryWorkoutSamples({ filter, limit: 100 }), []),
  ]);
  const locked = failures.find(lockedHealthError);
  if (locked || failures.length === 12) throw locked ?? failures[0];
  if (failures.length) devlog("warn", `Apple Health: ${failures.length} of 12 reads failed`, String(failures[0]));

  const [E, X, S, R, V, O, B, W, H] = [energy, exercise, stand, resting, hrv, spo2, breathing, weight, heart].map(byDay);
  const stepsOn = new Map(steps.map((s) => [s.day, s]));

  const days: HealthDayIn[] = daysBetween(from, to).map((day) => {
    const night = sleepNight(sleep, day);
    const spo2Fraction = O.get(day)?.averageQuantity?.quantity;
    const standMin = S.get(day)?.sumQuantity?.quantity;
    return {
      day,
      activeKcal: round(E.get(day)?.sumQuantity?.quantity),
      exerciseMin: round(X.get(day)?.sumQuantity?.quantity),
      standHours: standMin === undefined ? undefined : Math.round(standMin / 60),
      restingHr: round(R.get(day)?.averageQuantity?.quantity),
      hrvMs: round(V.get(day)?.averageQuantity?.quantity),
      // HealthKit's "%" is a fraction: 0.97.
      spo2Pct: spo2Fraction === undefined ? undefined : round(spo2Fraction * 100, 1),
      respRate: round(B.get(day)?.averageQuantity?.quantity, 1),
      weightKg: round(W.get(day)?.mostRecentQuantity?.quantity, 1),
      sleep: night ?? undefined,
      sources: {
        heart: labels(H.get(day)?.sources, own),
        sleep: [...new Set(nightSamples(sleep, day).map((s) => s.source))],
        steps: stepsOn.get(day)?.sources ?? [],
      },
    };
  });

  const { WorkoutActivityType } = hkTypes();
  const workoutsIn: HealthWorkoutIn[] = workouts
    .filter((w) => new Date(w.startDate).getTime() >= start.getTime())
    .map((w) => ({
      uuid: w.uuid,
      type: WorkoutActivityType[w.workoutActivityType] ?? `workout ${w.workoutActivityType}`,
      start: new Date(w.startDate).getTime(),
      end: new Date(w.endDate).getTime(),
      kcal: round(w.totalEnergyBurned?.quantity),
      distanceM: round(w.totalDistance?.quantity),
      source: sourceLabel(w.sourceRevision.source, w.sourceRevision.productType),
    }));

  const every = (rows: readonly QueryStatisticsResponse[]) => rows.flatMap((r) => labels(r.sources, own));
  return {
    days,
    /** Only days Health has steps for: the Pedometer (Steps.tsx) speaks for the rest. */
    steps: steps.filter((s) => s.sources.length).map(({ day, steps }) => ({ day, steps })),
    workouts: workoutsIn,
    sources: {
      heart: [...new Set(days.flatMap((d) => d.sources?.heart ?? []))],
      sleep: [...new Set(sleep.map((s) => s.source))],
      steps: [...new Set(steps.flatMap((s) => s.sources))],
      /** Everything but OVOA that answered at all: whether Health can be read (healthMath.ts readsVerdict). */
      any: [
        ...new Set([
          ...[energy, exercise, stand, resting, hrv, spo2, breathing, weight, heart].flatMap(every),
          ...steps.flatMap((s) => s.sources),
          ...sleep.map((s) => s.source),
          ...workoutsIn.map((w) => w.source),
        ]),
      ],
    },
  };
}

/**
 * Heart rate that anything but OVOA (a watch) wrote to Health since `anchor`,
 * thinned, with the anchor to carry on from. An anchor, not the newest reading's
 * time: a watch syncs late, with readings older than ones already sent, and a
 * time mark skipped those for good (lib/heart.ts before 2026-09-23). Pages come
 * in the order Health stored them, so they're sorted before thinning.
 */
export async function heartSince(anchor: string | null) {
  const hk = healthKit();
  const own = hk.currentAppSource().bundleIdentifier;
  const startDate = new Date(Date.now() - KEEP_DAYS * 86_400_000);
  const readings: { ts: number; bpm: number }[] = [];
  const sources = new Set<string>();
  let next = anchor ?? undefined;
  for (let page = 0; page < HEART_PAGES; page++) {
    const got = await hk.queryQuantitySamplesWithAnchor(HEART, {
      anchor: next,
      limit: HEART_PAGE,
      unit: "count/min",
      filter: { date: { startDate } },
    });
    next = got.newAnchor;
    for (const s of got.samples) {
      // OVOA's own: the Band's readings saved to Health, already on the server as 'band'.
      if (s.sourceRevision.source.bundleIdentifier === own) continue;
      readings.push({ ts: new Date(s.endDate).getTime(), bpm: Math.round(s.quantity) });
      sources.add(sourceLabel(s.sourceRevision.source, s.sourceRevision.productType));
    }
    if (got.samples.length < HEART_PAGE) break;
  }
  return { readings: thinReadings(readings, HEART_GAP_MS), anchor: next ?? null, sources: [...sources] };
}

/** Whether the Band's heart rate may be saved to Health. iOS does say this one, unlike reading. */
export function heartWriteAccess(): "on" | "off" | "not_asked" {
  if (!healthAvailable) return "off";
  try {
    const { AuthorizationStatus } = hkTypes();
    const status = healthKit().authorizationStatusFor(HEART);
    if (status === AuthorizationStatus.sharingAuthorized) return "on";
    return status === AuthorizationStatus.sharingDenied ? "off" : "not_asked";
  } catch {
    return "not_asked";
  }
}

/**
 * Saves one Band reading to Health as heart rate. The sync identifier makes a
 * second save of the same reading replace the first instead of adding to it,
 * so a retry can't double one. Its keys are HealthKit's raw strings for
 * HKMetadataKeySyncIdentifier and HKMetadataKeySyncVersion (the library's
 * healthkit-schema.json, rawKey). False when Health didn't keep it; throws with
 * HealthKit's reason. Check heartWriteAccess first.
 */
export async function saveBandHeartRate(r: { ts: number; bpm: number }) {
  const at = new Date(r.ts);
  const saved = await healthKit().saveQuantitySample(HEART, "count/min", r.bpm, at, at, {
    HKSyncIdentifier: `ovoa-band-hr-${r.ts}`,
    HKSyncVersion: 1,
  });
  return !!saved;
}

/** Changes to these start a sync. */
const OBSERVED = [
  HEART,
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKCategoryTypeIdentifierSleepAnalysis",
  "HKWorkoutTypeIdentifier",
] as const;

/**
 * Calls `onChange` when Health gets new heart rate, sleep or a workout, and
 * lets Health wake the app for them in the background. iOS decides how often;
 * hourly is what it honours for these. OVOA's own Band saves fire it too, so
 * whatever it starts has to be cheap to turn away (healthSync.ts).
 */
export async function observeHealth(onChange: () => void) {
  if (!healthAvailable) return () => {};
  const hk = healthKit();
  // First, and awaited: configuring tears down the native observers with every callback on them.
  await hk.configureBackgroundTypes([...OBSERVED], hkTypes().UpdateFrequency.hourly).catch(() => false);
  const subs = OBSERVED.map((id) => hk.subscribeToChanges(id, () => onChange()));
  return () => subs.forEach((s) => s.remove());
}

// ---------- The Activity tab ----------
//
// healthSummary() above answers questions ("how did I sleep?"); what follows
// feeds the Activity tab, which wants today at a glance and cheap enough to
// reload every time the tab is opened.

export type HeartPoint = { at: number; bpm: number };

export type TodayHealth = {
  /** The most recent heart rate in Health, whenever it was taken (the Band's too, once saved there). */
  heartRate?: { bpm: number; at: number };
  /** Readings over the last `HEART_WINDOW_HOURS`, oldest first, for the workouts' graphs. */
  heart: HeartPoint[];
  activeEnergyKcal?: number;
  exerciseMinutes?: number;
  standHours?: number;
  /** Last night: sleep that ended since 18:00 yesterday. */
  sleep?: SleepNight;
  /** Heart-rate variability (SDNN, ms), today's average. */
  hrvMs?: number;
  /** Blood oxygen (%) and breathing rate (per minute) over the last 24 hours: a watch measures them overnight. */
  spo2Pct?: number;
  respRate?: number;
  /** The most recent weight in the last 30 days. */
  weightKg?: number;
  /** Today's workouts, most recent first. */
  workouts: { type: string; start: number; minutes?: number; energy?: string; distance?: string }[];
};

/** How far back the heart-rate readings reach. */
const HEART_WINDOW_HOURS = 12;
/** Readings are thinned to this many points, so the graph stays cheap to draw. */
const HEART_POINTS = 48;

/**
 * The Health sheet has been shown on this phone (the permissions screen after
 * sign-up, or Activity), so reading now shows no prompt. What runs by itself
 * (healthSync.ts) checks this first: "Not now" on the permissions screen means
 * not at the next launch either. False when it can't be told.
 *
 * Not only iOS's "nothing left to ask" for today's list: adding a type turns
 * that back to "ask", and background heart sync used to stop by itself until
 * Activity was opened. A phone that answered for the list builds up to 67
 * asked for counts as asked (2026-09-23).
 */
export async function healthAsked(): Promise<boolean> {
  if (!healthAvailable) return false;
  if ((await storage.get(ASKED_KEY).catch(() => null)) === "1") return true;
  try {
    const hk = healthKit();
    const { AuthorizationRequestStatus } = hkTypes();
    const [before, now] = await Promise.all([
      hk.getRequestStatusForAuthorization({ toRead: READ_V1 }),
      hk.getRequestStatusForAuthorization({ toRead: READ, toShare: SHARE }),
    ]);
    return before === AuthorizationRequestStatus.unnecessary || now === AuthorizationRequestStatus.unnecessary;
  } catch {
    return false;
  }
}

/** The sheet has something new to ask (blood oxygen, weight, saving the Band's heart rate). Activity asks it. */
export async function needsHealthPrompt() {
  if (!healthAvailable) return false;
  try {
    const status = await healthKit().getRequestStatusForAuthorization({ toRead: READ, toShare: SHARE });
    return status === hkTypes().AuthorizationRequestStatus.shouldRequest;
  } catch {
    return false;
  }
}

/**
 * Asks for Health access once, and says whether it can be read. Returns
 * "unavailable" in Expo Go and on any device without HealthKit.
 *
 * iOS never reports whether reading was allowed (that would leak what the user
 * has), so a granted-looking result with no data is normal.
 */
export async function healthPermission(): Promise<"ok" | "unavailable"> {
  if (!healthAvailable) return "unavailable";
  const hk = healthKit();
  if (!(await hk.isHealthDataAvailableAsync())) return "unavailable";
  await hk.requestAuthorization({ toRead: READ, toShare: SHARE });
  await storage.set(ASKED_KEY, "1").catch(logFail("health: storage.set"));
  return "ok";
}

/** Everything the Activity tab shows about today. Throws if Health isn't available. */
export async function todayHealth(): Promise<TodayHealth> {
  const hk = healthKit();
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = { filter: { date: { startDate: midnight, endDate: now } } };
  const lastDay = { filter: { date: { startDate: new Date(now.getTime() - 86400_000), endDate: now } } };
  const windowStart = new Date(Math.max(now.getTime() - HEART_WINDOW_HOURS * 3600_000, midnight.getTime() - 86400_000));

  const [energy, exercise, stand, hrv, spo2, breathing, weight, recent, sleep, workouts] = await Promise.all([
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierActiveEnergyBurned", ["cumulativeSum"], {
        ...today,
        unit: "kcal",
      })
      .catch(() => null),
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierAppleExerciseTime", ["cumulativeSum"], {
        ...today,
        unit: "min",
      })
      .catch(() => null),
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierAppleStandTime", ["cumulativeSum"], { ...today, unit: "min" })
      .catch(() => null),
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", ["discreteAverage"], {
        ...today,
        unit: "ms",
      })
      .catch(() => null),
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierOxygenSaturation", ["discreteAverage"], { ...lastDay, unit: "%" })
      .catch(() => null),
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierRespiratoryRate", ["discreteAverage"], {
        ...lastDay,
        unit: "count/min",
      })
      .catch(() => null),
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierBodyMass", ["mostRecent"], {
        filter: { date: { startDate: new Date(now.getTime() - 30 * 86400_000), endDate: now } },
        unit: "kg",
      })
      .catch(() => null),
    hk
      .queryQuantitySamples(HEART, {
        filter: { date: { startDate: windowStart, endDate: now } },
        unit: "count/min",
        limit: 400,
        ascending: false,
      })
      .catch(() => []),
    sleepSamples(localTime(dayKey(now), -1, 18), now).catch(() => []),
    hk.queryWorkoutSamples({ ...today, limit: 10 }).catch(() => []),
  ]);

  // Newest first from HealthKit; the graph wants oldest first.
  const points: HeartPoint[] = [...recent]
    .map((s) => ({ at: new Date(s.endDate).getTime(), bpm: Math.round(s.quantity) }))
    .sort((a, b) => a.at - b.at);

  const workoutTypes = (() => {
    try {
      return hkTypes().WorkoutActivityType;
    } catch {
      return undefined;
    }
  })();

  const latest = points.at(-1);
  const spo2Fraction = spo2?.averageQuantity?.quantity;
  return {
    heartRate: latest ? { bpm: latest.bpm, at: latest.at } : undefined,
    heart: thin(points, HEART_POINTS),
    activeEnergyKcal: round(energy?.sumQuantity?.quantity),
    exerciseMinutes: round(exercise?.sumQuantity?.quantity),
    standHours: stand?.sumQuantity?.quantity ? round(stand.sumQuantity.quantity / 60) : undefined,
    sleep: sleepNight(sleep, dayKey(now)) ?? undefined,
    hrvMs: round(hrv?.averageQuantity?.quantity),
    spo2Pct: spo2Fraction === undefined ? undefined : round(spo2Fraction * 100, 1),
    respRate: round(breathing?.averageQuantity?.quantity, 1),
    weightKg: round(weight?.mostRecentQuantity?.quantity, 1),
    workouts: [...workouts]
      .map((w) => ({
        type: workoutTypes?.[w.workoutActivityType] ?? `Workout ${w.workoutActivityType}`,
        start: new Date(w.startDate).getTime(),
        minutes: round(new Date(w.endDate).getTime() / 60000 - new Date(w.startDate).getTime() / 60000),
        energy: withUnit(w.totalEnergyBurned),
        distance: withUnit(w.totalDistance),
      }))
      .sort((a, b) => b.start - a.start),
  };
}

/** Keeps at most `count` evenly spaced points, always including the newest. */
function thin<T>(points: T[], count: number): T[] {
  if (points.length <= count) return points;
  const step = points.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(points[Math.floor(i * step)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}
