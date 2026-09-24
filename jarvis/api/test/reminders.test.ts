// When a reminder being set is one already set (alarms.ts sameReminder). "Hey
// OVOA" on its own was answered by setting the 10 AM water check a second time,
// three turns after the first, and the band would have buzzed twice for it
// (action_log, 2026-09-24).

import { sameReminder } from "../src/alarms";
import { sameSubject } from "../src/routines";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const ten = Date.UTC(2026, 8, 24, 14, 0);
const min = 60_000;

eq(
  "the two water checks at 10 AM that night",
  sameReminder(
    { text: "Water check: refill and keep going — a gallon by bedtime!", at: ten },
    { text: "Water check — about half your gallon by now?", at: ten },
  ),
  true,
);
eq("the same thing a few minutes apart", sameReminder({ text: "Take the vitamins", at: ten }, { text: "vitamins", at: ten + 15 * min }), true);
eq("the same thing hours apart is two reminders", sameReminder({ text: "Water check", at: ten }, { text: "Water check", at: ten + 8 * 60 * min }), false);
eq("two things at the same time", sameReminder({ text: "Water check", at: ten }, { text: "Gym check — have you gone yet today?", at: ten }), false);
eq("only filler words in common", sameReminder({ text: "Make sure to call Mom", at: ten }, { text: "Make sure the oven is off", at: ten }), false);

// Routines (routines.ts existingRoutine): the gym and water ones were added a
// second time the next turn (followup-probe against production, 2026-09-24).
eq("'Gym' and 'Gym check' are one routine", sameSubject("Gym", "Gym check"), true);
eq("'Water' and 'Gallon of water' are one routine", sameSubject("Water", "Drink a gallon of water"), true);
eq("'Water' and 'Gym' are two", sameSubject("Water", "Gym"), false);
eq("'Daily water check' and 'Daily gym check' are two", sameSubject("Daily water check", "Daily gym check"), false);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
