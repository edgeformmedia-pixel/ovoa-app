// Turning points into visits and places, and heart rate into workouts. All of
// these decide something the user sees ("you were at the gym for 50 minutes",
// "that looked like a strength session"), so the edge cases are the ones that
// would make it say something plainly wrong.

import { findSessions, restingBaseline, type Sample } from "../src/heart";
import { distanceM, findPlaces, foldPoints, guessKind, placeFor, type Visit } from "../src/location";
import { atLocalTime } from "../src/time";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const NY = "America/New_York";
const HOME = { lat: 42.4906, lng: -83.1446 };
const GYM = { lat: 42.5, lng: -83.13 };
const M = 60_000;
let n = 0;
const id = () => `v${++n}`;

// ---------- Location ----------

eq("distance is in metres", Math.round(distanceM(HOME, { lat: HOME.lat + 0.001, lng: HOME.lng })), 111);

const t0 = atLocalTime("2026-09-21", 9 * 60, NY);
const stay = Array.from({ length: 10 }, (_, i) => ({ ts: t0 + i * 3 * M, lat: HOME.lat + (i % 2) * 0.0002, lng: HOME.lng }));
const one = foldPoints(null, stay, id);
eq("points in one spot are one visit", one.length, 1);
eq("the visit spans them", one[0].left_at - one[0].arrived, 27 * M);

const moved = foldPoints(one[0], [{ ts: t0 + 40 * M, lat: GYM.lat, lng: GYM.lng }], id);
eq("a point far away starts a new visit", moved.length === 1 && moved[0].id !== one[0].id, true);

const gap = foldPoints(one[0], [{ ts: t0 + 27 * M + 60 * M, lat: HOME.lat, lng: HOME.lng }], id);
eq("an hour's silence ends a visit, even in the same spot", gap[0].id !== one[0].id, true);

const noisy = foldPoints(one[0], [{ ts: t0 + 30 * M, lat: GYM.lat, lng: GYM.lng, accuracy: 900 }], id);
eq("a cell-tower fix is ignored", noisy.length, 0);

const late = foldPoints(one[0], [{ ts: t0, lat: GYM.lat, lng: GYM.lng }], id);
eq("an old point doesn't reopen anything", late.length, 0);

// Five nights at home, three weekday mornings at work, two gym visits.
const visits: Visit[] = [];
for (let d = 14; d <= 18; d++) {
  const night = atLocalTime(`2026-09-${d}`, 22 * 60, NY);
  visits.push({ id: id(), ...HOME, arrived: night, left_at: night + 9 * 60 * M, points: 20, place_id: null });
}
const WORK = { lat: 42.33, lng: -83.05 };
for (const d of [14, 15, 16]) {
  const morning = atLocalTime(`2026-09-${d}`, 9 * 60 + 15, NY);
  visits.push({ id: id(), ...WORK, arrived: morning, left_at: morning + 7 * 60 * M, points: 20, place_id: null });
}
for (const d of [15, 17]) {
  const evening = atLocalTime(`2026-09-${d}`, 18 * 60, NY);
  visits.push({ id: id(), ...GYM, arrived: evening, left_at: evening + 60 * M, points: 10, place_id: null });
}
const found = findPlaces(visits, NY);
eq("two places seen on three days or more", found.length, 2);
eq("nights make home", found.find((p) => distanceM(p, HOME) < 50)?.kind, "home");
eq("weekday hours make work", found.find((p) => distanceM(p, WORK) < 50)?.kind, "work");
eq("two gym visits aren't a place yet", found.some((p) => distanceM(p, GYM) < 50), false);
eq("an evening hour is just 'other'", guessKind(visits.slice(-2), NY), "other");

const places = [{ id: "p1", name: "Home", kind: "home" as const, ...HOME, radius: 100, address: null, visit_count: 5 }];
eq("a spot near home is home", placeFor({ lat: HOME.lat + 0.0005, lng: HOME.lng }, places)?.id, "p1");
eq("the gym isn't", placeFor(GYM, places), null);

// ---------- Heart rate ----------

const at = (min: number) => atLocalTime("2026-09-21", 17 * 60, NY) + min * M;
const flat = (from: number, to: number, bpm: number, step = 1): Sample[] =>
  Array.from({ length: Math.floor((to - from) / step) }, (_, i) => ({ ts: at(from + i * step), bpm }));

// The band's own run-in-place test: resting 61-67, climbing to 79. Not a workout.
eq("a short climb isn't a session", findSessions([...flat(0, 5, 64), ...flat(5, 8, 79)], 65, { now: at(60) }).length, 0);

// 30 minutes at 140 on a 65 resting rate, standing still: cardio.
const cardio = findSessions([...flat(0, 10, 66), ...flat(10, 40, 140), ...flat(40, 60, 70)], 65, { now: at(90) });
eq("a plateau is one session", cardio.length, 1);
eq("about thirty minutes", Math.round((cardio[0].end - cardio[0].start) / M), 29);
eq("standing still, it's cardio", cardio[0].kind, "cardio");
eq("average", cardio[0].avg, 140);

// The same plateau while the phone travelled 4 km: a run.
const run = findSessions([...flat(10, 40, 150), ...flat(40, 60, 70)], 65, { now: at(90), movedM: () => 4000 });
eq("moving, it's a run or walk", run[0].kind, "run_walk");

// Sets: up to 130 for a minute, down to 100 for two, for 30 minutes.
const sets: Sample[] = [];
for (let m = 0; m < 30; m += 3) sets.push(...flat(m, m + 1, 130, 0.25), ...flat(m + 1, m + 3, 100, 0.25));
const strength = findSessions([...sets, ...flat(30, 50, 68)], 65, { now: at(90) });
eq("sets and rests are strength", strength[0]?.kind, "strength");

// Still going: the last reading is a minute old and raised.
const going = findSessions(flat(0, 20, 140), 65, { now: at(20) });
eq("a session still going is open, not finished", going[0]?.open, true);

// A gap in the data isn't one long session.
const gapped = findSessions([...flat(0, 12, 140), ...flat(40, 52, 140)], 65, { now: at(120) });
eq("a half-hour gap splits it in two", gapped.length, 2);

// Resting: overnight readings win when there are enough.
const night = Array.from({ length: 40 }, (_, i) => ({ ts: atLocalTime("2026-09-21", 60 + i * 5, NY), bpm: 55 + (i % 3) }));
const day = Array.from({ length: 40 }, (_, i) => ({ ts: atLocalTime("2026-09-21", 12 * 60 + i * 5, NY), bpm: 85 }));
eq("resting comes from the night", restingBaseline([...night, ...day], NY), 56);
eq("with no data, a sensible default", restingBaseline([], NY), 65);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
