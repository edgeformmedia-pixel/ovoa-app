// The texting funnel's counts, checked without a database: who counts as having
// hit the paywall, and how trial starts and links are grouped by day.

import { FREE } from "../src/guest";
import { dayOf, foldFunnel } from "../src/funnel";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

const now = Date.UTC(2026, 9, 4, 3, 0);
const d = (day: number, hour = 12) => Date.UTC(2026, 9, day, hour);
const guest = (used: number, extra: Partial<{ email: string; join_token: string; told_at: number }> = {}) => ({
  used,
  email: extra.email ?? null,
  join_token: extra.join_token ?? null,
  told_at: extra.told_at ?? null,
});

const f = foldFunnel(
  7,
  now,
  [d(1), d(1, 20), d(3), d(2)],
  [guest(0), guest(3), guest(5), guest(FREE - 1), guest(FREE, { told_at: 1, join_token: "t" }), guest(FREE + 2, { email: "x" })],
  [d(2), d(3)],
);
eq("window starts 6 days back", f.from, "2026-09-28");
eq("trial starts are counted by day", f.trialStarts, { total: 4, byDay: { "2026-10-01": 2, "2026-10-02": 1, "2026-10-03": 1 } });
eq("free texts used are bucketed", f.stillTrial.used, { none: 1, some: 1, most: 2, all: 2 });
eq("the paywall is all FREE texts used, or more", f.paywallHit, { count: 2, share: 0.33 });
eq("told out of free and outstanding pay links", [f.stillTrial.toldOutOfFree, f.stillTrial.payLinkOutstanding], [1, 1]);
eq("email given", f.stillTrial.gaveEmail, 1);
eq("linked accounts by day", f.linkedAccounts, { total: 2, byDay: { "2026-10-02": 1, "2026-10-03": 1 } });
eq("no one on the trial is a zero share, not NaN", foldFunnel(7, now, [], [], []).paywallHit, { count: 0, share: 0 });
eq("day of a time", dayOf(d(3, 23)), "2026-10-03");

if (fails) {
  console.error(`${fails} check(s) failed`);
  process.exit(1);
}
