import { Pedometer } from "expo-sensors";
import { Platform } from "react-native";
import type { StepDay } from "./api";

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export async function stepPermission(): Promise<"ok" | "denied" | "unavailable"> {
  if (Platform.OS === "web" || !(await Pedometer.isAvailableAsync())) return "unavailable";
  const { granted } = await Pedometer.requestPermissionsAsync();
  return granted ? "ok" : "denied";
}

/** Steps for each of the last 7 days (iOS keeps a 7-day history), oldest first. */
export async function lastSevenDays(): Promise<StepDay[]> {
  if (Platform.OS !== "ios") return [];
  const today = startOfDay(new Date());
  const days = Array.from({ length: 7 }, (_, i) => {
    const start = new Date(today);
    start.setDate(today.getDate() - (6 - i));
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { start, end: i === 6 ? new Date() : end };
  });
  return Promise.all(
    days.map(async ({ start, end }) => {
      const { steps } = await Pedometer.getStepCountAsync(start, end).catch(() => ({ steps: 0 }));
      return { day: dayKey(start), steps };
    }),
  );
}

// Rough averages; shown as estimates.
export const kmForSteps = (steps: number) => (steps * 0.762) / 1000;
export const kcalForSteps = (steps: number) => steps * 0.04;
