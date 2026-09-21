// When a routine is next due. This decides when someone is reminded to take
// their medication, so the cases are the ones that go quietly wrong: the clocks
// changing, the last time of the day, weekday-only routines, a zone far from UTC.

import { describeRoutine, nextOccurrence, occurrencesBetween, parseClock } from "../src/routines";
import { atLocalTime } from "../src/time";

let fails = 0;
const NY = "America/New_York";
const show = (ms: number | null, tz = NY) =>
  ms === null
    ? null
    : `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms))}, ${new Intl.DateTimeFormat(
        "en-CA",
        { timeZone: tz, dateStyle: "short", timeStyle: "short", hourCycle: "h23" },
      ).format(new Date(ms))}`;

function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// Sunday 2026-09-20, 07:00 in New York.
const sunday7am = atLocalTime("2026-09-20", 7 * 60, NY);

eq("later today", show(nextOccurrence([480, 1200], [], sunday7am, NY)), "Sun, 2026-09-20, 08:00");
eq("after the first, the second", show(nextOccurrence([480, 1200], [], atLocalTime("2026-09-20", 480, NY), NY)), "Sun, 2026-09-20, 20:00");
eq("after the last, tomorrow's first", show(nextOccurrence([480, 1200], [], atLocalTime("2026-09-20", 1201, NY), NY)), "Mon, 2026-09-21, 08:00");
eq("times given out of order", show(nextOccurrence([1200, 480], [], sunday7am, NY)), "Sun, 2026-09-20, 08:00");
eq("exactly at the time is not 'after'", show(nextOccurrence([420], [], sunday7am, NY)), "Mon, 2026-09-21, 07:00");
eq("no times, no occurrence", nextOccurrence([], [], sunday7am, NY), null);

// Weekdays only (Mon-Fri), asked on a Sunday morning.
eq("weekday routine skips Sunday", show(nextOccurrence([480], [1, 2, 3, 4, 5], sunday7am, NY)), "Mon, 2026-09-21, 08:00");
eq("Saturday-only waits the week", show(nextOccurrence([480], [6], sunday7am, NY)), "Sat, 2026-09-26, 08:00");

// 8am stays 8am across the change.
const beforeFallBack = atLocalTime("2026-10-31", 21 * 60, NY);
eq("the morning after fall-back", show(nextOccurrence([480], [], beforeFallBack, NY)), "Sun, 2026-11-01, 08:00");
const beforeSpring = atLocalTime("2026-03-07", 21 * 60, NY);
eq("the morning after spring-forward", show(nextOccurrence([480], [], beforeSpring, NY)), "Sun, 2026-03-08, 08:00");

// Far from UTC.
const KOL = "Asia/Kolkata";
eq("Kolkata's 8am", show(nextOccurrence([480], [], atLocalTime("2026-09-20", 60, KOL), KOL), KOL), "Sun, 2026-09-20, 08:00");

// The phone schedules two days ahead; twice a day is four notifications.
const two = occurrencesBetween([480, 1200], [], sunday7am, sunday7am + 48 * 3_600_000, NY);
eq("four in 48 hours", two.length, 4);
eq("the first is this morning", show(two[0]), "Sun, 2026-09-20, 08:00");
eq("the last is Monday evening", show(two[3]), "Mon, 2026-09-21, 20:00");
eq("an occurrence right at the start counts", occurrencesBetween([420], [], sunday7am, sunday7am + 3_600_000, NY).length, 1);

eq("parse 8:05", parseClock("8:05"), 485);
eq("parse 20:30", parseClock("20:30"), 1230);
eq("not a time", parseClock("8pm"), null);
eq("not an hour", parseClock("24:00"), null);

eq("read back daily", describeRoutine({ times: "[1200,480]", days: "[]" }), "every day at 8:00 AM and 8:00 PM");
eq("read back weekdays", describeRoutine({ times: "[540]", days: "[1,3,5]" }), "on mon, wed, fri at 9:00 AM");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
