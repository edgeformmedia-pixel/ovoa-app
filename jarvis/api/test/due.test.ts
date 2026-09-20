// Turning what the model wrote about when something is due into a moment.
//
// This is load-bearing: it decides when a reminder fires. Every case below is
// one where getting it wrong is silently wrong — a reminder at midnight for a
// thing due that afternoon, a reminder an hour off twice a year, a reminder
// conjured out of a date that was never really a date.

import { resolveDue } from "../src/context";
import { atLocalTime } from "../src/time";

let fails = 0;
const NY = "America/New_York";
const show = (ms: number | null, tz: string) =>
  ms === null
    ? null
    : new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(
        new Date(ms),
      );

function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// A bare date means "during that day", so it resolves to the end of the working
// day. Midnight would fire a reminder about a day that hasn't started.
eq("bare date lands at 5pm", show(resolveDue("2026-09-24", NY), NY), "2026-09-24, 17:00");
eq("date with a time", show(resolveDue("2026-09-24T09:30", NY), NY), "2026-09-24, 09:30");
eq("a space instead of a T", show(resolveDue("2026-09-24 09:30", NY), NY), "2026-09-24, 09:30");
eq("single-digit hour", show(resolveDue("2026-09-24T9:30", NY), NY), "2026-09-24, 09:30");
eq("seconds are ignored, not fatal", show(resolveDue("2026-09-24T09:30:45", NY), NY), "2026-09-24, 09:30");
eq("midnight is respected when given", show(resolveDue("2026-09-24T00:00", NY), NY), "2026-09-24, 00:00");

// It must be the user's own afternoon, not UTC's.
eq("5pm is local", show(resolveDue("2026-09-24", "Asia/Kolkata"), "Asia/Kolkata"), "2026-09-24, 17:00");
eq("5pm in Sydney too", show(resolveDue("2026-09-24", "Australia/Sydney"), "Australia/Sydney"), "2026-09-24, 17:00");

// And still the right afternoon on the day the clocks change.
eq("the spring-forward day", show(resolveDue("2026-03-08", NY), NY), "2026-03-08, 17:00");
eq("the fall-back day", show(resolveDue("2026-11-01", NY), NY), "2026-11-01, 17:00");

// Anything that isn't a date gets nothing. A promise with no date is still a
// promise; a made-up date is a false alarm.
for (const junk of [undefined, "", "   ", "soon", "next week", "when I get a chance", "Thursday", "2026-13-45x", "not a date"]) {
  eq(`no date from ${JSON.stringify(junk)}`, resolveDue(junk, NY), null);
}
// An hour that doesn't exist isn't a time.
eq("hour 25", resolveDue("2026-09-24T25:00", NY), null);
eq("hour 24", resolveDue("2026-09-24T24:00", NY), null);
// The shape of a date isn't enough. Intl throws on an invalid Date rather than
// returning NaN, so these used to take the whole block insert down with them.
for (const fake of ["2026-13-45", "2026-02-30", "2026-00-10", "2026-09-32"]) {
  eq(`${fake} is not a day`, resolveDue(fake, NY), null);
}

// The resolved value has to agree with the scheduler's own clock maths,
// or a nudge would be computed against one calendar and fired against another.
eq(
  "agrees with atLocalTime",
  resolveDue("2026-09-24T09:30", NY),
  atLocalTime("2026-09-24", 9 * 60 + 30, NY),
);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
