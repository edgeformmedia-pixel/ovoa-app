import { Hono } from "hono";
import { z } from "zod";
import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { addDays, atLocalTime, buckets } from "./time";
import type { Env, Vars } from "./types";

// Food. See migrations/0040_food.sql and docs/food.md (its "Decisions" section,
// and the release brief's Phase 8, win over the older parts of it).
//
// Every calorie app is a search box. This is the other way round: someone says
// "I had a burrito" in passing and the model, which already knows roughly what
// a burrito weighs, fills in the grams and the calories as tool arguments in the
// turn it was taking anyway. No lookup, no second model call.
//
// How much OVOA says about it depends on the tracking level, profile.food_detail:
//   NULL    nothing set up (everyone on Base, with no install). Food is noted
//           quietly, as at quick, and no number is said unless they ask.
//   quick   never asks; says what it assumed and "about 900".
//   normal  the default once Calorie is installed: one question, only when the
//           answer moves the number a lot ("what kind of burrito?").
//   strict  asks what it needs for a close number, then says the plain number.
// "Just log it" ends the questions at any level.
//
// And whatever the level, the rules that make a food feature safe to leave on:
// never praise eating less, never comment on going over, no streaks, no red, no
// moralising, and never a word about eating disorders. The tool results hand
// the model neutral facts to say, so it has no arithmetic to editorialise on.
//
// A food day starts at local midnight, like every other day in OVOA (decision
// 11): `day` is the user's local date when it was eaten.

export type FoodLevel = "quick" | "normal" | "strict";
export const FOOD_LEVELS: readonly FoodLevel[] = ["quick", "normal", "strict"];
export const isFoodLevel = (v: unknown): v is FoodLevel => typeof v === "string" && (FOOD_LEVELS as readonly string[]).includes(v);

export type Category = "fat" | "grain" | "protein" | "veg" | "fruit" | "dairy" | "drink" | "sweet" | "mixed";
const CATEGORIES: readonly Category[] = ["fat", "grain", "protein", "veg", "fruit", "dairy", "drink", "sweet", "mixed"];

/** Rows older than this are deleted by the nightly purge (Phase 6 adds it; see the migration). */
export const FOOD_RETAIN_DAYS = 14;
/** The same food logged again inside this window is the model re-reading "I had a burrito", not a second burrito. */
export const DEDUPE_MS = 20 * 60_000;
/** Inside this share of the stored kcal per 100 g, the catalog's number wins: the same meal costs the same. */
export const CATALOG_BAND = 0.3;
const MAX_ITEMS = 12;
const MAX_GRAMS = 3000;
const MAX_ITEM_KCAL = 5000;

// ---------- The sanity clamp ----------

/**
 * kcal per 100 g, low and high, per category. A model that says a tablespoon of
 * oil is 40 kcal is corrected, not believed: fat is the one number every food
 * tracker gets wrong, because it can't be seen.
 *
 * Wider than docs/food.md's first draft on purpose. They're there to catch the
 * model's slips, not to argue with real food: bacon is 540, crisps 536, granola
 * 470, porridge made with water 71, spirits 231, and none of those should be
 * "corrected". And out of bounds moves the estimate to the nearest bound rather
 * than the midpoint: rice at 50 kcal per 100 g becomes 60, not 305.
 */
export const BOUNDS: Record<Category, [number, number]> = {
  fat: [650, 900],
  grain: [60, 550],
  protein: [70, 650],
  veg: [10, 200],
  fruit: [15, 400],
  dairy: [30, 450],
  drink: [0, 350],
  sweet: [100, 600],
  mixed: [40, 600],
};

export type FoodItem = {
  name: string;
  grams: number | null;
  kcal: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  category: Category;
};

export type ClampedItem = FoodItem & { estimated: "ok" | "clamped" };

/** A number from whatever the model sent: 150, "150", "150 g". Null when there isn't one. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ""));
  return m ? Number(m[0]) : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** One item as the model sent it, or null when it isn't a food with a calorie number. */
export function parseItem(raw: unknown): FoodItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 80) : "";
  const kcal = num(r.kcal);
  if (!name || kcal === null) return null;
  const category = CATEGORIES.includes(r.category as Category) ? (r.category as Category) : "mixed";
  return { name, grams: num(r.grams), kcal, protein: num(r.protein), carbs: num(r.carbs), fat: num(r.fat), category };
}

/**
 * Holds an estimate to what food can actually be. With a weight, the calories
 * per 100 g must sit inside the category's bounds; without one, an item is at
 * most MAX_ITEM_KCAL. Macros can't be negative, can't weigh more than the food,
 * and can't carry more calories than it has.
 */
export function clampItem(item: FoodItem): ClampedItem {
  const grams = item.grams !== null && item.grams > 0 ? Math.min(item.grams, MAX_GRAMS) : null;
  let kcal = item.kcal;
  let estimated: ClampedItem["estimated"] = "ok";
  if (grams !== null) {
    const [lo, hi] = BOUNDS[item.category];
    const per100 = (kcal / grams) * 100;
    if (!(per100 >= lo)) {
      kcal = (grams * lo) / 100;
      estimated = "clamped";
    } else if (per100 > hi) {
      kcal = (grams * hi) / 100;
      estimated = "clamped";
    }
  } else if (!(kcal >= 0) || kcal > MAX_ITEM_KCAL) {
    kcal = Math.max(0, Math.min(Number.isFinite(kcal) ? kcal : 0, MAX_ITEM_KCAL));
    estimated = "clamped";
  }
  const macro = (v: number | null, kcalPerGram: number) => {
    if (v === null || !(v >= 0)) return null;
    return round1(Math.min(v, kcal / kcalPerGram, grams ?? Infinity));
  };
  return {
    name: item.name,
    grams: grams === null ? null : round1(grams),
    kcal: round1(kcal),
    protein: macro(item.protein, 4),
    carbs: macro(item.carbs, 4),
    fat: macro(item.fat, 9),
    category: item.category,
    estimated,
  };
}

// ---------- The catalog ----------

const ARTICLES = new Set(["a", "an", "the", "some"]);

/** "Olive Oil", "olive oil " and "some olive oil" are one catalog row. */
export function normalizeFood(name: string) {
  const key = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !ARTICLES.has(w))
    .join(" ")
    .slice(0, 80);
  return key || name.trim().toLowerCase().slice(0, 80);
}

type CatalogRow = { key: string; kcal_100g: number; protein_100g: number | null; carbs_100g: number | null; fat_100g: number | null };

/**
 * Whether the catalog's number should stand in for the model's: only when the
 * model is describing the same food, which is when its calories per 100 g land
 * within CATALOG_BAND of the stored ones. Further off, it's a different food by
 * the same name (a burrito with everything on it), and the new number stands.
 */
export function catalogMatches(item: { grams: number | null; kcal: number }, row: { kcal_100g: number } | null) {
  if (!row || !item.grams || row.kcal_100g <= 0) return false;
  const per100 = (item.kcal / item.grams) * 100;
  return Math.abs(per100 - row.kcal_100g) <= CATALOG_BAND * row.kcal_100g;
}

/** The item with the catalog's numbers, scaled to this portion. */
function withCatalog(item: ClampedItem, row: CatalogRow): ClampedItem {
  const g = item.grams!;
  const scale = (per100: number | null, fallback: number | null) => (per100 === null ? fallback : round1((per100 * g) / 100));
  return {
    ...item,
    kcal: round1((row.kcal_100g * g) / 100),
    protein: scale(row.protein_100g, item.protein),
    carbs: scale(row.carbs_100g, item.carbs),
    fat: scale(row.fat_100g, item.fat),
    estimated: "ok",
  };
}

// ---------- Saying it ----------

/**
 * What each level means, for the prompt and for the numbers in tool results.
 *   asks    never | one question | the details
 *   quiet   noted without a word and without a number (no level set up)
 *   about   "about 950" rather than "950"
 */
export function levelRules(level: FoodLevel | null) {
  return {
    asks: level === "strict" ? "details" : level === "normal" ? "one" : "never",
    quiet: level === null,
    about: level !== "strict",
  } as const;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * A calorie number the way OVOA says it: "about 950" at quick and normal (and
 * when nothing is set up and they asked), the plain "950" at strict. "Roughly"
 * at strict when the estimate had to be corrected, because then it isn't close.
 * On screen the number is always plain; this is only for what's said.
 */
export function sayKcal(kcal: number, level: FoodLevel | null, clamped = false) {
  const n = Math.max(0, kcal);
  if (!levelRules(level).about) return `${clamped ? "roughly " : ""}${fmt(n)}`;
  return `about ${fmt(Math.round(n / 10) * 10)}`;
}

/** A day's numbers, from its rows. */
export function dayTotals(rows: { kcal: number; protein_g: number | null }[]) {
  let kcal = 0;
  let protein = 0;
  for (const r of rows) {
    kcal += r.kcal;
    protein += r.protein_g ?? 0;
  }
  return { kcal: Math.round(kcal), protein: Math.round(protein), entries: rows.length };
}

// ---------- Lower than usual ----------

/** Recent days under this share of the ones before are "clearly lower". */
export const LOWER_SHARE = 0.75;
const RECENT_DAYS_NEEDED = 4;
const USUAL_DAYS_NEEDED = 3;

/**
 * Whether the last week is clearly lower than their own usual, from day totals
 * of the last fortnight (which is all there is: food_log keeps 14 days). The
 * week is the seven days before today, and their usual is the days before that.
 * Only days with something logged count on either side, since a day with
 * nothing noted is a day not told about, not a day of not eating.
 *
 * It compares them with themselves and never with a number, and what's said is
 * a question ("did I miss anything?"), because the likeliest reason is a week
 * of not mentioning it.
 */
export function lowerThanUsual(days: { day: string; kcal: number }[], today: string) {
  const weekFrom = addDays(today, -7);
  const usualFrom = addDays(today, -(FOOD_RETAIN_DAYS - 1));
  const recent = days.filter((d) => d.day >= weekFrom && d.day < today && d.kcal > 0);
  const usual = days.filter((d) => d.day >= usualFrom && d.day < weekFrom && d.kcal > 0);
  if (recent.length < RECENT_DAYS_NEEDED || usual.length < USUAL_DAYS_NEEDED) return false;
  const avg = (xs: { kcal: number }[]) => xs.reduce((n, d) => n + d.kcal, 0) / xs.length;
  return avg(recent) < LOWER_SHARE * avg(usual);
}

/** Rides on the message (index.ts `moment`) the one time a week it's said. */
export const LOWER_THAN_USUAL_NOTE =
  "What they've told you they ate this past week is clearly less than their usual. Once, at the end of your reply, ask lightly: \"That's lower than usual, did I miss anything?\" Say nothing else about it: no numbers, no advice.";

// ---------- Settings: the level and the target ----------

export type FoodSettings = {
  level: FoodLevel | null;
  /** They picked a level (the add-on's first question, by voice or in setup), so the add-on doesn't ask. */
  chosen: boolean;
  target: { kcal: number | null; protein: number | null };
};

export async function foodSettings(db: D1Database, userId: string): Promise<FoodSettings> {
  const row = await db
    .prepare("SELECT food_detail, food_detail_last, kcal_target, protein_target FROM profile WHERE user_id = ?")
    .bind(userId)
    .first<{ food_detail: string | null; food_detail_last: string | null; kcal_target: number | null; protein_target: number | null }>();
  return {
    level: isFoodLevel(row?.food_detail) ? row!.food_detail as FoodLevel : null,
    chosen: isFoodLevel(row?.food_detail_last),
    target: { kcal: row?.kcal_target ?? null, protein: row?.protein_target ?? null },
  };
}

/** Changes profile columns, making the row first for someone who never did setup. */
async function updateProfile(db: D1Database, userId: string, sets: string, values: unknown[]) {
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO profile (user_id, updated_at) VALUES (?, ?)").bind(userId, now),
    db.prepare(`UPDATE profile SET ${sets}, updated_at = ? WHERE user_id = ?`).bind(...values, now, userId),
  ]);
}

/**
 * They chose how closely: on the add-on's first open, by voice ("be more
 * exact"), or in setup when a goal is about eating (onboarding). Remembered in
 * food_detail_last too, so removing Calorie and adding it back keeps it.
 */
export async function setFoodLevel(db: D1Database, userId: string, level: FoodLevel) {
  await updateProfile(db, userId, "food_detail = ?, food_detail_last = ?", [level, level]);
}

/**
 * Calorie was installed or removed on the phone. Installing turns the level on:
 * the last one they chose, or normal. Removing turns it off (back to noting
 * quietly) and keeps what they chose for next time.
 */
export async function setCalorieInstalled(db: D1Database, userId: string, installed: boolean) {
  if (installed) await updateProfile(db, userId, "food_detail = COALESCE(food_detail, food_detail_last, 'normal')", []);
  else await updateProfile(db, userId, "food_detail = NULL", []);
}

/** A daily goal they stated. 0 or null clears it; undefined leaves it as it is. */
export async function setFoodTarget(db: D1Database, userId: string, t: { kcal?: number | null; protein?: number | null }) {
  const sets: string[] = [];
  const values: unknown[] = [];
  const clean = (v: number | null, max: number) => (v && v > 0 ? Math.min(Math.round(v), max) : null);
  if (t.kcal !== undefined) {
    sets.push("kcal_target = ?");
    values.push(clean(t.kcal, 10_000));
  }
  if (t.protein !== undefined) {
    sets.push("protein_target = ?");
    values.push(clean(t.protein, 1_000));
  }
  if (sets.length) await updateProfile(db, userId, sets.join(", "), values);
}

// ---------- Writing it down ----------

type LogRow = {
  id: string;
  day: string;
  ts: number;
  name: string;
  key: string;
  grams: number | null;
  kcal: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  category: string | null;
  source: string;
  estimated: string;
};

/** "2026-09-23T12:30" as a moment in their zone, if it's a real time that isn't in the future. */
function eatenAt(v: unknown, timeZone: string, now: number) {
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v) : null;
  if (!m) return now;
  const at = atLocalTime(m[1], Number(m[2]) * 60 + Number(m[3]), timeZone);
  // Not tomorrow, and not before what's still kept.
  if (!Number.isFinite(at) || at > now + 10 * 60_000 || at < now - (FOOD_RETAIN_DAYS - 1) * 86_400_000) return now;
  return at;
}

async function sumDay(db: D1Database, userId: string, day: string) {
  const { results } = await db
    .prepare("SELECT kcal, protein_g FROM food_log WHERE user_id = ? AND day = ?")
    .bind(userId, day)
    .all<{ kcal: number; protein_g: number | null }>();
  return dayTotals(results);
}

export type Logged = {
  day: string;
  items: (ClampedItem & { id: string; source: string })[];
  /** Named again inside DEDUPE_MS and not logged twice. */
  repeats: string[];
};

/**
 * Writes what was eaten: clamps each item, lets the catalog answer for foods it
 * knows, skips repeats of the last few minutes, and teaches the catalog the new
 * ones. Returns what was written.
 */
export async function logFood(
  db: D1Database,
  userId: string,
  timeZone: string,
  args: { items?: unknown; at?: unknown; again?: unknown },
  now = Date.now(),
): Promise<Logged | { error: string }> {
  const raw = Array.isArray(args.items) ? args.items.slice(0, MAX_ITEMS) : [];
  const items = raw.map(parseItem).filter((i): i is FoodItem => !!i).map(clampItem);
  if (!items.length) return { error: "items is required: each with a name, grams, kcal and category" };
  const ts = eatenAt(args.at, timeZone, now);
  const day = buckets(ts, timeZone).day;

  const keys = items.map((i) => normalizeFood(i.name));
  const marks = keys.map(() => "?").join(",");
  const [catalog, recent] = await db.batch([
    db.prepare(`SELECT key, kcal_100g, protein_100g, carbs_100g, fat_100g FROM food_catalog WHERE user_id = ? AND key IN (${marks})`).bind(userId, ...keys),
    db.prepare(`SELECT key FROM food_log WHERE user_id = ? AND created_at > ? AND key IN (${marks})`).bind(userId, now - DEDUPE_MS, ...keys),
  ]);
  const known = new Map((catalog.results as CatalogRow[]).map((r) => [r.key, r]));
  const lately = new Set((recent.results as { key: string }[]).map((r) => r.key));

  const written: Logged["items"] = [];
  const repeats: string[] = [];
  const statements: D1PreparedStatement[] = [];
  items.forEach((item, i) => {
    const key = keys[i];
    // Only against what was logged before this call: the same food twice in
    // one call is two of them ("two eggs" sent as two items).
    if (lately.has(key) && args.again !== true) {
      repeats.push(item.name);
      return;
    }
    const row = known.get(key) ?? null;
    const final = catalogMatches(item, row) ? withCatalog(item, row!) : item;
    const source = final === item ? "model" : "catalog";
    const id = crypto.randomUUID();
    written.push({ ...final, id, source });
    statements.push(
      db
        .prepare(
          `INSERT INTO food_log (id, user_id, day, ts, name, key, grams, kcal, protein_g, carbs_g, fat_g, category, source, estimated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, userId, day, ts, final.name, key, final.grams, final.kcal, final.protein, final.carbs, final.fat, final.category, source, final.estimated, now),
    );
    // What it costs per 100 g, kept the first time and reused after. A new
    // estimate that disagreed by more than the band doesn't overwrite it: the
    // stored one is either what they corrected it to or what they had first.
    if (final.grams) {
      const per100 = (v: number | null) => (v === null ? null : round1((v / final.grams!) * 100));
      statements.push(
        db
          .prepare(
            `INSERT INTO food_catalog (user_id, key, name, kcal_100g, protein_100g, carbs_100g, fat_100g, category, serving_g, source, uses, used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'model', 1, ?)
             ON CONFLICT(user_id, key) DO UPDATE SET uses = uses + 1, used_at = excluded.used_at, serving_g = excluded.serving_g`,
          )
          .bind(userId, key, final.name, per100(final.kcal), per100(final.protein), per100(final.carbs), per100(final.fat), final.category, final.grams, now),
      );
    }
  });
  if (statements.length) await db.batch(statements);
  return { day, items: written, repeats };
}

/** Recent entries, newest logged first: what "that" in a correction most likely means. */
async function recentEntries(db: D1Database, userId: string, now: number) {
  const { results } = await db
    .prepare(
      `SELECT id, day, ts, name, key, grams, kcal, protein_g, carbs_g, fat_g, category, source, estimated FROM food_log
        WHERE user_id = ? AND ts > ? ORDER BY created_at DESC LIMIT 30`,
    )
    .bind(userId, now - FOOD_RETAIN_DAYS * 86_400_000)
    .all<LogRow>();
  return results;
}

/** The entry "which" names (every word of it in the name), or the last one logged. */
export function pickEntry<T extends { name: string }>(rows: T[], which: unknown) {
  const words = typeof which === "string" ? normalizeFood(which).split(" ").filter(Boolean) : [];
  if (!words.length) return rows[0] ?? null;
  return rows.find((r) => words.every((w) => normalizeFood(r.name).includes(w))) ?? null;
}

export type Amend = { fraction?: number | null; grams?: number | null; kcal?: number | null };

/**
 * A correction: they ate half (fraction 0.5), none of it (0, which removes it),
 * a different weight (the calories follow it), or a different number outright
 * (which also teaches the catalog, so next time it's right to begin with).
 */
export async function amendEntry(db: D1Database, userId: string, row: LogRow, change: Amend) {
  if (change.fraction === 0) {
    await db.prepare("DELETE FROM food_log WHERE id = ? AND user_id = ?").bind(row.id, userId).run();
    return { removed: row.name, day: row.day, before: row.kcal, after: 0 };
  }
  let factor = 1;
  let grams = row.grams;
  if (change.fraction && change.fraction > 0) {
    factor = Math.min(change.fraction, 10);
    grams = grams === null ? null : grams * factor;
  } else if (change.grams && change.grams > 0) {
    const g = Math.min(change.grams, MAX_GRAMS);
    if (row.grams) factor = g / row.grams;
    grams = g;
  }
  let kcal = row.kcal * factor;
  let source = row.source;
  if (change.kcal !== undefined && change.kcal !== null && change.kcal >= 0) {
    const stated = Math.min(change.kcal, MAX_ITEM_KCAL);
    // The macros move with the calories, so protein doesn't stay at a burrito's
    // when they said it was a small one.
    if (row.kcal > 0) factor = stated / row.kcal;
    kcal = stated;
    source = "user";
  }
  const scale = (v: number | null) => (v === null ? null : round1(v * factor));
  const statements = [
    db
      .prepare("UPDATE food_log SET grams = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?, source = ?, estimated = ? WHERE id = ? AND user_id = ?")
      .bind(grams === null ? null : round1(grams), round1(kcal), scale(row.protein_g), scale(row.carbs_g), scale(row.fat_g), source, source === "user" ? "ok" : row.estimated, row.id, userId),
  ];
  // Their number for this food, per 100 g, for next time. Only when it's a
  // number food can have: "it was about 600" said of a tablespoon of oil is
  // about the whole plate, and the entry takes it but the catalog shouldn't.
  const per100 = grams ? (kcal / grams) * 100 : null;
  const [lo, hi] = BOUNDS[(row.category as Category) ?? "mixed"] ?? BOUNDS.mixed;
  if (source === "user" && per100 !== null && per100 >= lo && per100 <= hi) {
    statements.push(
      db
        .prepare("UPDATE food_catalog SET kcal_100g = ?, source = 'user', used_at = ? WHERE user_id = ? AND key = ?")
        .bind(round1(per100), Date.now(), userId, row.key),
    );
  }
  await db.batch(statements);
  return { amended: row.name, day: row.day, before: row.kcal, after: round1(kcal) };
}

// ---------- Reading it back ----------

export type FoodEntry = {
  id: string;
  ts: number;
  name: string;
  grams: number | null;
  kcal: number;
  protein: number | null;
  estimated: string;
};

const entryOf = (r: LogRow): FoodEntry => ({
  id: r.id,
  ts: r.ts,
  name: r.name,
  grams: r.grams === null ? null : Math.round(r.grams),
  kcal: Math.round(r.kcal),
  protein: r.protein_g === null ? null : Math.round(r.protein_g),
  estimated: r.estimated,
});

/**
 * Everything the Calorie screen shows, from one read: today's entries and
 * numbers, the last 14 days, the foods eaten most, and the protein average.
 * Numbers are plain here; "about" is only for what's said.
 */
export async function foodScreen(db: D1Database, userId: string, timeZone: string, now = Date.now()) {
  const today = buckets(now, timeZone).day;
  const [settings, rows] = await Promise.all([
    foodSettings(db, userId),
    db
      .prepare(
        `SELECT id, day, ts, name, key, grams, kcal, protein_g, carbs_g, fat_g, category, source, estimated FROM food_log
          WHERE user_id = ? AND day >= ? ORDER BY ts`,
      )
      .bind(userId, addDays(today, -(FOOD_RETAIN_DAYS - 1)))
      .all<LogRow>(),
  ]);
  const byDay = new Map<string, LogRow[]>();
  const byFood = new Map<string, { name: string; times: number }>();
  for (const r of rows.results) {
    const list = byDay.get(r.day);
    if (list) list.push(r);
    else byDay.set(r.day, [r]);
    const f = byFood.get(r.key);
    byFood.set(r.key, { name: r.name, times: (f?.times ?? 0) + 1 });
  }
  const todayRows = byDay.get(today) ?? [];
  const days = [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, list]) => ({ day, ...dayTotals(list) }));
  // Whole days only: today isn't over, and half a day would pull the average
  // down. And days with protein in them: at quick the model often leaves it out.
  const whole = days.filter((d) => d.day < today && d.protein > 0);
  return {
    ...settings,
    today: { day: today, ...dayTotals(todayRows), entries: todayRows.map(entryOf).reverse() },
    days,
    // Twice or more: a list of everything eaten once is just the log again.
    top: [...byFood.values()].filter((f) => f.times >= 2).sort((a, b) => b.times - a.times).slice(0, 5),
    proteinAvg: whole.length ? Math.round(whole.reduce((n, d) => n + d.protein, 0) / whole.length) : null,
  };
}

/**
 * One line about a day's food for the day summary (Phase 6's writer calls it),
 * or null when nothing was noted. The day's calorie total is kept past 14 days
 * only here, so the number is in it — but only for someone who set up tracking.
 * Someone who never asked to count calories gets what they ate and no number,
 * the same rule as in conversation.
 */
export async function foodDayLine(env: Pick<Env, "DB">, userId: string, day: string) {
  const [settings, rows] = await Promise.all([
    foodSettings(env.DB, userId),
    env.DB.prepare("SELECT name, key, kcal, protein_g FROM food_log WHERE user_id = ? AND day = ? ORDER BY ts")
      .bind(userId, day)
      .all<{ name: string; key: string; kcal: number; protein_g: number | null }>(),
  ]);
  if (!rows.results.length) return null;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.results) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    names.push(r.name);
  }
  const listed = names.length > 8 ? `${names.slice(0, 8).join(", ")} and ${names.length - 8} more` : names.join(", ");
  if (settings.level === null) return `Ate: ${listed}.`;
  const t = dayTotals(rows.results);
  return `Ate ${fmt(t.kcal)} kcal${t.protein ? ` and ${fmt(t.protein)} g protein` : ""}: ${listed}.`;
}

/**
 * What a turn needs before the model runs, in one round trip: the level (for
 * the prompt) and whether this is the once-a-week "lower than usual" turn. The
 * fortnight's day totals are only read for someone with a level set who hasn't
 * been asked this week; for everyone else the second query matches nothing.
 */
export async function foodTurn(db: D1Database, userId: string, timeZone: string, now = Date.now()) {
  const { day: today, week } = buckets(now, timeZone);
  const mark = `lower|${week}`;
  // A turn is never lost to food: if this read fails, food is noted quietly
  // this once and nobody is asked anything.
  const read = await db
    .batch([
      db.prepare("SELECT food_detail FROM profile WHERE user_id = ?").bind(userId),
      db
        .prepare(
          `SELECT day, SUM(kcal) AS kcal FROM food_log
            WHERE user_id = ? AND day >= ? AND day < ?
              AND EXISTS (SELECT 1 FROM profile p WHERE p.user_id = ? AND p.food_detail IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM daily_marks m WHERE m.user_id = ? AND m.kind = 'food' AND m.day = ?)
            GROUP BY day`,
        )
        .bind(userId, addDays(today, -(FOOD_RETAIN_DAYS - 1)), today, userId, userId, mark),
    ])
    .catch((err) => (console.error("food: couldn't read the turn's food settings", err), null));
  const detail = (read?.[0].results[0] as { food_detail: string | null } | undefined)?.food_detail;
  const lower = !!read && lowerThanUsual(read[1].results as { day: string; kcal: number }[], today);
  return {
    level: isFoodLevel(detail) ? detail : null,
    lower,
    /** Claims this week's question, once: true when this turn is the one to ask it. */
    claimLower: async () => {
      if (!lower) return false;
      const res = await db
        .prepare("INSERT OR IGNORE INTO daily_marks (user_id, kind, day, at) VALUES (?, 'food', ?, ?)")
        .bind(userId, mark, now)
        .run()
        .catch(() => null);
      return !!res?.meta.changes;
    },
  };
}

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "food_log",
    description:
      "Records food or drink they had ('had a burrito'). You estimate the grams and calories; never ask them to weigh anything.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              grams: { type: "number" },
              kcal: { type: "number" },
              protein: { type: "number" },
              carbs: { type: "number" },
              fat: { type: "number" },
              category: { type: "string", enum: CATEGORIES },
            },
            required: ["name", "grams", "kcal", "category"],
          },
        },
        at: { type: "string", description: "Local YYYY-MM-DDTHH:MM, if it wasn't just now." },
        again: { type: "boolean", description: "Another of something logged minutes ago." },
      },
      required: ["items"],
    },
  },
  {
    name: "food_amend",
    description: "Fixes a food entry ('only had half', 'it was about 600', 'I didn't eat that'); defaults to the last one.",
    parameters: {
      type: "object",
      properties: {
        which: { type: "string", description: "Words from it, if not the last." },
        fraction: { type: "number", description: "Share eaten: 0.5 half, 2 double, 0 removes it." },
        grams: { type: "number" },
        kcal: { type: "number" },
      },
    },
  },
  {
    name: "food_target",
    description:
      "Sets their daily food goal or how closely to track food: 'keep me to 2000 calories' (kcal; 0 clears it), 'stop asking, just log it' (detail quick), 'ask me what's in things' (normal), 'be more exact' (strict).",
    parameters: {
      type: "object",
      properties: {
        kcal: { type: "number" },
        protein: { type: "number", description: "Grams a day." },
        detail: { type: "string", enum: FOOD_LEVELS },
      },
    },
  },
  {
    name: "food_today",
    description: "What they've eaten, with calories and protein, today or on another day in the last two weeks. For 'how many calories have I had', 'what did I eat yesterday'.",
    parameters: { type: "object", properties: { day: { type: "string", description: "Local YYYY-MM-DD; default today." } } },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isFoodTool = (name: string) => NAMES.has(name);

/**
 * The food section of the prompt. food_log and food_amend are carried on every
 * turn (toolbelt.ts), so this is read before every reply: it earns its length.
 */
export function foodPrompt(level: FoodLevel | null) {
  const how =
    level === null
      ? "Log it quietly: don't ask about it, don't say you logged it, give no calorie numbers unless they ask, and reply as you normally would."
      : level === "quick"
        ? "Never ask about food: log your best guess, then say what you assumed and the calories with \"about\" (\"Logged a chicken burrito, about 900\")."
        : level === "normal"
          ? "Ask one short question only when the answer would change the calories a lot (\"What kind of burrito?\"); otherwise log your best guess. Say calories with \"about\"."
          : "Before logging, ask what you need for a close number (what kind, where from, the size, what's in it) in one sentence, at most twice, then log protein, carbs and fat too. Say the plain number, no \"about\".";
  return [
    "When they mention eating or drinking something, log it with food_log unasked (only what they had, not what they're cooking) and fix mistakes with food_amend.",
    how,
    level === null ? "" : "\"Just log it\" means stop asking and log your best guess.",
    "food_target sets a daily goal and how closely to track (\"be more exact\" is strict, \"stop asking\" quick).",
    "Never praise eating less, never comment on going over, never moralise about food, and never bring up eating disorders.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function foodAssistant(env: Env, userId: string, timeZone: string, { voice = false, level = null as FoodLevel | null } = {}) {
  const db = env.DB;
  const today = () => buckets(Date.now(), timeZone).day;

  /** The day's running numbers, said the way this level says them. */
  const dayFacts = async (day: string, lvl: FoodLevel | null, withProtein = lvl === "strict") => {
    const [t, s] = await Promise.all([sumDay(db, userId, day), foodSettings(db, userId)]);
    const left = s.target.kcal ? s.target.kcal - t.kcal : null;
    return {
      day: day === today() ? "today" : day,
      eaten: sayKcal(t.kcal, lvl),
      ...(withProtein && t.protein > 0 && { protein: `${t.protein} g` }),
      // Only while there's some left: going over gets no sentence of its own.
      ...(left !== null && left > 0 && { left: sayKcal(left, lvl) }),
    };
  };

  const callTool: CallTool = async (name, args) => {
    if (name === "food_log") {
      const done = await logFood(db, userId, timeZone, args);
      if ("error" in done) return done;
      const repeat = done.repeats.length
        ? { alreadyNoted: done.repeats, why: "Noted a few minutes ago, so not twice. If they really had another, call food_log again with again: true." }
        : {};
      if (level === null) {
        return { noted: done.items.map((i) => i.name), ...repeat, say: "Nothing about it: no number, and don't say you noted it." };
      }
      if (!done.items.length) return repeat;
      const kcal = done.items.reduce((n, i) => n + i.kcal, 0);
      const clamped = done.items.some((i) => i.estimated === "clamped");
      return {
        logged: done.items.map((i) => i.name),
        calories: sayKcal(kcal, level, clamped),
        ...(await dayFacts(done.day, level)),
        ...repeat,
        say: "One short sentence: what you logged, its number as given, and anything you assumed so they can correct you.",
      };
    }

    if (name === "food_amend") {
      const rows = await recentEntries(db, userId, Date.now());
      const row = pickEntry(rows, args.which);
      if (!row) return { error: rows.length ? "No entry matches that. Ask which one they mean." : "Nothing has been logged yet." };
      const done = await amendEntry(db, userId, row, { fraction: num(args.fraction), grams: num(args.grams), kcal: num(args.kcal) });
      const what = "removed" in done ? { removed: done.removed } : { changed: done.amended };
      // Nothing set up: fixed as quietly as it was noted.
      if (level === null) return { ...what, say: "No number." };
      return { ...what, ...("amended" in done && { now: sayKcal(done.after, level) }), ...(await dayFacts(done.day, level)) };
    }

    if (name === "food_target") {
      const detail = isFoodLevel(args.detail) ? args.detail : null;
      if (detail) await setFoodLevel(db, userId, detail);
      const kcal = num(args.kcal);
      const protein = num(args.protein);
      await setFoodTarget(db, userId, { ...(kcal !== null && { kcal }), ...(protein !== null && { protein }) });
      const s = await foodSettings(db, userId);
      return {
        detail: s.level ?? "quick (not set up)",
        dailyGoal: s.target.kcal ? `${fmt(s.target.kcal)} kcal` : "none",
        ...(s.target.protein && { protein: `${fmt(s.target.protein)} g` }),
        ...(detail && { note: "Their Calorie app follows this, and appears on their phone next time they open OVOA." }),
      };
    }

    if (name === "food_today") {
      const day = typeof args.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : today();
      const { results } = await db
        .prepare("SELECT name, kcal FROM food_log WHERE user_id = ? AND day = ? ORDER BY ts")
        .bind(userId, day)
        .all<{ name: string; kcal: number }>();
      // They asked, so there's a number whatever the level; "about" unless strict.
      const facts = await dayFacts(day, level, true);
      const had = results.map((r) => r.name);
      return {
        ...facts,
        // Six is as many as anyone can take in by ear.
        had: voice && had.length > 6 ? [...had.slice(-6), `and ${had.length - 6} earlier`] : had,
        ...(!had.length && { note: "Nothing noted for that day." }),
      };
    }

    return { error: `Unknown tool ${name}` };
  };

  return { tools: TOOLS, callTool, prompt: foodPrompt(level) };
}

// ---------- Routes ----------
//
// The Calorie screen. None of these call a model, so they're free (plans.ts,
// decision 5): someone who stops paying can still see and fix what they logged.
// Logging itself happens inside chat turns.

export const foodRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

async function tzOf(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  return validTimeZone(row?.time_zone);
}

foodRoutes.get("/food", async (c) => c.json(await foodScreen(c.env.DB, c.var.userId, await tzOf(c.env.DB, c.var.userId))));

foodRoutes.get("/food/settings", async (c) => c.json(await foodSettings(c.env.DB, c.var.userId)));

const settingsSchema = z.object({
  /** Calorie was added to or taken off the phone. */
  installed: z.boolean().optional(),
  /** Chosen on the add-on's first open. */
  level: z.enum(["quick", "normal", "strict"]).optional(),
  kcal: z.number().min(0).max(10_000).nullable().optional(),
  protein: z.number().min(0).max(1_000).nullable().optional(),
});

foodRoutes.put("/food/settings", async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "installed, level, kcal or protein" }, 400);
  const { installed, level, kcal, protein } = parsed.data;
  const db = c.env.DB;
  if (installed !== undefined) await setCalorieInstalled(db, c.var.userId, installed);
  if (level) await setFoodLevel(db, c.var.userId, level);
  await setFoodTarget(db, c.var.userId, { kcal, protein });
  return c.json(await foodSettings(db, c.var.userId));
});

const amendSchema = z.object({
  grams: z.number().positive().max(MAX_GRAMS).optional(),
  kcal: z.number().min(0).max(MAX_ITEM_KCAL).optional(),
  fraction: z.number().min(0).max(10).optional(),
});

foodRoutes.patch("/food/log/:id", async (c) => {
  const parsed = amendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "grams, kcal or fraction" }, 400);
  const row = await c.env.DB
    .prepare(
      "SELECT id, day, ts, name, key, grams, kcal, protein_g, carbs_g, fat_g, category, source, estimated FROM food_log WHERE id = ? AND user_id = ?",
    )
    .bind(c.req.param("id"), c.var.userId)
    .first<LogRow>();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(await amendEntry(c.env.DB, c.var.userId, row, parsed.data));
});

foodRoutes.delete("/food/log/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM food_log WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});
