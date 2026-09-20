// Local time, done properly.
//
// Everything the assistant schedules is anchored to the user's own day: "every
// morning at seven" has to mean seven in their kitchen, on the day the clocks
// change as much as on any other. Adding 7 × 3600000 to midnight gets that wrong
// twice a year, which is exactly often enough to be embarrassing and rare enough
// to ship unnoticed. So wall-clock time is resolved against the zone rather than
// arithmetic on offsets.

/** How far the zone is from UTC at one moment, in milliseconds. */
export function offsetAt(at: number, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at;
}

/**
 * The moment a wall-clock time happens, in epoch milliseconds. The offset is
 * guessed from noon and then read again at the guess, because on the day the
 * clocks change, midnight sits on the other side of the change from noon.
 *
 * On a spring-forward day 02:30 does not exist; this returns the moment the
 * clock reaches 03:30, which is the next real instant, and is what someone who
 * asked for 02:30 would want.
 */
export function atLocalTime(day: string, minutes: number, timeZone: string) {
  const wantUtc = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
  const guess = wantUtc - offsetAt(wantUtc + 43_200_000, timeZone);
  return wantUtc - offsetAt(guess, timeZone);
}

/** When a local day starts, in epoch milliseconds. */
export const startOfDay = (day: string, timeZone: string) => atLocalTime(day, 0, timeZone);

/** 2026-09-20T14, 2026-09-20 and 2026-W38, in the user's own day. */
export function buckets(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  // ISO week: Thursday of this week decides the year, so a late-December Monday
  // lands in week 1 of the next year rather than week 53 of this one.
  const noon = new Date(`${day}T12:00:00Z`);
  const thursday = new Date(noon);
  thursday.setUTCDate(noon.getUTCDate() + 3 - ((noon.getUTCDay() + 6) % 7));
  // Both at noon, so the gap is a whole number of days and the rounding is exact.
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1, 12));
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return {
    hour: `${day}T${get("hour")}`,
    day,
    week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
  };
}

/** The local date, n days after `day`. */
export function addDays(day: string, n: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The epoch range of a local day. It runs to the start of the next day rather
 * than a flat 24 hours, so the days the clocks change are 23 or 25 hours long,
 * as they actually were.
 */
export function dayRange(day: string, timeZone: string): [number, number] {
  return [startOfDay(day, timeZone), startOfDay(addDays(day, 1), timeZone)];
}

/**
 * The seven local dates of an ISO week, Monday first. The inverse of the
 * `week` that `buckets` returns.
 *
 * The anchor is 4 January, which is in week 1 of its year by definition — the
 * same rule that makes a late-December Monday belong to the next year's week 1.
 */
export function weekDays(week: string) {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return null;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4, 12));
  // Monday of week 1. getUTCDay is 0 for Sunday, so this maps Monday to 0.
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (Number(m[2]) - 1) * 7);
  const start = monday.toISOString().slice(0, 10);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Minutes past local midnight at one moment: 07:30 is 450. */
export function localMinutes(at: number, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return n("hour") * 60 + n("minute");
}

/** 0 = Sunday, in the user's own day. */
export function localWeekday(at: number, timeZone: string) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(at));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export const clock = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(at));

/** "7:30 AM" from minutes past midnight, for reading a schedule back. */
export function clockFromMinutes(minutes: number) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Whether a moment falls inside quiet hours. The window wraps midnight when
 * start is after end, which is the normal case (22:00 to 07:00).
 */
export function inQuietHours(at: number, timeZone: string, start: number, end: number) {
  if (start === end) return false;
  const now = localMinutes(at, timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** When quiet hours next end, in epoch milliseconds. */
export function quietEndsAt(at: number, timeZone: string, end: number) {
  const today = buckets(at, timeZone).day;
  const candidate = atLocalTime(today, end, timeZone);
  return candidate > at ? candidate : atLocalTime(addDays(today, 1), end, timeZone);
}
