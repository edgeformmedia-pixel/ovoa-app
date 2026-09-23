// Food (food.ts): the sanity clamp, the catalog match, a day's totals, the
// tracking level's rules and the "lower than usual" check.
//
// The clamp is the part that decides whether the numbers can be trusted at all:
// a model that says a tablespoon of oil is 40 kcal has to be corrected, and a
// clamp that argues with bacon has to not exist. The level rules are the part
// that decides whether the feature is pleasant to leave on.

import {
  BOUNDS,
  catalogMatches,
  clampItem,
  dayTotals,
  foodAssistant,
  foodPrompt,
  levelRules,
  lowerThanUsual,
  normalizeFood,
  parseItem,
  pickEntry,
  sayKcal,
  type FoodItem,
} from "../src/food";
import { buckets } from "../src/time";
import { namedTools, SPOKEN_CORE, toolbelt, TYPED_CORE } from "../src/toolbelt";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

const item = (over: Partial<FoodItem>): FoodItem => ({
  name: "thing",
  grams: 100,
  kcal: 100,
  protein: null,
  carbs: null,
  fat: null,
  category: "mixed",
  ...over,
});

// ---------- The clamp ----------

const oil = clampItem(item({ name: "olive oil", grams: 14, kcal: 40, category: "fat" }));
eq("a tablespoon of oil at 40 kcal is corrected up", oil.kcal, 91);
eq("and marked as corrected", oil.estimated, "clamped");
const bacon = clampItem(item({ name: "bacon", grams: 30, kcal: 162, category: "protein" }));
eq("bacon at 540 per 100 g is believed", bacon.kcal, 162);
eq("and not marked", bacon.estimated, "ok");
eq("porridge made with water is believed", clampItem(item({ grams: 250, kcal: 178, category: "grain" })).estimated, "ok");
eq("crisps are believed", clampItem(item({ grams: 40, kcal: 214, category: "grain" })).estimated, "ok");
eq("water is 0 and fine", clampItem(item({ grams: 500, kcal: 0, category: "drink" })).estimated, "ok");
eq("rice at 50 per 100 g goes to the bound, not the middle", clampItem(item({ grams: 200, kcal: 100, category: "grain" })).kcal, 120);
eq("salad at 900 per 100 g comes down", clampItem(item({ grams: 100, kcal: 900, category: "veg" })).kcal, BOUNDS.veg[1]);
eq("negative calories are corrected", clampItem(item({ grams: 100, kcal: -50, category: "fruit" })).kcal, BOUNDS.fruit[0]);
eq("no weight: a sane number stands", clampItem(item({ grams: null, kcal: 900 })).kcal, 900);
eq("no weight: an absurd one is capped", clampItem(item({ grams: null, kcal: 90_000 })).kcal, 5000);
eq("a zero weight is no weight", clampItem(item({ grams: 0, kcal: 300 })).grams, null);
eq("a ten-kilo portion is capped", clampItem(item({ grams: 10_000, kcal: 20_000 })).grams, 3000);
const lean = clampItem(item({ grams: 100, kcal: 100, protein: 80, category: "protein" }));
eq("protein can't carry more calories than the food", lean.protein, 25);
eq("negative fat is dropped", clampItem(item({ fat: -3 })).fat, null);
eq("fat can't carry more calories than the food", clampItem(item({ grams: 100, kcal: 90, fat: 20 })).fat, 10);

eq("an item with no calories is not an item", parseItem({ name: "toast" }), null);
eq("nor one with no name", parseItem({ kcal: 100 }), null);
eq("numbers sent as words are read", parseItem({ name: "toast", kcal: "120 kcal", grams: "40" })?.grams, 40);
eq("an unknown category is mixed", parseItem({ name: "toast", kcal: 120, category: "carbs" })?.category, "mixed");

// ---------- The catalog ----------

eq("one row for any spelling", normalizeFood("  Some Olive-Oil "), "olive oil");
eq("accents are letters", normalizeFood("Crème brûlée"), "crème brûlée");
eq("within the band, the catalog answers", catalogMatches({ grams: 400, kcal: 1000 }, { kcal_100g: 225 }), true);
eq("well outside it, a different food", catalogMatches({ grams: 400, kcal: 1400 }, { kcal_100g: 225 }), false);
eq("no weight, no match", catalogMatches({ grams: null, kcal: 900 }, { kcal_100g: 225 }), false);
eq("nothing stored, no match", catalogMatches({ grams: 400, kcal: 900 }, null), false);

const entries = [{ name: "Coffee with milk" }, { name: "Chicken burrito" }, { name: "Banana" }];
eq("a correction means the last one logged", pickEntry(entries, undefined)?.name, "Coffee with milk");
eq("or the one it names", pickEntry(entries, "the burrito")?.name, "Chicken burrito");
eq("and nothing when it names nothing there", pickEntry(entries, "pizza"), null);

// ---------- A day ----------

eq(
  "a day's totals",
  dayTotals([
    { kcal: 450.4, protein_g: 20 },
    { kcal: 120, protein_g: null },
    { kcal: 889.9, protein_g: 31.6 },
  ]),
  { kcal: 1460, protein: 52, entries: 3 },
);
eq("an empty day is zero", dayTotals([]), { kcal: 0, protein: 0, entries: 0 });

// A food day starts at local midnight (decision 11), in their zone, across a clock change.
const NY = "America/New_York";
eq("a minute before midnight is that day", buckets(Date.UTC(2026, 10, 1, 3, 59), NY).day, "2026-10-31");
eq("a minute after is the next", buckets(Date.UTC(2026, 10, 1, 4, 1), NY).day, "2026-11-01");
eq("the night the clocks go back, 1 a.m. is still that day", buckets(Date.UTC(2026, 10, 1, 6, 30), NY).day, "2026-11-01");

// ---------- The level ----------

eq("nothing set up: never asks, and says nothing", levelRules(null), { asks: "never", quiet: true, about: true });
eq("quick never asks, but says it", levelRules("quick"), { asks: "never", quiet: false, about: true });
eq("normal asks one question", levelRules("normal").asks, "one");
eq("strict asks for the details", levelRules("strict").asks, "details");
eq("'about' at quick", sayKcal(947, "quick"), "about 950");
eq("'about' at normal", sayKcal(1482, "normal"), "about 1,480");
eq("the plain number at strict", sayKcal(947, "strict"), "947");
eq("'roughly' at strict when it was corrected", sayKcal(91, "strict", true), "roughly 91");
eq("asked with nothing set up, it's 'about'", sayKcal(947, null), "about 950");
eq("never below zero", sayKcal(-20, "strict"), "0");

const quiet = foodPrompt(null);
eq("nothing set up: no questions", quiet.includes("don't ask about it"), true);
eq("and no numbers", quiet.includes("no calorie numbers"), true);
eq("quick never asks", foodPrompt("quick").includes("Never ask about food"), true);
eq("normal asks what kind", foodPrompt("normal").includes("What kind of burrito?"), true);
eq("strict says the plain number", foodPrompt("strict").includes("no \"about\""), true);
eq("'just log it' ends the questions once there are any", foodPrompt("normal").includes("Just log it"), true);
for (const level of [null, "quick", "normal", "strict"] as const) {
  const p = foodPrompt(level);
  eq(`${level ?? "unset"}: never praises eating less or moralises`, p.includes("Never praise eating less") && p.includes("never moralise"), true);
  eq(`${level ?? "unset"}: the prompt stays short`, p.length < 900, true);
}

// ---------- Lower than usual ----------

const TODAY = "2026-09-23";
const days = (from: number, to: number, kcal: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ day: `2026-09-${String(from + i).padStart(2, "0")}`, kcal }));
eq("a week well under their usual", lowerThanUsual([...days(10, 15, 2200), ...days(16, 22, 1300)], TODAY), true);
eq("a week like their usual", lowerThanUsual([...days(10, 15, 2200), ...days(16, 22, 2000)], TODAY), false);
eq("a little lower is not clearly lower", lowerThanUsual([...days(10, 15, 2200), ...days(16, 22, 1800)], TODAY), false);
eq("too few days this week to say", lowerThanUsual([...days(10, 15, 2200), ...days(20, 22, 900)], TODAY), false);
eq("too little before to know their usual", lowerThanUsual([...days(14, 15, 2200), ...days(16, 22, 900)], TODAY), false);
eq("today doesn't count: it isn't over", lowerThanUsual([...days(10, 15, 2200), ...days(19, 22, 2200), { day: TODAY, kcal: 100 }], TODAY), false);
eq("days with nothing noted aren't days of nothing", lowerThanUsual([...days(10, 15, 2200), ...days(16, 22, 0)], TODAY), false);

// ---------- In a turn ----------

const tools = foodAssistant({} as Env, "u1", "UTC").tools;
const spoken = toolbelt(tools, SPOKEN_CORE);
eq("a spoken turn carries food_log", spoken.tools.some((t) => t.name === "food_log"), true);
eq("and food_amend", spoken.tools.some((t) => t.name === "food_amend"), true);
eq("a typed turn too", toolbelt(tools, TYPED_CORE).tools.some((t) => t.name === "food_log"), true);
eq("the goal and the day are a more_tools away", spoken.tools.some((t) => t.name === "food_target" || t.name === "food_today"), false);
eq("'how many calories today' names the day's tool", namedTools(tools, "how many calories have I had today")[0]?.name, "food_today");
eq("'what did I eat yesterday' brings it along", toolbelt(tools, SPOKEN_CORE).preload("what did I eat yesterday").includes("food_today"), true);
eq("'I had a burrito' needs nothing brought", toolbelt(tools, SPOKEN_CORE).preload("I had a burrito").length, 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
