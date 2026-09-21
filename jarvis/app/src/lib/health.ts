import { isRunningInExpoGo } from "expo";
import { Platform } from "react-native";

/**
 * Apple Health. HealthKit is a native module that Expo Go doesn't include, so
 * the library is only loaded in a development build of OVOA.
 */

type HealthKitModule = typeof import("@kingstinct/react-native-healthkit");

export const healthAvailable = Platform.OS === "ios" && !isRunningInExpoGo();

function healthKit(): HealthKitModule {
  if (!healthAvailable) {
    throw new Error("Apple Health needs the installed OVOA app (a development build), not Expo Go.");
  }
  // Loaded lazily: importing it at the top would crash Expo Go.
  return require("@kingstinct/react-native-healthkit");
}

const READ = [
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierAppleExerciseTime",
  "HKQuantityTypeIdentifierAppleStandTime",
  "HKCategoryTypeIdentifierSleepAnalysis",
  "HKWorkoutTypeIdentifier",
] as const;

// CategoryValueSleepAnalysis: 0 in bed, 2 awake; 1, 3, 4, 5 are asleep.
const ASLEEP = new Set([1, 3, 4, 5]);

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const round = (n: number | undefined, digits = 0) =>
  n === undefined ? undefined : Math.round(n * 10 ** digits) / 10 ** digits;

const withUnit = (q?: { quantity: number; unit: string }) => (q ? `${round(q.quantity, 1)} ${q.unit}` : undefined);

/** Per-day steps, heart rate, sleep, and energy, plus workouts, for the last `days` days. */
export async function healthSummary({ days = 7 }: { days?: number }) {
  const hk = healthKit();
  const count = Math.min(Math.max(days, 1), 14);
  if (!(await hk.isHealthDataAvailableAsync())) throw new Error("Apple Health isn't available on this device.");
  await hk.requestAuthorization({ toRead: READ });

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
      hk.queryStatisticsForQuantity(
        "HKQuantityTypeIdentifierHeartRate",
        ["discreteAverage", "discreteMin", "discreteMax"],
        { filter, unit: "count/min" },
      ),
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
    });
  }

  // Sleep counts toward the day it ended on (last night's sleep belongs to today).
  const sleep = await hk.queryCategorySamples("HKCategoryTypeIdentifierSleepAnalysis", {
    filter: { date: { startDate: new Date(from.getTime() - 12 * 3600_000), endDate: now } },
    limit: 0,
  });
  const sleepMs = new Map<string, number>();
  for (const s of sleep) {
    if (!ASLEEP.has(Number(s.value))) continue;
    const key = dayKey(new Date(s.endDate));
    sleepMs.set(key, (sleepMs.get(key) ?? 0) + (new Date(s.endDate).getTime() - new Date(s.startDate).getTime()));
  }
  for (const d of perDay) {
    const ms = sleepMs.get(d.day);
    d.sleepHours = ms ? round(ms / 3600_000, 1) : undefined;
  }

  const workouts = await hk.queryWorkoutSamples({ filter: { date: { startDate: from, endDate: now } }, limit: 30 });
  const { WorkoutActivityType } = require("@kingstinct/react-native-healthkit/types") as typeof import(
    "@kingstinct/react-native-healthkit/types"
  );

  return {
    days: perDay,
    workouts: workouts.map((w) => ({
      type: WorkoutActivityType[w.workoutActivityType] ?? String(w.workoutActivityType),
      start: new Date(w.startDate).toISOString(),
      minutes: round(new Date(w.endDate).getTime() / 60000 - new Date(w.startDate).getTime() / 60000),
      energy: withUnit(w.totalEnergyBurned),
      distance: withUnit(w.totalDistance),
    })),
    note: "Missing values mean Apple Health has no data for that day.",
  };
}

// ---------- The Activity tab ----------
//
// healthSummary() above answers questions ("how did I sleep?"); what follows
// feeds the Activity tab, which wants today at a glance and cheap enough to
// reload every time the tab is opened.

export type HeartPoint = { at: number; bpm: number };

export type TodayHealth = {
  /** The most recent heart rate reading, whenever it was taken. */
  heartRate?: { bpm: number; at: number };
  restingHeartRate?: number;
  /** Today's average, low and high, from every reading since midnight. */
  heartRateAvg?: number;
  heartRateMin?: number;
  heartRateMax?: number;
  /** Readings over the last `HEART_WINDOW_HOURS`, oldest first, for the graph. */
  heart: HeartPoint[];
  activeEnergyKcal?: number;
  exerciseMinutes?: number;
  standHours?: number;
  /** Last night: sleep that ended today. */
  sleepHours?: number;
  /** Heart-rate variability (SDNN, ms), today's average. */
  hrvMs?: number;
  /** Today's workouts, most recent first. */
  workouts: { type: string; start: number; minutes?: number; energy?: string; distance?: string }[];
};

/**
 * Heart-rate readings written to Health since `from`, oldest first. Whatever
 * wrote them (a watch, usually); the ES100's readings come straight from the
 * clip instead (lib/heart.ts).
 */
export async function heartRateSince(from: Date, limit = 2000) {
  const hk = healthKit();
  const samples = await hk.queryQuantitySamples("HKQuantityTypeIdentifierHeartRate", {
    filter: { date: { startDate: from, endDate: new Date() } },
    unit: "count/min",
    limit,
    ascending: true,
  });
  return samples.map((s) => ({ ts: new Date(s.endDate).getTime(), bpm: Math.round(s.quantity) }));
}

/**
 * Lets Health wake the app when new heart rate is written, so readings reach
 * the server without the app being opened. iOS decides how often; hourly is
 * what it will honour for heart rate.
 */
export async function watchHeartRate(onChange: () => void) {
  if (!healthAvailable) return () => {};
  const hk = healthKit();
  const { UpdateFrequency } = require("@kingstinct/react-native-healthkit/types") as typeof import("@kingstinct/react-native-healthkit/types");
  await hk.configureBackgroundTypes(["HKQuantityTypeIdentifierHeartRate"], UpdateFrequency.hourly).catch(() => false);
  const sub = hk.subscribeToChanges("HKQuantityTypeIdentifierHeartRate", () => onChange());
  return () => sub.remove();
}

/** How far back the heart-rate graph reaches. */
export const HEART_WINDOW_HOURS = 12;
/** Readings are thinned to this many points, so the graph stays cheap to draw. */
const HEART_POINTS = 48;

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
  await hk.requestAuthorization({ toRead: READ });
  return "ok";
}

/** Everything the Activity tab shows about today. Throws if Health isn't available. */
export async function todayHealth(): Promise<TodayHealth> {
  const hk = healthKit();
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = { filter: { date: { startDate: midnight, endDate: now } } };
  const windowStart = new Date(Math.max(now.getTime() - HEART_WINDOW_HOURS * 3600_000, midnight.getTime() - 86400_000));

  const [heartStats, resting, energy, exercise, stand, hrv, recent, sleep, workouts] = await Promise.all([
    hk
      .queryStatisticsForQuantity(
        "HKQuantityTypeIdentifierHeartRate",
        ["discreteAverage", "discreteMin", "discreteMax"],
        { ...today, unit: "count/min" },
      )
      .catch(() => null),
    hk
      .queryStatisticsForQuantity("HKQuantityTypeIdentifierRestingHeartRate", ["discreteAverage"], {
        // Resting heart rate lands once a day, sometimes late: look back two days.
        filter: { date: { startDate: new Date(now.getTime() - 2 * 86400_000), endDate: now } },
        unit: "count/min",
      })
      .catch(() => null),
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
      .queryQuantitySamples("HKQuantityTypeIdentifierHeartRate", {
        filter: { date: { startDate: windowStart, endDate: now } },
        unit: "count/min",
        limit: 400,
        ascending: false,
      })
      .catch(() => []),
    hk
      .queryCategorySamples("HKCategoryTypeIdentifierSleepAnalysis", {
        filter: { date: { startDate: new Date(midnight.getTime() - 18 * 3600_000), endDate: now } },
        limit: 0,
      })
      .catch(() => []),
    hk.queryWorkoutSamples({ ...today, limit: 10 }).catch(() => []),
  ]);

  // Newest first from HealthKit; the graph wants oldest first.
  const points: HeartPoint[] = [...recent]
    .map((s) => ({ at: new Date(s.endDate).getTime(), bpm: Math.round(s.quantity) }))
    .sort((a, b) => a.at - b.at);

  // Sleep that ended today, asleep stages only.
  let sleepMs = 0;
  for (const s of sleep) {
    if (!ASLEEP.has(Number(s.value))) continue;
    if (new Date(s.endDate).getTime() < midnight.getTime()) continue;
    sleepMs += new Date(s.endDate).getTime() - new Date(s.startDate).getTime();
  }

  const workoutTypes = (() => {
    try {
      return (require("@kingstinct/react-native-healthkit/types") as typeof import(
        "@kingstinct/react-native-healthkit/types"
      )).WorkoutActivityType;
    } catch {
      return undefined;
    }
  })();

  const latest = points.at(-1);
  return {
    heartRate: latest ? { bpm: latest.bpm, at: latest.at } : undefined,
    restingHeartRate: round(resting?.averageQuantity?.quantity),
    heartRateAvg: round(heartStats?.averageQuantity?.quantity),
    heartRateMin: round(heartStats?.minimumQuantity?.quantity),
    heartRateMax: round(heartStats?.maximumQuantity?.quantity),
    heart: thin(points, HEART_POINTS),
    activeEnergyKcal: round(energy?.sumQuantity?.quantity),
    exerciseMinutes: round(exercise?.sumQuantity?.quantity),
    standHours: stand?.sumQuantity?.quantity ? round(stand.sumQuantity.quantity / 60) : undefined,
    hrvMs: round(hrv?.averageQuantity?.quantity),
    sleepHours: sleepMs ? round(sleepMs / 3600_000, 1) : undefined,
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
