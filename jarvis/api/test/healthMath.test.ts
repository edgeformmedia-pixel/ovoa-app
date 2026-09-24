// Apple Health sync's arithmetic (app/src/lib/healthMath.ts), checked without a
// phone. The sleep cases are the two bugs found on 2026-09-23: overlapping
// sources added up (a watch and a sleep app both writing counted the night
// twice) and "in bed" thrown away (an iPhone with a Sleep schedule and no watch
// had no sleep at all). Times are built in local time, as the phone's are, so
// the cases hold in any time zone.

import {
  changedDays,
  daysBack,
  daysBetween,
  hashOf,
  localTime,
  nightSamples,
  readsVerdict,
  sleepNight,
  sourceLabel,
  syncReport,
  thinReadings,
  unionMinutes,
  type SleepSample,
} from "../../app/src/lib/healthMath";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `\n       wanted ${JSON.stringify(want)}`}`);
}

/** Local time on a day, e.g. at("2026-09-23", 23, 40); hours past 24 run into the next day. */
const at = (day: string, hour: number, minute = 0) => localTime(day, 0, 0).getTime() + (hour * 60 + minute) * 60_000;
const sample = (value: number, source: string, from: [string, number, number], to: [string, number, number]): SleepSample => ({
  value,
  source,
  start: at(...from),
  end: at(...to),
});

// ---------- unionMinutes ----------

eq("union: two overlapping spans count once", unionMinutes([{ start: 0, end: 60 * 60_000 }, { start: 30 * 60_000, end: 90 * 60_000 }]), 90);
eq("union: a gap stays a gap", unionMinutes([{ start: 0, end: 10 * 60_000 }, { start: 20 * 60_000, end: 30 * 60_000 }]), 20);
eq("union: a span inside another adds nothing", unionMinutes([{ start: 0, end: 60 * 60_000 }, { start: 10 * 60_000, end: 20 * 60_000 }]), 60);
eq("union: empty", unionMinutes([]), 0);

// ---------- sleepNight ----------

const D = "2026-09-23";
const E = "2026-09-22"; // the evening before

// A watch with stages, 23:30 to 07:00 with a 10-minute wake at 03:00, and a
// sleep app that says asleep 23:00 to 06:30 over the top of it.
const watchAndApp: SleepSample[] = [
  sample(0, "Apple Watch", [E, 23, 10], [D, 7, 5]),
  sample(3, "Apple Watch", [E, 23, 30], [D, 1, 0]),
  sample(4, "Apple Watch", [D, 1, 0], [D, 2, 0]),
  sample(5, "Apple Watch", [D, 2, 0], [D, 3, 0]),
  sample(2, "Apple Watch", [D, 3, 0], [D, 3, 10]),
  sample(3, "Apple Watch", [D, 3, 10], [D, 7, 0]),
  sample(1, "AutoSleep", [E, 23, 0], [D, 6, 30]),
];
const both = sleepNight(watchAndApp, D);
// Union: 23:00 (the app) to 07:00 (the watch), less the watch's 10 awake
// minutes that the app covers anyway — so 8 h. The old sum said 7 h 20 + 7 h 30.
eq("two sources: asleep is the union, not the sum", both?.asleepMin, 480);
eq("two sources: stages from the watch alone", both?.stages, { awake: 10, core: 320, deep: 60, rem: 60 });
eq("two sources: in bed kept apart", both?.inBedMin, 475);
eq("two sources: bed and wake", [both?.start === at(E, 23, 0), both?.end === at(D, 7, 0)], [true, true]);
eq("two sources: both named", both?.source, "Apple Watch and AutoSleep");

// An iPhone with a Sleep schedule and no watch writes only "in bed".
const phoneOnly = sleepNight([sample(0, "iPhone", [E, 22, 45], [D, 6, 50])], D);
eq("in bed only: never called asleep", phoneOnly?.asleepMin, 0);
eq("in bed only: the time in bed", phoneOnly?.inBedMin, 485);
eq("in bed only: bed and wake from it", [phoneOnly?.start === at(E, 22, 45), phoneOnly?.end === at(D, 6, 50)], [true, true]);
eq("in bed only: no stages", phoneOnly?.stages, undefined);

// The night belongs to the day it ended on, from 18:00 the evening before to 18:00.
const edges: SleepSample[] = [
  sample(1, "Apple Watch", [E, 17, 0], [E, 18, 0]), // ends at 18:00 the evening before: that day's
  sample(1, "Apple Watch", [E, 17, 30], [E, 18, 1]), // one minute later: this night's
  sample(1, "Apple Watch", [D, 17, 0], [D, 18, 0]), // an afternoon nap ending 18:00: still today's
  sample(1, "Apple Watch", [D, 17, 30], [D, 18, 1]), // past 18:00: tomorrow's
];
eq("window: what belongs to the day", nightSamples(edges, D).length, 2);
eq("window: a nap ending by 18:00 counts", sleepNight(edges, D)?.asleepMin, 91);
eq("no sleep at all: null", sleepNight([], D), null);
eq("awake alone isn't a night", sleepNight([sample(2, "Apple Watch", [D, 3, 0], [D, 3, 10])], D), null);

// ---------- thinReadings ----------

eq(
  "thin: sorted, one per 30 s",
  thinReadings(
    [
      { ts: 65_000, bpm: 90 },
      { ts: 0, bpm: 80 },
      { ts: 10_000, bpm: 81 },
      { ts: 30_000, bpm: 85 },
      { ts: 59_000, bpm: 88 },
    ],
    30_000,
  ),
  [
    { ts: 0, bpm: 80 },
    { ts: 30_000, bpm: 85 },
    { ts: 65_000, bpm: 90 },
  ],
);
eq("thin: empty", thinReadings([], 30_000), []);

// ---------- sourceLabel ----------

eq("source: a watch by its owner's name", sourceLabel({ name: "Tom's Apple Watch", bundleIdentifier: "com.apple.health.81AE7B9D-3C3E" }), "Apple Watch");
eq("source: an iPhone", sourceLabel({ name: "Tom's iPhone", bundleIdentifier: "com.apple.health.2A0B" }), "iPhone");
eq("source: a renamed watch, known by its model", sourceLabel({ name: "Bob", bundleIdentifier: "com.apple.health.2A0B" }, "Watch6,1"), "Apple Watch");
eq("source: a renamed device with no model", sourceLabel({ name: "Bob", bundleIdentifier: "com.apple.health.2A0B" }), "an Apple device");
eq("source: an app is its name", sourceLabel({ name: "AutoSleep", bundleIdentifier: "com.tantsissa.AutoSleep" }), "AutoSleep");
eq("source: the Health app itself", sourceLabel({ name: "Health", bundleIdentifier: "com.apple.Health" }), "Health");

// ---------- readsVerdict ----------

eq("reads: a source answered", readsVerdict(1, null), "ok");
eq("reads: nothing, while the iPhone counted 3242 steps (reading off)", readsVerdict(0, 3242), "off");
eq("reads: nothing, and a phone that's barely moved", readsVerdict(0, 150), "empty");
eq("reads: nothing, and no step count to compare", readsVerdict(0, null), "empty");

// ---------- syncReport ----------
// The sync's device_logs line is written only when its facts change, so the
// counts and the order Health lists sources in mustn't count as a change, and a
// switched-off read has to be a warning to upload (2026-09-23).

const watch = {
  reads: "ok" as const,
  phoneStepsToday: 3242,
  sources: { any: ["iPhone", "Apple Watch"], heart: ["Apple Watch"], sleep: ["Apple Watch"], steps: ["iPhone", "Apple Watch"] },
  writeHeart: "on" as const,
  needsPrompt: false,
  stepsOnly: false,
};
const ok = syncReport(watch);
eq("report: reads ok is no problem", ok.problem, false);
eq(
  "report: the line",
  ok.text,
  "reads ok · heart rate from Apple Watch · sleep from Apple Watch · steps from Apple Watch, iPhone · saving the Band's heart rate to Health: on",
);
eq(
  "report: step count and source order aren't news",
  syncReport({ ...watch, phoneStepsToday: 5000, sources: { ...watch.sources, steps: ["Apple Watch", "iPhone"] } }).key,
  ok.key,
);
eq("report: saving switched off is news", syncReport({ ...watch, writeHeart: "off" }).key === ok.key, false);
eq("report: a new source is news", syncReport({ ...watch, sources: { ...watch.sources, sleep: ["Apple Watch", "AutoSleep"] } }).key === ok.key, false);
const off = syncReport({ ...watch, reads: "off", sources: { any: [], heart: [], sleep: [], steps: [] } });
eq("report: reading switched off is a warning", off.problem, true);
eq("report: and says the iPhone's count", off.text.startsWith("reads OFF (Health gave nothing while the iPhone counted 3242 steps today)"), true);
eq("report: nothing and no count to compare is a warning too", syncReport({ ...watch, reads: "empty", phoneStepsToday: null }).problem, true);
const heartOff = syncReport({ ...watch, sources: { ...watch.sources, heart: [] } });
eq("report: a watch with no heart rate coming through is a warning", heartOff.problem, true);
eq("report: and says heart rate's switch looks off", heartOff.text.includes("reading heart rate looks switched off"), true);
eq("report: no watch at all is no problem", syncReport({ ...watch, sources: { any: ["iPhone"], heart: [], sleep: [], steps: ["iPhone"] } }).problem, false);
eq(
  "report: the sheet and consent notes",
  syncReport({ ...watch, needsPrompt: true, stepsOnly: true, writeHeart: "not_asked" }).text.endsWith(
    "saving the Band's heart rate to Health: not asked · the Health sheet has more to ask · days sent as steps only (no AI consent)",
  ),
  true,
);

// ---------- days ----------

eq("daysBetween: both ends", daysBetween("2026-09-29", "2026-10-02"), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
eq("daysBetween: across a DST change", daysBetween("2026-03-07", "2026-03-10").length, 4);
eq("daysBetween: one day", daysBetween(D, D), [D]);
eq("daysBack: oldest first, ending today", daysBack(3, new Date(2026, 8, 23, 9)), ["2026-09-21", "2026-09-22", "2026-09-23"]);
eq("daysBack: across a month", daysBack(2, new Date(2026, 9, 1, 0, 30)), ["2026-09-30", "2026-10-01"]);

// ---------- changedDays ----------

const yesterday = { day: "2026-09-22", activeKcal: 310, steps: 8120 };
const today = { day: "2026-09-23", activeKcal: 103, steps: 3242 };
const first = changedDays([yesterday, today], {}, "2026-09-10");
eq("changed: everything on the first sync", first.changed.map((d) => d.day), ["2026-09-22", "2026-09-23"]);
const again = changedDays([yesterday, { ...today, steps: 3300 }], { ...first.next, "2026-09-01": "old" }, "2026-09-10");
eq("changed: only the day that moved", again.changed.map((d) => d.day), ["2026-09-23"]);
eq("changed: yesterday's fingerprint kept", again.next["2026-09-22"], first.next["2026-09-22"]);
eq("changed: fingerprints older than the window dropped", "2026-09-01" in again.next, false);
eq("hash: same value, same hash", hashOf({ a: 1 }) === hashOf({ a: 1 }), true);
eq("hash: different value, different hash", hashOf({ a: 1 }) === hashOf({ a: 2 }), false);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
