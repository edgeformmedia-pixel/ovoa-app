// The Activity screen's heart rate, sleep and body numbers
// (app/src/lib/healthView.ts), checked without a phone. Since 2026-09-23 the
// heart card reads the server (GET /hr/day), where the Band's readings live,
// and lays the readings the phone hasn't sent yet over it. The ways that goes
// wrong are quiet ones — a reading counted twice, yesterday's unsent batch
// shown as today's latest, a morning's steps dragging the week down, a hint on
// every tile — so they are pinned here.

import {
  ago,
  bodyFromServer,
  evenOut,
  hasBody,
  healthHint,
  heartView,
  hoursMinutes,
  restingWeek,
  stageBar,
  weekAverages,
  type Body,
} from "../../app/src/lib/healthView";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

const MIN = 60_000;
const midnight = Date.UTC(2026, 8, 23, 4); // any fixed instant stands in for local midnight
const at = (minutes: number) => midnight + minutes * MIN;

// What GET /hr/day answers (api/src/healthdays.ts), 08:00 to 09:00 of Band readings.
const day: any = {
  day: "2026-09-23",
  latest: { ts: at(9 * 60), bpm: 64, source: "band", agoMin: 3 },
  restingBpm: 58,
  restingFrom: "band_night",
  low: 55,
  avg: 66,
  high: 90,
  count: 10,
  raisedMin: 15,
  points: [
    { ts: at(8 * 60), bpm: 60 },
    { ts: at(9 * 60), bpm: 64 },
  ],
  sources: { band: 10, health: 0 },
};

// ---------- the server's day with the phone's unsent readings ----------

eq("nothing local: the server's day as it is", heartView(day, [], midnight).latest, { ts: at(540), bpm: 64, source: "band" });

const merged = heartView(day, [{ ts: at(545), bpm: 100 }, { ts: at(550), bpm: 50 }], midnight);
eq("newest local reading is the latest", merged.latest, { ts: at(550), bpm: 50, source: "band" });
eq("low and high stretch to the local readings", [merged.low, merged.high], [50, 100]);
eq("count adds them", merged.count, 12);
eq("the average weighs them by count", merged.avg, Math.round((66 * 10 + 150) / 12));
eq("the line gets them on the end", merged.points.map((p) => p.bpm), [60, 64, 100, 50]);
eq("resting and raised stay the server's", [merged.restingBpm, merged.restingFrom, merged.raisedMin], [58, "band_night", 15]);

eq(
  "a reading the server already has (not newer than its latest) isn't counted again",
  heartView(day, [{ ts: at(540), bpm: 64 }, { ts: at(500), bpm: 70 }], midnight).count,
  10,
);
eq(
  "the same reading from the unsent batch and from the card's listener counts once",
  heartView(day, [{ ts: at(560), bpm: 72 }, { ts: at(560) + 40, bpm: 72 }], midnight).count,
  11,
);
// lib/heart.ts stamps and sends a reading; the card's listener stamps its own
// copy a few ms later. Once the server has the first, the copy isn't new.
const sent = { ...day, latest: { ts: at(545), bpm: 72, source: "band", agoMin: 0 }, count: 11 };
const heardAgain = heartView(sent, [{ ts: at(545) + 3, bpm: 72 }], midnight);
eq("the card's copy of the server's latest reading counts once", [heardAgain.count, heardAgain.avg, heardAgain.points.length], [11, 66, 2]);
eq("…and the latest stays the server's", heardAgain.latest, { ts: at(545), bpm: 72, source: "band" });
eq("a different bpm a few seconds after the server's latest is a new reading", heartView(sent, [{ ts: at(545) + 3_000, bpm: 75 }], midnight).count, 12);
eq(
  "two readings of the same bpm minutes apart are two",
  heartView(day, [{ ts: at(560), bpm: 72 }, { ts: at(565), bpm: 72 }], midnight).count,
  12,
);
eq("a misread (0, 250) is dropped", heartView(day, [{ ts: at(560), bpm: 0 }, { ts: at(561), bpm: 250 }], midnight).count, 10);

const empty = { ...day, latest: null, low: null, avg: null, high: null, count: 0, raisedMin: 0, points: [] };
eq(
  "yesterday's unsent readings aren't today's latest",
  heartView(empty, [{ ts: midnight - 10 * MIN, bpm: 70 }], midnight).latest,
  null,
);
const first = heartView(empty, [{ ts: at(5), bpm: 70 }, { ts: at(10), bpm: 80 }], midnight);
eq("a day with nothing on the server yet takes the local average", [first.avg, first.low, first.high, first.count], [75, 70, 80, 2]);

// ---------- the day's line ----------

const fullDay = Array.from({ length: 288 }, (_, i) => ({ ts: at(i * 5), bpm: i % 2 ? 90 : 60 }));
const line = evenOut(fullDay, 60);
eq("a full day is drawn through 60 points", line.length, 60);
eq("it still ends on the latest reading", line[59], fullDay[287]);
eq("a jagged run is averaged, not sampled (60/90 → 72-78)", line.slice(0, -1).every((p) => p.bpm >= 72 && p.bpm <= 78), true);
eq("a short day is drawn as it is", evenOut(fullDay.slice(0, 10), 60).length, 10);

// ---------- the week ----------

const week: any[] = [
  { day: "2026-09-23", restingBpm: 60, steps: 1200, sleep: { asleepMin: 420 }, workouts: [] },
  { day: "2026-09-21", restingBpm: null, steps: 8000, sleep: null, workouts: [] },
  { day: "2026-09-22", restingBpm: 64, steps: 6000, sleep: { asleepMin: 360 }, workouts: [] },
];
eq("resting bars are oldest first, null where there's none", restingWeek(week), [
  { day: "2026-09-21", bpm: null },
  { day: "2026-09-22", bpm: 64 },
  { day: "2026-09-23", bpm: 60 },
]);
eq("averages leave today's steps out; each over the days that have it", weekAverages(week, "2026-09-23"), {
  sleepMin: 390,
  restingBpm: 62,
  steps: 7000,
});
eq("one day isn't a week", weekAverages(week.slice(0, 1), "2026-09-24"), { sleepMin: null, restingBpm: null, steps: null });

// ---------- words ----------

eq("45 min", hoursMinutes(45), "45 min");
eq("an hour", hoursMinutes(60), "1 h");
eq("7 h 10 min", hoursMinutes(430), "7 h 10 min");
eq("just now", ago(at(0), at(0) + 20_000), "just now");
eq("minutes ago", ago(at(0), at(12)), "12 min ago");
eq("hours ago", ago(at(0), at(185)), "3 h ago");

// ---------- sleep & body ----------

const bar = stageBar({ core: 240, deep: 60, rem: 100, awake: 20 });
eq("stages deepest first", bar.map((s) => s.stage), ["deep", "core", "rem", "awake"]);
eq("shares add up to the night", Math.round(bar.reduce((a, s) => a + s.share, 0) * 1000) / 1000, 1);
eq("no stages, no bar", stageBar(undefined), []);
eq("a stage of zero isn't drawn", stageBar({ core: 300, deep: 0 }).map((s) => s.stage), ["core"]);

const fromServer = bodyFromServer({
  day: "2026-09-23",
  hrvMs: null,
  spo2Pct: 97,
  respRate: null,
  weightKg: 71.4,
  activeKcal: 103,
  exerciseMin: null,
  standHours: null,
  sleep: { asleepMin: 0, inBedMin: 0 },
  workouts: [{ type: "Run", start: at(180), minutes: 32, avgBpm: 141, from: "band" }],
} as any);
eq(
  "the server's nulls are no tile",
  [fromServer.hrvMs, fromServer.respRate, fromServer.spo2Pct, fromServer.weightKg].map((v) => (v === undefined ? "none" : v)),
  ["none", "none", 97, 71.4],
);
eq("a night with nothing in it is no night", fromServer.sleep, undefined);
eq("a workout keeps its time and the server's average", [fromServer.workouts[0].start, fromServer.workouts[0].avgBpm], [at(180), 141]);
eq("in bed only is still a night (shown as In bed)", bodyFromServer({ ...week[0], sleep: { asleepMin: 0, inBedMin: 480 } }).sleep?.inBedMin, 480);

const nothing: Body = { workouts: [] };
eq("an empty day has no tiles", hasBody(nothing), false);
eq("active energy alone is a tile", hasBody({ workouts: [], activeKcal: 103 }), true);

eq("reading off wins over everything", healthHint({ workouts: [], sleep: { asleepMin: 400 } }, true), "cant_read");
eq("no sleep and no HRV: what a watch would add", healthHint({ workouts: [], activeKcal: 103 }, false), "watch");
eq("sleep there: nothing to say", healthHint({ workouts: [], sleep: { asleepMin: 400 } }, false), null);
eq("HRV there: nothing to say", healthHint({ workouts: [], hrvMs: 48 }, false), null);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
