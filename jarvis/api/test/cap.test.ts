// The monthly reply cap (cap.ts, with its numbers per plan in plans.ts): where
// the lines are, that the warning comes once, and what is said, checked
// without a database.

import { capVerdict, monthKey, nextMonthStart, overCapMessage, warnMessage } from "../src/cap";
import { ALLOWANCES } from "../src/plans";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// ---------- The numbers, per plan ----------

// Since 2026-09-28 the plans have no monthly cap (the daily budget bounds a
// month); the arithmetic stays for a plan that sets one.
eq("no plan has a monthly cap", ALLOWANCES.free.monthly + ALLOWANCES.base.monthly + ALLOWANCES.plus.monthly + ALLOWANCES.pro.monthly, 0);
eq("a cap of 0 is off", capVerdict(100_000, 0, false), "ok");
eq("a cap of 465 warns at 372", capVerdict(372, 465, false), "warn");
eq("and stops at 465", capVerdict(465, 465, true), "over");

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
eq("Pro's, with its comma", overCapMessage(1860, sept, "America/Chicago"), "I've reached this month's limit of 1,860 replies, so I'll pick up again on October 1.");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
