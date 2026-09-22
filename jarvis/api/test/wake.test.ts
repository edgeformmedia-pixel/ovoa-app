// When audio may leave the phone: the wake window and the fallback's caps
// (app/src/lib/wakeWindow.ts), checked without a microphone. The whole point
// of Phase 3 of the cost pass is that nothing streams until the name; this is
// where that promise is checked by a machine rather than by a person in a room.

import { AUTO_OFF_MS, DAILY_STREAM_CAP_S, meterAdd, meterOver, WAKE_MS, WakeWindow } from "../../app/src/lib/wakeWindow";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const t0 = 1_758_412_800_000;

// ---------- Nothing until the name ----------

const w = new WakeWindow();
eq("asleep to begin with", w.awake(t0), false);
eq("room talk never wakes it (nothing is called)", w.awake(t0 + 60_000), false);
eq("the name opens the window", w.wake("name", t0), true);
eq("and it is awake", w.awake(t0 + 1), true);
eq("for the name's twelve seconds", w.awake(t0 + WAKE_MS.name - 1), true);
eq("and not a moment more", w.awake(t0 + WAKE_MS.name), false);
eq("opened once", w.opens, 1);

// ---------- A request keeps it open ----------

const r = new WakeWindow();
r.wake("name", t0);
eq("the request extends it, without reopening", r.wake("turn", t0 + 3_000), false);
eq("still open when the name's window would have lapsed", r.awake(t0 + 15_000), true);
eq("the reply extends it again", r.wake("reply", t0 + 20_000), false);
eq("after the reply, the follow-up window", r.wake("follow-up", t0 + 40_000), false);
eq("open through the follow-up", r.awake(t0 + 40_000 + WAKE_MS["follow-up"] - 1), true);
eq("closed after it", r.awake(t0 + 40_000 + WAKE_MS["follow-up"]), false);
eq("still one opening in all that", r.opens, 1);
eq("a second name is a second opening", r.wake("name", t0 + 60_000), true);
eq("counted", r.opens, 2);
eq("how long it has been open", r.openFor(t0 + 61_000), 1_000);
eq("zero when closed", r.openFor(t0 + 200_000), 0);

// ---------- The button ----------

const s = new WakeWindow();
eq("a summon opens it too", s.wake("summon", t0), true);
eq("for its ten seconds", s.awake(t0 + WAKE_MS.summon - 1), true);
eq("closing early closes it now", (s.close(t0 + 2_000), s.awake(t0 + 2_000)), false);
eq("and a later time is still closed", s.awake(t0 + 5_000), false);

// ---------- The fallback's auto-off ----------

const f = new WakeWindow();
eq("nothing addressed for ten minutes: stale", f.stale(t0 + AUTO_OFF_MS, t0), true);
eq("not before", f.stale(t0 + AUTO_OFF_MS - 1, t0), false);
f.wake("name", t0 + 5 * 60_000);
eq("a request resets the clock", f.stale(t0 + AUTO_OFF_MS, t0), false);
eq("ten minutes after it: stale again", f.stale(t0 + 5 * 60_000 + AUTO_OFF_MS, t0), true);

// ---------- The fallback's daily allowance ----------

const day1 = Date.UTC(2026, 8, 22, 12);
let m = meterAdd(null, 600, day1);
eq("ten minutes on a fresh day", m.seconds, 600);
eq("filed under the day", m.day, "2026-09-22");
m = meterAdd(m, 3000, day1 + 3_600_000);
eq("adds up within the day", m.seconds, 3600);
eq("an hour is the cap", meterOver(m, day1 + 3_600_000), true);
eq("just under is fine", meterOver(meterAdd(null, DAILY_STREAM_CAP_S - 1, day1), day1), false);
const day2 = Date.UTC(2026, 8, 23, 1);
eq("a new day starts fresh", meterAdd(m, 10, day2).seconds, 10);
eq("yesterday's total doesn't count today", meterOver(m, day2), false);
eq("a negative number can't lower it", meterAdd(m, -500, day1).seconds, 3600);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
