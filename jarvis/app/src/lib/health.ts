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
  "HKQuantityTypeIdentifierActiveEnergyBurned",
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
