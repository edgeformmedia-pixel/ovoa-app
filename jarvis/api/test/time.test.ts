// Local time and scheduling. Everything here is a pure function, and every case
// below is one that has silently broken a scheduler somewhere: the 23-hour day,
// the wall-clock time that doesn't exist, the window that wraps midnight, the
// zone that isn't a whole number of hours off.

import { atLocalTime, buckets, inQuietHours, localMinutes, localWeekday, quietEndsAt, clockFromMinutes } from "../src/time";
import { nextRun, describeSchedule } from "../src/agent";

let fails = 0;
const show = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(new Date(ms));

function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const NY = "America/New_York";

// --- atLocalTime across a spring-forward boundary -------------------------
// 2026-03-08 is the US spring-forward day: 02:00 jumps to 03:00.
eq("07:30 the day before DST", show(atLocalTime("2026-03-07", 450, NY), NY), "2026-03-07, 07:30");
eq("07:30 on the DST day", show(atLocalTime("2026-03-08", 450, NY), NY), "2026-03-08, 07:30");
eq("07:30 the day after DST", show(atLocalTime("2026-03-09", 450, NY), NY), "2026-03-09, 07:30");
// 02:30 does not exist that morning; the next real instant is 03:30.
eq("02:30 on the spring-forward day", show(atLocalTime("2026-03-08", 150, NY), NY), "2026-03-08, 03:30");
// Fall back: 2026-11-01, 02:00 goes back to 01:00. 01:30 happens twice.
eq("07:30 on the fall-back day", show(atLocalTime("2026-11-01", 450, NY), NY), "2026-11-01, 07:30");

// --- a daily job keeps its wall-clock time through the change -------------
const daily = { kind: "daily" as const, at_minutes: 450, weekday: null, every_minutes: null };
let t = atLocalTime("2026-03-07", 450, NY);
for (const want of ["2026-03-08, 07:30", "2026-03-09, 07:30", "2026-03-10, 07:30"]) {
  t = nextRun(daily, t, NY)!;
  eq("daily 7:30 rolls forward", show(t, NY), want);
}
// The DST day is 23 hours long, and the job's gap should be 23 hours, not 24.
const beforeDst = atLocalTime("2026-03-07", 450, NY);
const afterDst = nextRun(daily, beforeDst, NY)!;
eq("gap across spring-forward is 23h", (afterDst - beforeDst) / 3_600_000, 23);

// --- weekly lands on the right weekday ------------------------------------
const weekly = { kind: "weekly" as const, at_minutes: 540, weekday: 4, every_minutes: null }; // Thursday 09:00
let w = Date.parse("2026-09-20T12:00:00Z"); // a Sunday
for (const want of ["2026-09-24, 09:00", "2026-10-01, 09:00", "2026-10-08, 09:00"]) {
  w = nextRun(weekly, w, NY)!;
  eq(`weekly Thursday (weekday ${localWeekday(w, NY)})`, show(w, NY), want);
}
// From a Thursday just after the time, it should go a full week, not same-day.
const thu = atLocalTime("2026-09-24", 541, NY);
eq("weekly from just after it fired", show(nextRun(weekly, thu, NY)!, NY), "2026-10-01, 09:00");

// --- interval is floored ---------------------------------------------------
const spam = { kind: "interval" as const, at_minutes: null, weekday: null, every_minutes: 1 };
eq("interval floor", (nextRun(spam, 0, NY)! - 0) / 60_000, 15);
eq("interval honours a sane value", (nextRun({ ...spam, every_minutes: 180 }, 0, NY)! - 0) / 60_000, 180);

// --- once has no next time -------------------------------------------------
eq("once returns null", nextRun({ kind: "once", at_minutes: null, weekday: null, every_minutes: null }, Date.now(), NY), null);

// --- quiet hours wrap midnight --------------------------------------------
const at = (day: string, m: number) => atLocalTime(day, m, NY);
eq("23:00 is quiet", inQuietHours(at("2026-09-20", 1380), NY, 1320, 420), true);
eq("03:00 is quiet", inQuietHours(at("2026-09-20", 180), NY, 1320, 420), true);
eq("07:00 is not quiet (window end)", inQuietHours(at("2026-09-20", 420), NY, 1320, 420), false);
eq("13:00 is not quiet", inQuietHours(at("2026-09-20", 780), NY, 1320, 420), false);
eq("22:00 is quiet (window start)", inQuietHours(at("2026-09-20", 1320), NY, 1320, 420), true);
eq("start == end means never quiet", inQuietHours(at("2026-09-20", 180), NY, 0, 0), false);
// A non-wrapping window, for someone who sets 01:00-06:00.
eq("non-wrapping window, inside", inQuietHours(at("2026-09-20", 200), NY, 60, 360), true);
eq("non-wrapping window, outside", inQuietHours(at("2026-09-20", 1200), NY, 60, 360), false);

// A note written at 2am waits for 7am the same morning, not the next day.
eq("quiet ends this morning", show(quietEndsAt(at("2026-09-20", 120), NY, 420), NY), "2026-09-20, 07:00");
// One written at 11pm waits for the next morning.
eq("quiet ends tomorrow morning", show(quietEndsAt(at("2026-09-20", 1380), NY, 420), NY), "2026-09-21, 07:00");

// --- odds and ends ---------------------------------------------------------
eq("localMinutes", localMinutes(at("2026-09-20", 450), NY), 450);
eq("bucket day", buckets(at("2026-09-20", 450), NY).day, "2026-09-20");
// 00:30 New York is 04:30 UTC: the bucket must be the user's day, not UTC's.
eq("bucket day is local, not UTC", buckets(at("2026-09-20", 30), NY).day, "2026-09-20");
eq("clockFromMinutes noon", clockFromMinutes(720), "12:00 PM");
eq("clockFromMinutes midnight", clockFromMinutes(0), "12:00 AM");
eq("clockFromMinutes 7:30", clockFromMinutes(450), "7:30 AM");
eq("describe daily", describeSchedule(daily), "every day at 7:30 AM");
eq("describe weekly", describeSchedule(weekly), "every Thursday at 9:00 AM");
eq("describe interval hours", describeSchedule({ kind: "interval", at_minutes: null, weekday: null, every_minutes: 120 }), "every 2 hours");

// --- a southern-hemisphere zone, where DST runs the other way --------------
const SYD = "Australia/Sydney";
eq("Sydney 07:30 through its own change", show(atLocalTime("2026-04-05", 450, SYD), SYD), "2026-04-05, 07:30");
eq("Sydney weekday", localWeekday(atLocalTime("2026-09-20", 600, SYD), SYD), 0);

// A half-hour zone, which catches offset arithmetic that assumes whole hours.
const KOL = "Asia/Kolkata";
eq("Kolkata 07:30", show(atLocalTime("2026-09-20", 450, KOL), KOL), "2026-09-20, 07:30");
eq("Kolkata minutes", localMinutes(atLocalTime("2026-09-20", 450, KOL), KOL), 450);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
