// What counts as "usual". Get this wrong and OVOA asks "everything alright?"
// about a gym it went to twice, or never notices the one it goes to every day.

import { learnExpectations } from "../src/rhythm";
import { atLocalTime } from "../src/time";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const NY = "America/New_York";
// Two weeks: Monday 2026-09-07 to Sunday 2026-09-20.
const from = atLocalTime("2026-09-07", 0, NY);
const to = atLocalTime("2026-09-21", 0, NY);
const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}`;
const weekdays = [7, 8, 9, 10, 11, 14, 15, 16, 17, 18];

// The gym every weekday at 6pm, give or take.
const gym = weekdays.map((d, i) => ({ kind: "visit" as const, placeId: "gym", label: "going to the gym", at: atLocalTime(day(d), 18 * 60 + (i % 3) * 10, NY) }));
const found = learnExpectations(gym, from, to, NY);
eq("every weekday is usual", found.length, 1);
eq("on weekdays", found[0]?.days.join(","), "1,2,3,4,5");
eq("the window opens half an hour before the usual time", found[0]?.windowStart, 18 * 60 + 10 - 30);
eq("and runs an hour and a half after", found[0]?.windowEnd, 18 * 60 + 10 + 90);
eq("strength is how often", found[0]?.strength, 1);

// Seven weekdays out of ten: not usual enough.
eq("seven in ten isn't usual", learnExpectations(gym.slice(0, 7), from, to, NY).length, 0);
// Eight out of ten is.
eq("eight in ten is", learnExpectations(gym.slice(0, 8), from, to, NY).length, 1);

// Saturday runs, both weekends: usual on weekends, and says nothing about weekdays.
const runs = [12, 13, 19, 20].map((d) => ({ kind: "workout" as const, placeId: null, label: "working out", at: atLocalTime(day(d), 9 * 60, NY) }));
const weekend = learnExpectations(runs, from, to, NY);
eq("weekend workouts are a weekend habit", weekend.length === 1 && weekend[0].days.join(",") === "0,6", true);

// Nothing at all learns nothing.
eq("no data, no expectations", learnExpectations([], from, to, NY).length, 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
