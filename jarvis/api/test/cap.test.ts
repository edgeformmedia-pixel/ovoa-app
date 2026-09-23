// The monthly reply cap (cap.ts): where the lines are, that the warning comes
// once, and what is said, checked without a database.

import { capVerdict, monthKey, nextMonthStart, overCapMessage, turnCapFrom, warnMessage } from "../src/cap";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// ---------- The number ----------

eq("a thousand unless told otherwise", turnCapFrom({}), 1000);
eq("an empty setting is the default too", turnCapFrom({ TURN_CAP_MONTHLY: "" }), 1000);
eq("a number is taken as it is", turnCapFrom({ TURN_CAP_MONTHLY: "250" }), 250);
eq("zero turns it off", turnCapFrom({ TURN_CAP_MONTHLY: "0" }), 0);
eq("nonsense is the default", turnCapFrom({ TURN_CAP_MONTHLY: "lots" }), 1000);
eq("a negative number is the default", turnCapFrom({ TURN_CAP_MONTHLY: "-5" }), 1000);

// ---------- Where the lines are ----------

eq("well under: nothing", capVerdict(10, 1000, false), "ok");
eq("just under the warning line: nothing", capVerdict(799, 1000, false), "ok");
eq("at the warning line: warn", capVerdict(800, 1000, false), "warn");
eq("past it, already warned: nothing", capVerdict(900, 1000, true), "ok");
eq("past it, not yet warned (a missed mark): warn", capVerdict(900, 1000, false), "warn");
eq("one short of the cap: still answered", capVerdict(999, 1000, true), "ok");
eq("at the cap: over", capVerdict(1000, 1000, true), "over");
eq("over, whether or not warned", capVerdict(1200, 1000, false), "over");
eq("cap off: never over", capVerdict(1_000_000, 0, false), "ok");
eq("a small cap warns at the rounded-up line", capVerdict(8, 10, false), "warn");
eq("and not below it", capVerdict(7, 10, false), "ok");

// ---------- The calendar ----------

const sept = Date.UTC(2026, 8, 22, 18); // 2026-09-22 13:00 in Chicago
eq("the month, in their zone", monthKey(sept, "America/Chicago"), "2026-09");
eq("the first of next month", nextMonthStart(sept, "America/Chicago"), "October 1");
const dec = Date.UTC(2026, 11, 31, 23, 30); // still New Year's Eve in Chicago
eq("December rolls to January", nextMonthStart(dec, "America/Chicago"), "January 1");
eq("and the month key follows the zone, not UTC", monthKey(dec, "Pacific/Auckland"), "2027-01");

// ---------- What is said ----------

eq("over: one sentence with the number and the date", overCapMessage(1000, sept, "America/Chicago"), "I've reached this month's limit of 1,000 replies, so I'll pick up again on October 1.");
eq("warn: one sentence with both numbers", warnMessage(800, 1000), "Heads up: that's 800 of this month's 1,000 replies.");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
