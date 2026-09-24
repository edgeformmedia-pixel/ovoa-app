import { z } from "zod";
import { addEmergencyContact } from "../fitness";
import { isFoodLevel, setCalorieInstalled, setFoodLevel, setFoodTarget, type FoodLevel } from "../food";
import { listGoogleAccounts, setAccountLabel } from "../google/oauth";
import { getProfile, saveProfile } from "../onboarding";
import { createRoutine, parseClock, updateRoutine, type RoutineRow } from "../routines";
import type { Env } from "../types";

// What setup has to learn (the AI-led setup, 2026-09-23). The user's words:
// give the model "a list of goals it has to complete; it can complete them with
// any words it wants". So there is no question text here, only what each thing
// is, what shape its value takes, and where it is stored. The model decides
// what to ask and how; the server checks every value against these and stores
// it where the rest of OVOA already looks.
//
// required: covered unless they decline (name, day, goals, emergency contact).
// ask: one light question if the conversation allows. optional: only if it
// comes up. Medication is 'ask', inside daily: it was asked of everyone before,
// and the 2026-09-21 run shows a forced question gets a guessed answer ("one
// pill a week every day at 2pm" saved as a daily 2 PM reminder).
//
// Everything is pure except applyEffects, and every store is idempotent against
// the database itself (same routine title, same contact digits, same memory
// text), not only against what this setup remembers making: two turns can race
// (a reply talked over while its update is still streaming keeps running on the
// server) and a restart meets rows that already exist.

export const OBJECTIVE_IDS = [
  "name",
  "day",
  "goals",
  "emergency_contact",
  "daily",
  "work",
  "workouts",
  "nicknames",
  "leaving",
  "focus",
  "about",
] as const;
export type ObjectiveId = (typeof OBJECTIVE_IDS)[number];
export const isObjectiveId = (v: unknown): v is ObjectiveId => (OBJECTIVE_IDS as readonly unknown[]).includes(v);

export type Priority = "required" | "ask" | "optional";

/** What a merge leaves an objective as. 'low' and 'declined' are the state's (state.ts), not a value's. */
export type FillStatus = "open" | "partial" | "filled";

/** What setup has stored so far, so a correction updates it rather than adding a second. */
export type Made = {
  /** Routine ids by item key ("med:vitamin-d"). */
  routines: Record<string, string>;
  /** The emergency contact this setup added, updated in place when its number is corrected. */
  contactId?: string;
  /** 'asked' memory ids by key ("focus", "about:has-a-dog-named-max"). */
  memories: Record<string, string>;
  /** Goal keys an app has been queued for (setup_apps), at most MAX_GOAL_APPS. */
  goals: string[];
  /** Add-ons for the phone to add to its menu (the server can't install one): "calorie". */
  addons: string[];
};

export const emptyMade = (): Made => ({ routines: {}, memories: {}, goals: [], addons: [] });

/** A store, as data: mergeUpdate (state.ts) decides them, applyEffects makes them. */
export type Effect =
  | { kind: "name"; call: string }
  | { kind: "day"; wake: number | null; bed: number | null }
  | { kind: "food"; level: FoodLevel | null; kcal: number | null }
  | { kind: "steps"; steps: number }
  | { kind: "app"; key: string; goal: string; detail: string }
  | { kind: "contact"; name: string; phone: string }
  | { kind: "routine"; key: string; routine: DailyKind; title: string; times: number[]; days: number[] }
  /** `title` null: only the one this setup made (a workout reminder that no longer has a time). */
  | { kind: "unroutine"; key: string; routine: DailyKind; title: string | null }
  | { kind: "work"; hours: { days: number[]; start: number; end: number } | null }
  | { kind: "account"; email: string }
  | { kind: "gym"; text: string | null }
  | { kind: "nicknames"; names: string[] }
  | { kind: "leaving"; items: string[] }
  | { kind: "memory"; key: string; text: string };

// ---------- Shapes ----------

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
type Weekday = (typeof WEEKDAYS)[number];
const MON_FRI: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];

const GOAL_KINDS = ["eating", "move", "sleep", "habit", "other"] as const;
type GoalKind = (typeof GOAL_KINDS)[number];
const DAILY_KINDS = ["med", "pet", "habit"] as const;
type DailyKind = (typeof DAILY_KINDS)[number] & RoutineRow["kind"];

/** Lowercase words joined by hyphens: the key two spellings of one thing share. Safe inside a JSON path. */
export const keyOf = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/ /g, "-")
    .slice(0, 60);

/** "7:00" → "07:00"; null for anything parseClock (routines.ts) won't take. */
function hhmm(raw: unknown): string | null {
  const m = parseClock(raw);
  return m === null ? null : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "Monday", "mon" → "monday". Anything else is dropped. */
function weekdays(raw: unknown): Weekday[] {
  if (!Array.isArray(raw)) return [];
  const out: Weekday[] = [];
  for (const d of raw) {
    const s = String(d).trim().toLowerCase();
    const day = s.length >= 3 ? WEEKDAYS.find((w) => w.startsWith(s.slice(0, 3))) : undefined;
    if (day && !out.includes(day)) out.push(day);
  }
  return out;
}

/** Days as routines and the profile store them: 0 = Sunday, and every day as none. */
const dayNumbers = (days: Weekday[] | undefined) => {
  const n = [...new Set((days ?? []).map((d) => WEEKDAYS.indexOf(d)))].sort();
  return n.length === 7 ? [] : n;
};

const shortDays = (days: Weekday[] | undefined) =>
  !days?.length || days.length === 7 ? "every day" : days.map((d) => d[0].toUpperCase() + d.slice(1, 3)).join(", ");

const text = (max: number) => z.string().trim().min(1).transform((s) => s.slice(0, max));
const said = (raw: unknown) => JSON.stringify(raw)?.slice(0, 60) ?? "nothing";

/** A phone number as it is stored: digits with a leading +, or null if it isn't a whole one. */
export function phoneOf(raw: unknown): string | null {
  const phone = String(raw ?? "").replace(/[\s().\-]/g, "");
  return /^\+?\d{7,15}$/.test(phone) ? phone : null;
}

/**
 * Notes that would ride on every prompt for good ('asked' memories are kept
 * past 14 days, retention.ts) must not carry health details or money amounts.
 * The prompt says so; this is the backstop.
 */
const SENSITIVE =
  /[$€£¥]\s?\d|\b\d[\d,.]*\s?(dollars?|bucks|pounds?|euros?|grand)\b|\b(diagnos\w*|disorders?|diseases?|diabet\w*|cancer|depress\w*|anxiety|adhd|autis\w*|bipolar|medicat\w*|prescri\w*|\d+\s?mg|insulin|pills?|therap\w*|hiv|pregnan\w*|salary|debt)\b/i;

// ---------- The objectives ----------

type Merged<V> = {
  value?: V;
  status: FillStatus;
  problems: string[];
  changed: boolean;
  /** A list's items (by key) this fill added or said again: unsure is kept per item (state.ts mergeUpdate). */
  touched?: string[];
  /** Held as unsure whatever the update says: a number kept across a change of name is checked before it's stored. */
  unsure?: boolean;
};

/** A list's value without some items (by key): what's left, how covered it is, and the titles taken out. */
type Without<V> = { value?: V; status: FillStatus; dropped: string[] };

type Def<V> = {
  /** Short, for the phone's "So far" list. */
  label: string;
  priority: Priority;
  /** A value still marked unsure counts as covered: the name on their account, a roughly heard wake time. */
  lowResolves?: boolean;
  /** At finish, a value still marked unsure is stored anyway. Never for contacts, medication or the name. */
  applyLow?: boolean;
  merge: (prev: V | undefined, raw: unknown) => Merged<V>;
  /** `touched`: the list items this fill named (Merged.touched); empty for the rest. */
  effects: (value: V, raw: unknown, touched: string[]) => Effect[];
  /** The value in a few words: the state block and the "So far" list. */
  show: (value: V) => string;
  /** Lists only: items still unconfirmed are taken out, never stored (state.ts). */
  without?: (value: V, keys: string[]) => Without<V>;
};

export type Objective = Def<any> & { id: ObjectiveId };

const unchanged = <V>(prev: V | undefined, status: FillStatus, ...problems: string[]): Merged<V> => ({
  value: prev,
  status,
  problems,
  changed: false,
});

const statusOf = (value: unknown): FillStatus => (value === undefined ? "open" : "filled");

/** Letters apart (edit distance): how a respelled name is told from someone else's. */
function apart(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// name ----------

type NameV = { call: string };
const nameSchema = z.object({ call: z.string().trim().min(1).max(40) });

const name: Def<NameV> = {
  label: "Name",
  priority: "required",
  // Unsure is still the name on their account, which is what they're called anyway.
  lowResolves: true,
  merge: (prev, raw) => {
    const p = nameSchema.safeParse(raw);
    if (!p.success || p.data.call.includes("@") || /\d{5,}/.test(p.data.call)) {
      return unchanged(prev, statusOf(prev), `name: ${said(raw)} isn't a name to call them`);
    }
    return { value: { call: p.data.call }, status: "filled", problems: [], changed: true };
  },
  effects: (v) => [{ kind: "name", call: v.call }],
  show: (v) => v.call,
};

// day ----------

type DayV = { wake?: string; bed?: string };

const day: Def<DayV> = {
  label: "Your day",
  priority: "required",
  lowResolves: true,
  applyLow: true,
  merge: (prev, raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const wake = r.wake === undefined ? undefined : hhmm(r.wake);
    const bed = r.bed === undefined ? undefined : hhmm(r.bed);
    const was = prev ? (prev.wake && prev.bed ? "filled" : "partial") : "open";
    if (wake === null || bed === null || (wake === undefined && bed === undefined)) {
      return unchanged(prev, was, `day: ${said(raw)} isn't a time as HH:MM, 24-hour`);
    }
    const value: DayV = { ...prev, ...(wake && { wake }), ...(bed && { bed }) };
    if (value.wake && value.wake === value.bed) {
      return unchanged(prev, was, `day: getting up and going to bed can't both be ${value.wake}`);
    }
    return { value, status: value.wake && value.bed ? "filled" : "partial", problems: [], changed: true };
  },
  effects: (v) => [{ kind: "day", wake: parseClock(v.wake), bed: parseClock(v.bed) }],
  show: (v) => `up ${v.wake ?? "not heard yet"}, bed ${v.bed ?? "not heard yet"}`,
};

// goals ----------

type GoalItem = {
  goal: string;
  kind: GoalKind;
  detail?: string;
  steps?: number;
  kcal?: number;
  level?: FoodLevel;
  /** The key it was first heard under, when it has since been said in other words (goalKey). */
  key?: string;
};
type GoalsV = { none: true } | { goals: GoalItem[] };

/** A goal's key: the one it was first heard under, kept when it's reworded, so its app is made once (state.ts goalJobs). */
export const goalKey = (g: { goal: string; key?: string }) => g.key ?? keyOf(g.goal);

/** Words that don't say what a goal is about: "Drink more water" and "Drink less soda" share only these. */
const GENERIC = new Set(
  "more less every daily each better drink drinks drinking stop quit start keep make take with from that this have want some much many week weeks hour hours time times least about just night morning evening health healthy healthier".split(
    " ",
  ),
);
/** What a goal is about ("water", "sleep", "weight"): its words of four letters or more that aren't GENERIC. */
const topics = (goal: string) => keyOf(goal).split("-").filter((w) => w.length >= 4 && !GENERIC.has(w));

const goalSchema = z.object({
  goal: text(80),
  kind: z.enum(GOAL_KINDS).catch("other"),
  detail: z.string().trim().max(2000).transform((s) => s.slice(0, 300)).optional().catch(undefined),
  steps: z.unknown().optional(),
  kcal: z.unknown().optional(),
  level: z.unknown().optional(),
  remove: z.boolean().optional().catch(undefined),
});

/** At most this many goals are kept; apps are made for the first MAX_GOAL_APPS (state.ts). */
const MAX_GOALS = 5;

const goals: Def<GoalsV> = {
  label: "Goals",
  priority: "required",
  merge: (prev, raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (r.none === true) return { value: { none: true }, status: "filled", problems: [], changed: true };
    if (!Array.isArray(r.goals)) return unchanged(prev, statusOf(prev), `goals: ${said(raw)} isn't {"goals": [...]} or {"none": true}`);
    const list = prev && "goals" in prev ? [...prev.goals] : [];
    const problems: string[] = [];
    const touched: string[] = [];
    const parsed = r.goals.map((item) => goalSchema.safeParse(item));
    // Every title this fill names: a goal it names isn't taken for another one reworded.
    const named = new Set(parsed.flatMap((p) => (p.success ? [keyOf(p.data.goal)] : [])));
    const reworded = new Set<string>();
    for (const [i, p] of parsed.entries()) {
      if (!p.success) {
        problems.push(`goals: ${said(r.goals[i])} needs at least a "goal"`);
        continue;
      }
      const g = p.data;
      const key = keyOf(g.goal);
      let at = list.findIndex((x) => keyOf(x.goal) === key || goalKey(x) === key);
      if (g.remove) {
        if (at >= 0) list.splice(at, 1);
        continue;
      }
      if (at < 0) {
        // The same goal in other words: the follow-up the prompt asks for turns
        // "Drink more water" into "Drink a gallon of water a day" (2026-09-23
        // review). Taken as that goal only when exactly one goal of the kind
        // shares what it's about; "Drink less soda" stays a goal of its own.
        const mine = topics(g.goal);
        const like = list.flatMap((x, j) =>
          x.kind === g.kind &&
          !named.has(keyOf(x.goal)) &&
          !named.has(goalKey(x)) &&
          !reworded.has(goalKey(x)) &&
          topics(x.goal).some((w) => mine.includes(w))
            ? [j]
            : [],
        );
        if (like.length === 1) {
          at = like[0];
          reworded.add(goalKey(list[at]));
        }
      }
      const before = at >= 0 ? list[at] : undefined;
      const next: GoalItem = { ...before, goal: g.goal, kind: g.kind, ...(g.detail && { detail: g.detail }) };
      if (before && goalKey(before) !== key) next.key = goalKey(before);
      if (g.steps !== undefined) {
        if (typeof g.steps === "number" && g.steps >= 1000 && g.steps <= 50_000) next.steps = Math.round(g.steps);
        else problems.push(`goals: ${said(g.steps)} isn't a daily step target (1000 to 50000)`);
      }
      if (g.kcal !== undefined) {
        if (typeof g.kcal === "number" && g.kcal >= 800 && g.kcal <= 6000) next.kcal = Math.round(g.kcal);
        else problems.push(`goals: ${said(g.kcal)} isn't a daily calorie target (800 to 6000)`);
      }
      if (isFoodLevel(g.level)) next.level = g.level;
      if (at >= 0) list[at] = next;
      else list.push(next);
      touched.push(goalKey(next));
    }
    const kept = list.slice(0, MAX_GOALS);
    if (list.length > MAX_GOALS) problems.push(`goals: only the first ${MAX_GOALS} are kept`);
    if (!kept.length) return { value: undefined, status: "open", problems, changed: true, touched };
    return { value: { goals: kept }, status: "filled", problems, changed: true, touched };
  },
  without: (v, keys) => {
    if ("none" in v) return { value: v, status: "filled", dropped: [] };
    const kept = v.goals.filter((g) => !keys.includes(goalKey(g)));
    const dropped = v.goals.filter((g) => keys.includes(goalKey(g))).map((g) => g.goal);
    return kept.length ? { value: { goals: kept }, status: "filled", dropped } : { status: "open", dropped };
  },
  effects: (v) => {
    if ("none" in v) return [];
    const out: Effect[] = [];
    // An eating goal turns on Calorie (food.ts), as the scripted setup did. Water
    // and other drinks are 'habit': the old "eat or drink" rule gave a gallon of
    // water to the calorie tracker.
    const eating = v.goals.filter((g) => g.kind === "eating");
    if (eating.length) {
      out.push({
        kind: "food",
        level: eating.map((g) => g.level).find(isFoodLevel) ?? null,
        kcal: eating.map((g) => g.kcal).find((k): k is number => !!k) ?? null,
      });
    }
    const steps = v.goals.map((g) => g.steps).find((s): s is number => !!s);
    if (steps) out.push({ kind: "steps", steps });
    return out;
  },
  show: (v) => ("none" in v ? "none" : v.goals.map((g) => (g.kind === "eating" ? `${g.goal} (Calorie)` : g.goal)).join("; ")),
};

/** The goals an app should be made for: every one that isn't about eating (Calorie covers those). */
export const appGoals = (v: unknown): GoalItem[] =>
  v && typeof v === "object" && "goals" in v ? (v as { goals: GoalItem[] }).goals.filter((g) => g.kind !== "eating") : [];

// emergency_contact ----------

type ContactV = { none: true } | { name?: string; phone?: string; relation?: string };
const contactSchema = z.object({
  none: z.boolean().optional(),
  name: text(80).optional(),
  phone: z.union([z.string(), z.number()]).transform(String).optional(),
  relation: text(40).optional(),
});

const emergency_contact: Def<ContactV> = {
  label: "Emergency contact",
  priority: "required",
  merge: (prev, raw) => {
    const p = contactSchema.safeParse(raw);
    const had = prev && !("none" in prev) ? prev : undefined;
    const was: FillStatus = !prev ? "open" : "none" in prev || (prev.name && prev.phone) ? "filled" : "partial";
    if (!p.success) return unchanged(prev, was, `emergency_contact: ${said(raw)} isn't {"name", "phone"} or {"none": true}`);
    const c = p.data;
    if (c.none) return { value: { none: true }, status: "filled", problems: [], changed: true };
    if (!c.name && !c.phone && !(c.relation && had)) return unchanged(prev, was, `emergency_contact: ${said(raw)} has no name or number`);
    const problems: string[] = [];
    let phone = had?.phone;
    let relation = c.relation ?? had?.relation;
    let respelled = false;
    if (c.name && had?.name && c.name.toLowerCase() !== had.name.toLowerCase()) {
      // A name said back and corrected ("Danya", "no, Tanya with a T") is the
      // same person: the number stays, held until they confirm it's still
      // theirs, rather than asked for again (2026-09-23 review). Someone else
      // (another relation, or a name nothing like it) doesn't get it.
      const first = (n: string) => n.toLowerCase().split(/\s+/)[0];
      const sameRelation = !c.relation || !had.relation || c.relation.toLowerCase() === had.relation.toLowerCase();
      if (sameRelation && apart(first(c.name), first(had.name)) <= 2) respelled = true;
      else {
        phone = undefined;
        relation = c.relation;
      }
    }
    let heard = false;
    if (c.phone !== undefined) {
      const clean = phoneOf(c.phone);
      if (clean) [phone, heard] = [clean, true];
      else problems.push(`emergency_contact: "${c.phone}" isn't a whole phone number`);
    }
    const name = c.name ?? had?.name;
    const check = respelled && !heard && !!phone;
    if (check) problems.push(`emergency_contact: kept ${phone} for ${name}: check it's still their number before it's saved`);
    const value = { ...(name && { name }), ...(phone && { phone }), ...(relation && { relation }) };
    // A name with no number yet is half an answer, not a problem: the model asks for the number.
    return { value, status: value.name && value.phone ? "filled" : "partial", problems, changed: true, ...(check && { unsure: true }) };
  },
  effects: (v) => ("none" in v || !v.name || !v.phone ? [] : [{ kind: "contact", name: v.name, phone: v.phone }]),
  show: (v) =>
    "none" in v ? "none" : `${v.name ?? "name not heard yet"}${v.relation ? ` (${v.relation})` : ""}, ${v.phone ?? "no number yet"}`,
};

// daily ----------

type DailyItem = { title: string; kind: DailyKind; times: string[]; days?: Weekday[] };
type DailyV = { none: true } | { items: DailyItem[] };

const dailySchema = z.object({
  title: text(80),
  kind: z.enum(DAILY_KINDS).catch("habit"),
  times: z.array(z.unknown()).optional().catch(undefined),
  days: z.array(z.unknown()).optional().catch(undefined),
  remove: z.boolean().optional().catch(undefined),
});
const MAX_DAILY = 8;
/** Times a day for one reminder: the most the Apple Reminders sync takes back for a medication (routines.ts /routines/sync). */
const MAX_TIMES = 12;
const dailyKey = (i: { kind: string; title: string }) => `${i.kind}:${keyOf(i.title)}`;

/**
 * All removed: open again, as an empty list rather than no value, so the
 * removes are still stored (mergeUpdate stores only what has a value).
 * Something with no time isn't set up until they say when (the old setup
 * dropped "vitamin D" with no time in silence behind "No medications").
 */
const dailyStatus = (items: DailyItem[]): FillStatus => (!items.length ? "open" : items.some((i) => !i.times.length) ? "partial" : "filled");

const daily: Def<DailyV> = {
  label: "Reminders",
  priority: "ask",
  merge: (prev, raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const items = prev && "items" in prev ? prev.items : [];
    if (r.none === true) return { value: { none: true }, status: "filled", problems: [], changed: true };
    if (!Array.isArray(r.items)) {
      return unchanged(prev, prev ? "filled" : "open", `daily: ${said(raw)} isn't {"items": [...]} or {"none": true}`);
    }
    const list = [...items];
    const problems: string[] = [];
    const touched: string[] = [];
    for (const item of r.items) {
      const p = dailySchema.safeParse(item);
      if (!p.success) {
        problems.push(`daily: ${said(item)} needs at least a "title"`);
        continue;
      }
      const d = p.data;
      const at = list.findIndex((x) => dailyKey(x) === dailyKey(d));
      if (d.remove) {
        if (at >= 0) list.splice(at, 1);
        continue;
      }
      const times: string[] = [];
      for (const t of d.times ?? []) {
        const clean = hhmm(t);
        if (clean) {
          if (!times.includes(clean)) times.push(clean);
        } else problems.push(`daily: ${said(t)} isn't a time for ${d.title}`);
      }
      const days = weekdays(d.days);
      if (times.length > MAX_TIMES) problems.push(`daily: at most ${MAX_TIMES} times a day, so ${d.title} keeps the first ${MAX_TIMES}`);
      const next: DailyItem = {
        title: d.title,
        kind: d.kind,
        // Times said before stay unless new ones are: "and on weekdays" isn't "no time".
        times: times.length ? times.sort().slice(0, MAX_TIMES) : at >= 0 ? list[at].times : [],
        ...(days.length ? { days } : at >= 0 && list[at].days ? { days: list[at].days } : {}),
      };
      if (at >= 0) list[at] = next;
      else list.push(next);
      touched.push(dailyKey(next));
    }
    const kept = list.slice(0, MAX_DAILY);
    if (list.length > MAX_DAILY) problems.push(`daily: only the first ${MAX_DAILY} are kept`);
    for (const i of kept) if (!i.times.length) problems.push(`daily: needs a time: ${i.title}`);
    return { value: { items: kept }, status: dailyStatus(kept), problems, changed: true, touched };
  },
  without: (v, keys) => {
    if ("none" in v) return { value: v, status: "filled", dropped: [] };
    const kept = v.items.filter((i) => !keys.includes(dailyKey(i)));
    return { value: { items: kept }, status: dailyStatus(kept), dropped: v.items.filter((i) => keys.includes(dailyKey(i))).map((i) => i.title) };
  },
  effects: (v, raw, touched) => {
    const out: Effect[] = [];
    // Only the items this fill named: a reminder already stored (made in Talk,
    // shown "from before" when setup is gone through again) is rewritten only
    // when they talk about it (2026-09-23 review: a restart's next fill trimmed
    // an 8-time Water reminder and rescheduled every other one).
    if ("items" in v) {
      for (const i of v.items) {
        if (!i.times.length || !touched.includes(dailyKey(i))) continue;
        const times = i.times.map(parseClock).filter((m): m is number => m !== null);
        out.push({ kind: "routine", key: dailyKey(i), routine: i.kind, title: i.title, times, days: dayNumbers(i.days) });
      }
    }
    const asked = (raw as { items?: unknown[] })?.items ?? [];
    for (const item of Array.isArray(asked) ? asked : []) {
      const p = dailySchema.safeParse(item);
      if (p.success && p.data.remove) out.push({ kind: "unroutine", key: dailyKey(p.data), routine: p.data.kind, title: p.data.title });
    }
    return out;
  },
  show: (v) =>
    "none" in v
      ? "none"
      : v.items
          .map((i) => `${i.title} ${i.times.length ? i.times.join(", ") : "(no time yet)"}${i.days?.length ? ` ${shortDays(i.days)}` : ""}`)
          .join("; "),
};

// work ----------

type WorkV = { set?: boolean; days?: Weekday[]; start?: string; end?: string; note?: string; account?: string };
const workSchema = z.object({
  set: z.boolean().optional().catch(undefined),
  days: z.array(z.unknown()).optional().catch(undefined),
  start: z.unknown().optional(),
  end: z.unknown().optional(),
  note: text(120).optional().catch(undefined),
  account: z.string().trim().max(120).optional().catch(undefined),
});
/** A working day this long or longer is not set hours ("I work 24/7" was saved as 12:00 AM–11:59 PM, 2026-09-21). */
const ALL_HOURS_MIN = 18 * 60;

const work: Def<WorkV> = {
  label: "Work",
  priority: "ask",
  lowResolves: true,
  applyLow: true,
  merge: (prev, raw) => {
    const p = workSchema.safeParse(raw);
    const was: FillStatus = prev?.set === undefined ? (prev ? "partial" : "open") : "filled";
    if (!p.success) return unchanged(prev, was, `work: ${said(raw)} isn't a work value`);
    const w = p.data;
    const account = w.account || prev?.account;
    const withAccount = (v: WorkV): WorkV => (account ? { ...v, account } : v);
    if (w.set === false) return { value: withAccount({ set: false, ...(w.note && { note: w.note }) }), status: "filled", problems: [], changed: true };
    if (w.start !== undefined || w.end !== undefined || w.set === true) {
      const start = hhmm(w.start);
      const end = hhmm(w.end);
      if (!start || !end) return unchanged(prev, was, `work: needs when they start and finish as HH:MM (got ${said({ start: w.start, end: w.end })})`);
      const span = (parseClock(end)! - parseClock(start)! + 1440) % 1440;
      if (!span) return unchanged(prev, was, `work: starting and finishing can't both be ${start}`);
      if (span + 1 >= ALL_HOURS_MIN) {
        return {
          value: withAccount({ set: false, note: "works all hours" }),
          status: "filled",
          problems: [`work: ${start} to ${end} is most of the day, so it's saved as "works all hours", not set hours`],
          changed: true,
        };
      }
      const days = weekdays(w.days);
      return { value: withAccount({ set: true, days: days.length ? days : MON_FRI, start, end }), status: "filled", problems: [], changed: true };
    }
    if (w.account) return { value: withAccount({ ...prev }), status: prev?.set === undefined ? "partial" : "filled", problems: [], changed: true };
    return unchanged(prev, was, `work: ${said(raw)} says nothing about their work`);
  },
  effects: (v) => {
    const out: Effect[] = [];
    if (v.set === true && v.start && v.end) {
      out.push({ kind: "work", hours: { days: dayNumbers(v.days), start: parseClock(v.start)!, end: parseClock(v.end)! } });
    } else if (v.set === false) out.push({ kind: "work", hours: null });
    if (v.account) out.push({ kind: "account", email: v.account });
    return out;
  },
  show: (v) =>
    [
      v.set === true ? `${shortDays(v.days)} ${v.start}–${v.end}` : v.set === false ? (v.note ?? "no set hours") : "",
      v.account ? `work account ${v.account}` : "",
    ]
      .filter(Boolean)
      .join(", "),
};

// workouts ----------

type WorkoutsV = { does: boolean; what?: string; days?: Weekday[]; time?: string; irregular?: boolean };
const workoutsSchema = z.object({
  does: z.boolean().optional().catch(undefined),
  what: text(60).optional().catch(undefined),
  days: z.array(z.unknown()).optional().catch(undefined),
  time: z.unknown().optional(),
  irregular: z.boolean().optional().catch(undefined),
});

/** How the profile's gym line reads: only what they said, as the scripted setup did. */
function gymText(v: WorkoutsV) {
  const when = v.days?.length ? (v.days.length === 7 ? "every day" : `on ${shortDays(v.days)}`) : "";
  return [v.what || "Workouts", when, v.irregular ? "at no fixed time" : v.time ? `at ${v.time}` : ""].filter(Boolean).join(" ");
}

const workouts: Def<WorkoutsV> = {
  label: "Workouts",
  priority: "ask",
  lowResolves: true,
  applyLow: true,
  merge: (prev, raw) => {
    const p = workoutsSchema.safeParse(raw);
    if (!p.success) return unchanged(prev, statusOf(prev), `workouts: ${said(raw)} isn't a workouts value`);
    const w = p.data;
    if (w.does === false) return { value: { does: false }, status: "filled", problems: [], changed: true };
    const time = w.time === undefined ? undefined : hhmm(w.time);
    if (time === null) return unchanged(prev, statusOf(prev), `workouts: ${said(w.time)} isn't a time as HH:MM`);
    const days = weekdays(w.days);
    const value: WorkoutsV = { ...(prev?.does ? prev : {}), does: true, ...(w.what && { what: w.what }), ...(days.length && { days }) };
    // "Every day, random times" (2026-09-21) is a routine with no fixed time: text, and no reminder.
    if (w.irregular) {
      delete value.time;
      value.irregular = true;
    } else if (time) {
      value.time = time;
      delete value.irregular;
    }
    return { value, status: "filled", problems: [], changed: true };
  },
  effects: (v) => {
    if (!v.does) return [{ kind: "gym", text: null }, { kind: "unroutine", key: "habit:workout", routine: "habit", title: null }];
    const reminder: Effect = v.time
      ? {
          kind: "routine",
          key: "habit:workout",
          routine: "habit",
          title: v.what ? `Workout (${v.what})` : "Workout",
          times: [parseClock(v.time)!],
          days: dayNumbers(v.days),
        }
      : { kind: "unroutine", key: "habit:workout", routine: "habit", title: null };
    return [{ kind: "gym", text: gymText(v) }, reminder];
  },
  show: (v) => (v.does ? gymText(v) : "doesn't work out"),
};

// the optional ones ----------

/** A list that only grows: what they add is added to what's there, the same thing said twice once. */
function union(prev: string[] | undefined, next: string[], cap: number) {
  const out = [...(prev ?? [])];
  for (const s of next) if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  return out.slice(0, cap);
}

const listOf = (key: string, max: number) => z.object({ [key]: z.array(text(max)) });

/** The fill's words that made it into the list, as the keys union dedupes by. */
const touchedOf = (words: string[], list: string[]) =>
  words.map((s) => s.toLowerCase()).filter((k) => list.some((x) => x.toLowerCase() === k));

/** Without, for a list of words kept under `field`. */
const withoutWords =
  <F extends string>(field: F) =>
  (v: Record<F, string[]>, keys: string[]): Without<Record<F, string[]>> => {
    const kept = v[field].filter((x) => !keys.includes(x.toLowerCase()));
    const dropped = v[field].filter((x) => keys.includes(x.toLowerCase()));
    return kept.length ? { value: { [field]: kept } as Record<F, string[]>, status: "filled", dropped } : { status: "open", dropped };
  };

const nicknames: Def<{ names: string[] }> = {
  label: "Also called",
  priority: "optional",
  merge: (prev, raw) => {
    const p = listOf("names", 30).safeParse(raw);
    if (!p.success) return unchanged(prev, statusOf(prev), `nicknames: ${said(raw)} isn't {"names": [...]}`);
    const names = union(prev?.names, p.data.names as string[], 6);
    return { value: { names }, status: names.length ? "filled" : "open", problems: [], changed: true, touched: touchedOf(p.data.names as string[], names) };
  },
  without: withoutWords("names"),
  effects: (v) => [{ kind: "nicknames", names: v.names }],
  show: (v) => v.names.join(", "),
};

const leaving: Def<{ items: string[] }> = {
  label: "On the way out",
  priority: "optional",
  merge: (prev, raw) => {
    const p = listOf("items", 40).safeParse(raw);
    if (!p.success) return unchanged(prev, statusOf(prev), `leaving: ${said(raw)} isn't {"items": [...]}`);
    const items = union(prev?.items, p.data.items as string[], 10);
    return { value: { items }, status: items.length ? "filled" : "open", problems: [], changed: true, touched: touchedOf(p.data.items as string[], items) };
  },
  without: withoutWords("items"),
  effects: (v) => [{ kind: "leaving", items: v.items }],
  show: (v) => v.items.join(", "),
};

type FocusV = { areas: string[]; note?: string };
const focusSchema = z.object({ areas: z.array(text(40)).optional().catch(undefined), note: text(160).optional().catch(undefined) });

const focus: Def<FocusV> = {
  label: "Help with",
  priority: "optional",
  merge: (prev, raw) => {
    const p = focusSchema.safeParse(raw);
    if (!p.success || (!p.data.areas?.length && !p.data.note)) {
      return unchanged(prev, statusOf(prev), `focus: ${said(raw)} isn't {"areas": [...], "note": "..."}`);
    }
    const areas = union(prev?.areas, (p.data.areas ?? []).filter((a) => !SENSITIVE.test(a)), 5);
    const note = p.data.note && !SENSITIVE.test(p.data.note) ? p.data.note : prev?.note;
    if (!areas.length && !note) return unchanged(prev, statusOf(prev));
    return { value: { areas, ...(note && { note }) }, status: "filled", problems: [], changed: true };
  },
  effects: (v) => [
    {
      kind: "memory",
      key: "focus",
      text: [v.areas.length ? `Most wants help with: ${v.areas.join(", ")}.` : "", v.note ? `In their words: ${v.note}` : ""].filter(Boolean).join(" "),
    },
  ],
  show: (v) => [v.areas.join(", "), v.note ?? ""].filter(Boolean).join(": "),
};

const about: Def<{ facts: string[] }> = {
  label: "About you",
  priority: "optional",
  merge: (prev, raw) => {
    const p = listOf("facts", 120).safeParse(raw);
    if (!p.success) return unchanged(prev, statusOf(prev), `about: ${said(raw)} isn't {"facts": [...]}`);
    // Dropped without a word to the model: nothing to fix, and saying so would only invite it to mention it.
    const heard = (p.data.facts as string[]).filter((f) => !SENSITIVE.test(f));
    const facts = union(prev?.facts, heard, 6);
    if (!facts.length) return unchanged(prev, statusOf(prev));
    return { value: { facts }, status: "filled", problems: [], changed: true, touched: touchedOf(heard, facts) };
  },
  without: withoutWords("facts"),
  effects: (v) => v.facts.map((f) => ({ kind: "memory" as const, key: `about:${keyOf(f)}`, text: f })),
  show: (v) => v.facts.join("; "),
};

export const OBJECTIVES: Record<ObjectiveId, Objective> = Object.fromEntries(
  Object.entries({ name, day, goals, emergency_contact, daily, work, workouts, nicknames, leaving, focus, about }).map(([id, o]) => [
    id,
    { ...o, id },
  ]),
) as Record<ObjectiveId, Objective>;

export const REQUIRED = OBJECTIVE_IDS.filter((id) => OBJECTIVES[id].priority === "required");

// ---------- Storing ----------

export type Applied = {
  problems: string[];
  made: Made;
  /** A routine was added, changed or turned off: the phone is told once (routinesChanged). */
  routinesChanged: boolean;
  /** Goal apps to queue and make in the background (turn.ts). */
  jobs: Extract<Effect, { kind: "app" }>[];
};

/** The active routine to update rather than add: the one this setup made, or one with the same kind and title. */
async function existingRoutine(db: D1Database, userId: string, made: Made, e: { key: string; routine: string; title: string | null }) {
  const mine = made.routines[e.key];
  if (mine) {
    const row = await db.prepare("SELECT id FROM routines WHERE id = ? AND user_id = ?").bind(mine, userId).first<{ id: string }>();
    if (row) return row.id;
  }
  if (e.title === null) return null;
  const row = await db
    .prepare("SELECT id FROM routines WHERE user_id = ? AND kind = ? AND lower(title) = lower(?) AND active = 1")
    .bind(userId, e.routine, e.title)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Makes the stores, in order. A store that fails becomes a problem line for
 * the model's next turn, not a failed turn: the reply has already been heard.
 * `accountName` is the name on their account as the turn began.
 */
export async function applyEffects(env: Env, userId: string, effects: Effect[], ctx: { accountName: string; made: Made }): Promise<Applied> {
  const db = env.DB;
  const made: Made = structuredClone(ctx.made);
  const problems: string[] = [];
  const jobs: Applied["jobs"] = [];
  let accountName = ctx.accountName.trim();
  let routinesChanged = false;
  for (const e of effects) {
    try {
      switch (e.kind) {
        case "name": {
          // Only a different name replaces the one on the account: "Thomas" for
          // "Thomas Lancheros" keeps the full name (the 09-21 run saved "Yes" as it).
          const call = e.call.trim();
          const first = accountName.split(/\s+/)[0] ?? "";
          if ([accountName, first].some((n) => n && n.toLowerCase() === call.toLowerCase())) break;
          await db.prepare("UPDATE users SET name = ? WHERE id = ?").bind(call, userId).run();
          accountName = call;
          break;
        }
        case "day":
          await saveProfile(db, userId, {
            ...(e.wake !== null && { wakeTime: e.wake }),
            ...(e.bed !== null && { sleepTime: e.bed }),
          });
          break;
        case "food":
          // A level they asked for is theirs; otherwise the add-on's own first open asks.
          if (e.level) await setFoodLevel(db, userId, e.level);
          else await setCalorieInstalled(db, userId, true);
          if (e.kcal) await setFoodTarget(db, userId, { kcal: e.kcal });
          if (!made.addons.includes("calorie")) made.addons.push("calorie");
          break;
        case "steps":
          await db.batch([
            db.prepare("INSERT OR IGNORE INTO settings (user_id, assistant_name, updated_at) VALUES (?, ?, ?)").bind(userId, "OVOA", Date.now()),
            db.prepare("UPDATE settings SET step_goal = ?, updated_at = ? WHERE user_id = ?").bind(e.steps, Date.now(), userId),
          ]);
          break;
        case "app":
          jobs.push(e);
          break;
        case "contact": {
          const added = await addEmergencyContact(db, userId, { name: e.name, phone: e.phone }, { replace: made.contactId });
          if (added.ok) made.contactId = added.id;
          else problems.push(`emergency_contact: ${added.error}`);
          break;
        }
        case "routine": {
          const id = await existingRoutine(db, userId, made, e);
          if (id && (await updateRoutine(db, userId, id, { title: e.title, times: e.times, days: e.days, active: true }))) {
            made.routines[e.key] = id;
          } else {
            try {
              made.routines[e.key] = await createRoutine(db, userId, {
                kind: e.routine,
                title: e.title,
                times: e.times,
                days: e.days,
                // Medication goes into Apple Reminders' Medications list on the phone's next sync, and is urgent (createRoutine).
                externalSource: e.routine === "med" ? "apple_reminders" : null,
              });
            } catch (err) {
              // MAX_ROUTINES (routines.ts): said to the model, which can tell them.
              problems.push(`daily: couldn't add ${e.title}: ${err instanceof Error ? err.message : String(err)}`);
              break;
            }
          }
          routinesChanged = true;
          break;
        }
        case "unroutine": {
          const id = await existingRoutine(db, userId, made, e);
          delete made.routines[e.key];
          if (id && (await updateRoutine(db, userId, id, { active: false }))) routinesChanged = true;
          break;
        }
        case "work":
          await saveProfile(
            db,
            userId,
            e.hours
              ? { workStart: e.hours.start, workEnd: e.hours.end, workDays: e.hours.days.length ? e.hours.days : [0, 1, 2, 3, 4, 5, 6] }
              : { workStart: null, workEnd: null, workDays: null },
          );
          break;
        case "account": {
          // Which Google account is work, when there are two or more (as the scripted setup asked).
          const want = e.email.trim().toLowerCase();
          const match = (await listGoogleAccounts(db, userId)).find((a) => a.email.toLowerCase() === want);
          const trouble = match ? await setAccountLabel(db, userId, match.id, "work") : `${e.email} isn't one of their connected Google accounts`;
          if (trouble) problems.push(`work: ${trouble}`);
          break;
        }
        case "gym":
          await saveProfile(db, userId, { gym: e.text });
          break;
        case "nicknames": {
          const { nicknames } = await getProfile(db, userId);
          await saveProfile(db, userId, { nicknames: union(nicknames, e.names, 12) });
          break;
        }
        case "leaving":
          await saveProfile(db, userId, { leavingChecklist: e.items });
          break;
        case "memory": {
          // Kept as 'asked': what someone set up is kept past 14 days (retention.ts).
          const mine = made.memories[e.key];
          if (mine) {
            const res = await db.prepare("UPDATE memories SET content = ? WHERE id = ? AND user_id = ?").bind(e.text, mine, userId).run();
            if (res.meta.changes) break;
          }
          const same = await db.prepare("SELECT id FROM memories WHERE user_id = ? AND content = ?").bind(userId, e.text).first<{ id: string }>();
          if (same) {
            made.memories[e.key] = same.id;
            break;
          }
          const id = crypto.randomUUID();
          await db
            .prepare("INSERT INTO memories (id, user_id, content, source, created_at) VALUES (?, ?, ?, 'asked', ?)")
            .bind(id, userId, e.text, Date.now())
            .run();
          made.memories[e.key] = id;
          break;
        }
      }
    } catch (err) {
      console.error(`ovoa.err setup: couldn't store ${e.kind}`, err);
      problems.push(`${e.kind === "contact" ? "emergency_contact" : e.kind}: couldn't be saved just now`);
    }
  }
  return { problems, made, routinesChanged, jobs };
}

// ---------- What's already stored ----------

/**
 * What they set up before, as objective values, for going through setup again
 * from Settings: the model sees what's there and asks what to change, rather
 * than asking everything again. Goals, focus and facts aren't in any table in
 * a form to read back; restartSetup (turn.ts) carries them over from the last
 * setup when it's still there. The contact isn't claimed as this setup's own
 * (Made.contactId): a new one given now is added beside it, not over it.
 */
export async function storedValues(env: Env, userId: string) {
  const db = env.DB;
  const [profile, contact, routines] = await Promise.all([
    getProfile(db, userId),
    db.prepare("SELECT name, phone FROM emergency_contacts WHERE user_id = ? ORDER BY created_at LIMIT 1").bind(userId).first<{ name: string; phone: string }>(),
    db
      .prepare("SELECT id, kind, title, times, days FROM routines WHERE user_id = ? AND active = 1 AND kind IN ('med', 'pet', 'habit') ORDER BY created_at LIMIT ?")
      .bind(userId, MAX_DAILY)
      .all<Pick<RoutineRow, "id" | "kind" | "title" | "times" | "days">>(),
  ]);
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const numbers = (json: string) => {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
    } catch {
      return [];
    }
  };
  const values: Partial<Record<ObjectiveId, unknown>> = {};
  const made = emptyMade();
  if (profile.wakeTime !== null || profile.sleepTime !== null) {
    values.day = { ...(profile.wakeTime !== null && { wake: clock(profile.wakeTime) }), ...(profile.sleepTime !== null && { bed: clock(profile.sleepTime) }) };
  }
  if (profile.workStart !== null && profile.workEnd !== null) {
    values.work = { set: true, days: (profile.workDays ?? []).map((d) => WEEKDAYS[d]).filter(Boolean), start: clock(profile.workStart), end: clock(profile.workEnd) };
  }
  if (profile.gym) values.workouts = { does: true, what: profile.gym.slice(0, 60) };
  if (profile.nicknames.length) values.nicknames = { names: profile.nicknames.slice(0, 6) };
  if (profile.leavingChecklist?.length) values.leaving = { items: profile.leavingChecklist.slice(0, 10) };
  if (contact) values.emergency_contact = { name: contact.name, phone: contact.phone };
  // A reminder with more times than setup keeps (made in Talk) is left out, and
  // so left as it is: shown here it would come back trimmed to MAX_TIMES.
  const held = routines.results.filter((r) => numbers(r.times).length <= MAX_TIMES);
  if (held.length) {
    const items: DailyItem[] = held.map((r) => ({
      title: r.title,
      kind: r.kind as DailyKind,
      times: numbers(r.times).map(clock),
      ...(numbers(r.days).length && { days: numbers(r.days).map((d) => WEEKDAYS[d]).filter(Boolean) }),
    }));
    values.daily = { items };
    for (const [i, r] of held.entries()) made.routines[dailyKey(items[i])] = r.id;
  }
  return { values, made };
}
