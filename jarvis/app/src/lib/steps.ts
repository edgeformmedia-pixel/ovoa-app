import { Pedometer } from "expo-sensors";
import { Platform } from "react-native";
import type { StepDay } from "./api";
import { healthAsked, healthAvailable, stepDays } from "./health";
import { daysBack, dayKey } from "./healthMath";

export { dayKey };

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export async function stepPermission(): Promise<"ok" | "denied" | "unavailable"> {
  if (Platform.OS === "web" || !(await Pedometer.isAvailableAsync())) return "unavailable";
  const { granted } = await Pedometer.requestPermissionsAsync();
  return granted ? "ok" : "denied";
}

/**
 * Steps for each of the last 7 days, oldest first: Apple Health's count when it
 * has one, which merges the iPhone's and a watch's without counting twice, and
 * otherwise the iPhone's own counter (iOS keeps a 7-day history). The same
 * numbers the Health sync sends (healthSync.ts), so the two don't overwrite
 * each other's day on the server with different counts.
 */
export async function lastSevenDays(): Promise<StepDay[]> {
  if (Platform.OS !== "ios") return [];
  const fromHealth = await healthSteps();
  if (fromHealth) return fromHealth;
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

/** Apple Health's last 7 days, or null when it has no step count at all (not asked, reading off, nothing counted). */
async function healthSteps(): Promise<StepDay[] | null> {
  if (!healthAvailable || !(await healthAsked())) return null;
  const week = daysBack(7);
  const days = await stepDays(week[0], week[6]).catch(() => null);
  if (!days?.some((d) => d.sources.length)) return null;
  return days.map(({ day, steps }) => ({ day, steps }));
}

// Rough averages; shown as estimates.
export const kmForSteps = (steps: number) => (steps * 0.762) / 1000;
export const kcalForSteps = (steps: number) => steps * 0.04;
