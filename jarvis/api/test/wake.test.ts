// When what the phone hears may reach the assistant: the wake window
// (app/src/lib/wakeWindow.ts), checked without a microphone. The phone's ear
// hears the room all the time; the promise is that none of it goes further than
// the phone until the name (or the band's button, or a follow-up to a reply),
// and this is where that promise is checked by a machine rather than by a
// person in a room. (The old way's ten-minute auto-off and hour-a-day meter
// went with the Deepgram stream on 2026-09-23.)

import { WAKE_MS, WakeWindow } from "../../app/src/lib/wakeWindow";

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
eq("words still arriving keep it open", r.wake("speech", t0 + 11_000), false);
eq("the reply extends it again", r.wake("reply", t0 + 20_000), false);
// The reply's audio finishes inside its minute; the follow-up window runs on from there.
eq("after the reply, the follow-up window", r.wake("follow-up", t0 + 75_000), false);
eq("open through the follow-up", r.awake(t0 + 75_000 + WAKE_MS["follow-up"] - 1), true);
eq("closed after it", r.awake(t0 + 75_000 + WAKE_MS["follow-up"]), false);
eq("still one opening in all that", r.opens, 1);
eq("a second name is a second opening", r.wake("name", t0 + 120_000), true);
eq("counted", r.opens, 2);
eq("how long it has been open", r.openFor(t0 + 121_000), 1_000);
eq("zero when closed", r.openFor(t0 + 300_000), 0);

// ---------- A slow or long reply ----------

// The assistant thinks for a minute, then reads aloud for two: "busy" is renewed
// every tick the whole time, and the window shuts ten seconds after it stops.
const b = new WakeWindow();
b.wake("name", t0);
b.wake("turn", t0 + 4_000);
let tick = t0 + 4_000;
let last = tick;
while (tick < t0 + 184_000) {
  b.wake("busy", tick);
  last = tick;
  tick += 150;
}
eq("open right through it", b.awake(t0 + 183_000), true);
eq("still only the one opening", b.opens, 1);
eq("open ten seconds after it stops", b.awake(last + WAKE_MS.busy - 1), true);
eq("closed after that", b.awake(last + WAKE_MS.busy), false);

// ---------- The button ----------

const s = new WakeWindow();
eq("a summon opens it too", s.wake("summon", t0), true);
eq("for its ten seconds", s.awake(t0 + WAKE_MS.summon - 1), true);
eq("closing early closes it now", (s.close(t0 + 2_000), s.awake(t0 + 2_000)), false);
eq("and a later time is still closed", s.awake(t0 + 5_000), false);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
