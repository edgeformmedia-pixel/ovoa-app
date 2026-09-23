import { Hono } from "hono";
import { z } from "zod";
import { isFoodLevel, setCalorieInstalled, setFoodLevel, setFoodTarget } from "./food";
import { listGoogleAccounts, setAccountLabel } from "./google/oauth";
import type { CallTool, ToolSpec } from "./llm";
import { AI_UNREACHABLE, generateText, isAiUnreachable, isModelRefused } from "./llm";
import { designApp, saveApp } from "./myapps";
import { refusedResponse } from "./plans";
import { createRoutine, parseClock, routinesChanged, type NewRoutine } from "./routines";
import { clockFromMinutes } from "./time";
import type { Env, Vars } from "./types";

// Getting to know someone, once. See migrations/0017_profile.sql.
//
// Ten short questions, each answered in their own words. The answer is read
// by the model into a few structured fields and saved where the rest of OVOA
// will look for it: wake and sleep times in the profile, medications as
// routines (and from there into Apple Reminders), an emergency contact where
// the fall detector already looks. Every question can be skipped, and every
// one can be asked again later by saying so.
//
// It runs the first time someone has Base (paid, or a Band's free days), not at
// sign-up: the app puts the consent screen and the voice picker in front of it
// (app/onboarding.tsx), and a free account never sees it. Since v1 it also asks
// about goals: for each fitness or health goal or habit they name, the model
// designs one of their own apps (myapps.ts designApp, the same as Apps → Create)
// and it's kept for them; an eating goal turns on the Calorie add-on and its
// tracking level instead (food.ts), which the phone adds to its menu.

export type Step = "name" | "nicknames" | "wake_sleep" | "work" | "meds" | "pets" | "gym" | "goals" | "routines" | "emergency";
export const STEPS: Step[] = ["name", "nicknames", "wake_sleep", "work", "meds", "pets", "gym", "goals", "routines", "emergency"];

export type Profile = {
  nicknames: string[];
  wakeTime: number | null;
  sleepTime: number | null;
  workDays: number[] | null;
  workStart: number | null;
  workEnd: number | null;
  gym: string | null;
  leavingChecklist: string[] | null;
  step: Step | null;
  onboardedAt: number | null;
};

type ProfileRow = {
  nicknames: string;
  wake_time: number | null;
  sleep_time: number | null;
  work_days: string | null;
  work_start: number | null;
  work_end: number | null;
  gym: string | null;
  leaving_checklist: string | null;
  step: string | null;
  onboarded_at: number | null;
};

const json = <T>(text: string | null, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

export async function getProfile(db: D1Database, userId: string): Promise<Profile> {
  const row = await db.prepare("SELECT * FROM profile WHERE user_id = ?").bind(userId).first<ProfileRow>();
  return {
    nicknames: json(row?.nicknames ?? null, [] as string[]),
    wakeTime: row?.wake_time ?? null,
    sleepTime: row?.sleep_time ?? null,
    workDays: json(row?.work_days ?? null, null as number[] | null),
    workStart: row?.work_start ?? null,
    workEnd: row?.work_end ?? null,
    gym: row?.gym ?? null,
    leavingChecklist: json(row?.leaving_checklist ?? null, null as string[] | null),
    step: (row?.step as Step | null) ?? null,
    onboardedAt: row?.onboarded_at ?? null,
  };
}

const COLUMNS: Record<string, string> = {
  nicknames: "nicknames",
  wakeTime: "wake_time",
  sleepTime: "sleep_time",
  workDays: "work_days",
  workStart: "work_start",
  workEnd: "work_end",
  gym: "gym",
  leavingChecklist: "leaving_checklist",
  step: "step",
  onboardedAt: "onboarded_at",
};

export async function saveProfile(db: D1Database, userId: string, patch: Partial<Profile>) {
  const entries = Object.entries(patch).filter(([k, v]) => k in COLUMNS && v !== undefined);
  const now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO profile (user_id, updated_at) VALUES (?, ?)").bind(userId, now).run();
  if (!entries.length) return;
  const sets = entries.map(([k]) => `${COLUMNS[k]} = ?`).join(", ");
  const values = entries.map(([, v]) => (Array.isArray(v) ? JSON.stringify(v) : v));
  await db.prepare(`UPDATE profile SET ${sets}, updated_at = ? WHERE user_id = ?`).bind(...values, now, userId).run();
}

/** How the profile reads in a system prompt: a few plain lines, or nothing. */
export function profilePrompt(p: Profile) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const lines = [
    p.nicknames.length ? `They also go by: ${p.nicknames.join(", ")}.` : "",
    p.wakeTime !== null ? `Usually up at ${clockFromMinutes(p.wakeTime)}.` : "",
    p.sleepTime !== null ? `Usually in bed by ${clockFromMinutes(p.sleepTime)}.` : "",
    p.workStart !== null && p.workEnd !== null
      ? `Works ${p.workDays?.length ? p.workDays.map((d) => days[d]).join(", ") : "weekdays"} ${clockFromMinutes(p.workStart)}–${clockFromMinutes(p.workEnd)}.`
      : "",
    p.gym ? `Works out: ${p.gym}.` : "",
    p.leavingChecklist?.length ? `Wants reminding of on the way out: ${p.leavingChecklist.join(", ")}.` : "",
  ].filter(Boolean);
  return lines.length ? `Their day (from setup; change with profile_update):\n${lines.join(" ")}` : "";
}

// ---------- The questions ----------

const time = { type: "string", description: "HH:MM, 24-hour" };
const weekdays = {
  type: "array",
  items: { type: "string", enum: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] },
};
const timedThings = (what: string) => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string", description: `The ${what}, short, in their words` },
      times: { type: "array", items: time, description: "Empty if they didn't say when" },
      days: { ...weekdays, description: "Only if they said particular days" },
    },
    // Not times: something named with no time is still kept, and asked about (addRoutines).
    required: ["title"],
  },
});

type Extracted = Record<string, unknown>;

/**
 * What a step did besides saving: `addons` for the phone to add to its menu
 * (the server can't install one), `apps` it made for them (ids; the phone reads
 * its list of apps again).
 */
type Applied = { facts: string; addons?: string[]; apps?: string[] };

type StepSpec = {
  question: (ctx: { name: string; accounts: string[] }) => string;
  schema: Record<string, unknown>;
  /** Saves what was understood and returns it in a sentence, for the screen to confirm. */
  apply: (env: Env, userId: string, data: Extracted) => Promise<string | Applied>;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const toDays = (v: unknown) =>
  Array.isArray(v) ? v.map((d) => WEEKDAYS.indexOf(String(d).toLowerCase())).filter((d) => d >= 0) : [];
const toTimes = (v: unknown) => (Array.isArray(v) ? v.map(parseClock).filter((m): m is number => m !== null) : []);
const strings = (v: unknown) =>
  Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) : [];

/** What a list of timed things came to: the ones set up, and the ones with no time to set them at. */
type Added = { made: string[]; missed: string[] };

async function addRoutines(env: Env, userId: string, list: unknown, kind: NewRoutine["kind"]): Promise<Added> {
  const made: string[] = [];
  const missed: string[] = [];
  for (const item of Array.isArray(list) ? list.slice(0, 10) : []) {
    const r = item as { title?: unknown; times?: unknown; days?: unknown };
    const title = String(r.title ?? "").trim();
    const times = toTimes(r.times);
    if (!title) continue;
    // Named but no time ("vitamin D", with nothing about when): said back, not
    // dropped in silence behind a "No medications" that isn't true.
    if (!times.length) {
      missed.push(title);
      continue;
    }
    await createRoutine(env.DB, userId, {
      kind,
      title,
      times,
      days: toDays(r.days),
      // Medications belong in Apple Reminders; the phone creates them there on its next sync.
      externalSource: kind === "med" ? "apple_reminders" : null,
    });
    made.push(`${title} at ${times.map(clockFromMinutes).join(" and ")}`);
  }
  if (made.length) await routinesChanged(env, userId);
  return { made, missed };
}

/** "I'll remind you: …", plus anything that couldn't be set up without a time, or `none`. */
function addedLine({ made, missed }: Added, lead: string, none: string) {
  const parts = [
    made.length ? `${lead}${made.join("; ")}.` : "",
    missed.length ? `I didn't catch a time for ${missed.join(" or ")}; tell me when and I'll set it up.` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : none;
}

/** What a step says when nothing was saved. An ack next to one of these is dropped: it can only overclaim. */
const NONE = {
  meds: "No medications to remind you about.",
  pets: "No pet reminders.",
  gym: "No workouts to plan around.",
  goals: "No goals for now. You can make an app for one any time, in Apps.",
  routines: "Nothing else for now.",
};
const NOTHING_SAVED = new Set<string>([
  ...Object.values(NONE),
  "Keeping your name as it is.",
  "No nicknames, noted.",
  "I'll ask about that another time.",
  "No fixed work hours, noted.",
  "No emergency contact for now; you can add one on the Safety tab.",
]);

const STEP_SPECS: Record<Step, StepSpec> = {
  name: {
    question: ({ name }) => `First things first: is ${name} what you'd like me to call you?`,
    schema: { type: "object", properties: { name: { type: "string", description: "What to call them, or empty to keep the current name" } } },
    apply: async (env, userId, d) => {
      const name = String(d.name ?? "").trim().slice(0, 80);
      if (!name) return "Keeping your name as it is.";
      await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, userId).run();
      return `I'll call you ${name}.`;
    },
  },
  nicknames: {
    question: () => "Does anyone call you something else — a nickname or a short version?",
    schema: { type: "object", properties: { nicknames: { type: "array", items: { type: "string" } } } },
    apply: async (env, userId, d) => {
      const nicknames = strings(d.nicknames);
      await saveProfile(env.DB, userId, { nicknames });
      return nicknames.length ? `Got it: ${nicknames.join(", ")}.` : "No nicknames, noted.";
    },
  },
  wake_sleep: {
    question: () => "Roughly when do you get up, and when do you go to bed?",
    schema: { type: "object", properties: { wake: time, sleep: time } },
    apply: async (env, userId, d) => {
      const wakeTime = parseClock(d.wake);
      const sleepTime = parseClock(d.sleep);
      await saveProfile(env.DB, userId, {
        ...(wakeTime !== null && { wakeTime }),
        ...(sleepTime !== null && { sleepTime }),
      });
      if (wakeTime === null && sleepTime === null) return "I'll ask about that another time.";
      return [
        wakeTime !== null ? `up around ${clockFromMinutes(wakeTime)}` : "",
        sleepTime !== null ? `bed around ${clockFromMinutes(sleepTime)} — I'll have tomorrow's list ready an hour before, and nudge you at bedtime` : "",
      ]
        .filter(Boolean)
        .join(", ")
        .replace(/^./, (c) => c.toUpperCase()) + ".";
    },
  },
  work: {
    question: ({ accounts }) =>
      `Do you work set hours? Which days, and roughly when?${
        accounts.length > 1 ? ` And which of your Google accounts is the work one: ${accounts.join(" or ")}?` : ""
      }`,
    schema: {
      type: "object",
      properties: {
        works: { type: "boolean" },
        days: weekdays,
        start: time,
        end: time,
        workAccount: { type: "string", description: "The email of the work Google account, if they said" },
      },
    },
    apply: async (env, userId, d) => {
      const out: string[] = [];
      const start = parseClock(d.start);
      const end = parseClock(d.end);
      if (d.works !== false && start !== null && end !== null) {
        const days = toDays(d.days);
        await saveProfile(env.DB, userId, { workStart: start, workEnd: end, workDays: days.length ? days : [1, 2, 3, 4, 5] });
        out.push(`Work ${clockFromMinutes(start)}–${clockFromMinutes(end)}`);
      }
      const want = String(d.workAccount ?? "").trim().toLowerCase();
      if (want) {
        const match = (await listGoogleAccounts(env.DB, userId)).find((a) => a.email.toLowerCase() === want);
        if (match && !(await setAccountLabel(env.DB, userId, match.id, "work"))) out.push(`${match.email} is your work account`);
      }
      return out.length ? `${out.join("; ")}.` : "No fixed work hours, noted.";
    },
  },
  meds: {
    question: () =>
      "Do you take any medication or supplements I should remind you about? Tell me what and when — they'll go into a Medications list in Apple Reminders, which stays the real copy.",
    schema: { type: "object", properties: { meds: timedThings("medication") } },
    apply: async (env, userId, d) => {
      return addedLine(await addRoutines(env, userId, d.meds, "med"), "I'll remind you: ", NONE.meds);
    },
  },
  pets: {
    question: () => "Any pets that need walking or feeding at set times?",
    schema: { type: "object", properties: { tasks: timedThings("pet task, e.g. 'Walk Rex'") } },
    apply: async (env, userId, d) => {
      return addedLine(await addRoutines(env, userId, d.tasks, "pet"), "Pet reminders: ", NONE.pets);
    },
  },
  gym: {
    question: () => "Do you work out? Where, and on which days?",
    schema: {
      type: "object",
      properties: {
        works_out: { type: "boolean", description: "True if they work out at all, even without naming a place" },
        where: { type: "string", description: "Gym name or kind of exercise, if they said; empty otherwise" },
        days: { ...weekdays, description: "Every day / 7 days a week means all seven" },
        time: { ...time, description: "When they start, HH:MM 24-hour ('1-2pm' starts at 13:00)" },
      },
    },
    apply: async (env, userId, d) => {
      const where = String(d.where ?? "").trim().slice(0, 120);
      const days = toDays(d.days);
      const at = parseClock(d.time);
      // "7 days a week, 1-2pm" names no gym, and used to read as no workouts at all.
      // An outright "no" still wins over anything else the model filled in.
      const works = d.works_out !== false && (d.works_out === true || !!where || at !== null || days.length > 0);
      if (!works) return NONE.gym;
      const what = where || "Workouts";
      // Only what they said: no days given is no days claimed.
      const when = days.length === 7 ? "every day" : days.length ? `on ${days.map((i) => WEEKDAYS[i][0].toUpperCase() + WEEKDAYS[i].slice(1, 3)).join(", ")}` : "";
      const said = [what, when, at !== null ? `at ${clockFromMinutes(at)}` : ""].filter(Boolean).join(" ");
      await saveProfile(env.DB, userId, { gym: said });
      if (at !== null) {
        await addRoutines(env, userId, [{ title: where ? `Workout (${where})` : "Workout", times: [d.time], days: d.days }], "habit");
        return `${said}. I'll plan around it and nudge you at ${clockFromMinutes(at)}${days.length && days.length < 7 ? " on those days" : days.length ? "" : " each day (tell me the days if it's not every day)"}.`;
      }
      return `${said}, noted.`;
    },
  },
  goals: {
    question: () => "Any fitness or health goals, or habits you want help with? I'll make you an app for each one.",
    schema: {
      type: "object",
      properties: {
        goals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              goal: { type: "string", description: "The goal or habit, short, in their words" },
              kind: {
                type: "string",
                enum: ["eating", "other"],
                description:
                  "eating: about what or how much they eat or drink (calories, protein, eating better). other: anything else (exercise, sleep, water, a habit to build or break)",
              },
              detail: { type: "string", description: "Everything they said about this goal, in their words" },
              level: {
                type: "string",
                enum: ["quick", "normal", "strict"],
                description:
                  "eating only, and only if they said how closely to keep track: quick for a rough idea, strict for exact numbers; otherwise leave it out",
              },
              kcal: { type: "number", description: "eating only: a daily calorie target, only if they said a number" },
            },
            required: ["goal", "kind"],
          },
        },
      },
    },
    apply: async (env, userId, d) => applyGoals(env, userId, d.goals),
  },
  routines: {
    question: () => "Anything else you'd like a daily nudge for — water, stretching, anything at all?",
    schema: { type: "object", properties: { routines: timedThings("routine") } },
    apply: async (env, userId, d) => {
      return addedLine(await addRoutines(env, userId, d.routines, "habit"), "Set up: ", NONE.routines);
    },
  },
  emergency: {
    question: () => "Last one: who should I contact if you fall or need help? A name and phone number.",
    schema: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" } } },
    apply: async (env, userId, d) => {
      const name = String(d.name ?? "").trim().slice(0, 80);
      const phone = String(d.phone ?? "").replace(/[^\d+]/g, "").slice(0, 20);
      if (!name || phone.length < 5) return "No emergency contact for now; you can add one on the Safety tab.";
      // The same list the fall detector and SOS already use.
      await env.DB.prepare("INSERT INTO emergency_contacts (id, user_id, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), userId, name, phone, Date.now())
        .run();
      return `${name} is your emergency contact.`;
    },
  },
};

/** At most this many apps from one answer: each is a model call, and they're made while the person waits. */
const MAX_GOAL_APPS = 3;

type Goal = { goal: string; kind: string; detail: string; level: unknown; kcal: number | null };

/** "A", "A and B", "A, B and C". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * The goals step. Eating goals turn on Calorie (tracking level and target, if
 * they said them); every other goal gets an app of its own, designed and kept
 * the way Apps → Create does it. A design that fails, or that the gate turns
 * down (the day's spend used up halfway), is said, not hidden, and the apps
 * already made are kept and reported: the step is done either way (it was
 * claimed before any of this, onboardingAnswer), so they're never made twice.
 */
async function applyGoals(env: Env, userId: string, raw: unknown): Promise<Applied> {
  const goals: Goal[] = (Array.isArray(raw) ? raw : [])
    .map((g) => g as Record<string, unknown>)
    .map((g) => ({
      goal: String(g.goal ?? "").trim().slice(0, 120),
      kind: String(g.kind ?? "other"),
      detail: String(g.detail ?? "").trim().slice(0, 600),
      level: g.level,
      kcal: typeof g.kcal === "number" && g.kcal > 0 ? g.kcal : null,
    }))
    .filter((g) => g.goal);
  if (!goals.length) return { facts: NONE.goals };
  const eating = goals.filter((g) => g.kind === "eating");
  const others = goals.filter((g) => g.kind !== "eating");
  const parts: string[] = [];
  const addons: string[] = [];

  const made = await Promise.all(
    others.slice(0, MAX_GOAL_APPS).map(async (g) => {
      try {
        const draft = await designApp(env, userId, `An app to help me with this: ${g.goal}.${g.detail ? ` ${g.detail}` : ""}`);
        const app = await saveApp(env.DB, userId, draft);
        return app ? { goal: g.goal, app } : { goal: g.goal, full: true };
      } catch (err) {
        if (!isModelRefused(err)) console.error("onboarding: couldn't make an app for a goal", err);
        return { goal: g.goal };
      }
    }),
  );
  const apps = made.flatMap((m) => ("app" in m && m.app ? [m.app] : []));
  if (apps.length) {
    parts.push(
      `I made you ${apps.length === 1 ? "an app" : "an app for each"}: ${listed(apps.map((a) => a.name))}. ${apps.length === 1 ? "It's" : "They're"} in Apps, under Your apps.`,
    );
  }
  const missed = made.filter((m) => !("app" in m)).map((m) => m.goal);
  if (missed.length) {
    parts.push(
      made.some((m) => "full" in m)
        ? "You already have as many apps as you can make, so I didn't make more."
        : `I couldn't make one for ${listed(missed)} just now. You can make it yourself in Apps, with Create.`,
    );
  }
  if (others.length > MAX_GOAL_APPS) parts.push("For the rest, make an app any time in Apps, with Create.");

  if (eating.length) {
    const level = eating.map((g) => g.level).find(isFoodLevel);
    // A level they asked for is theirs; otherwise the add-on's own first open asks.
    if (level) await setFoodLevel(env.DB, userId, level);
    else await setCalorieInstalled(env.DB, userId, true);
    const kcal = eating.map((g) => g.kcal).find((k): k is number => k !== null);
    if (kcal) await setFoodTarget(env.DB, userId, { kcal });
    addons.push("calorie");
    parts.push("I've added Calorie: tell me what you eat and I'll keep track.");
  }
  return { facts: parts.join(" "), addons, apps: apps.map((a) => a.id) };
}

async function questionFor(env: Env, userId: string, step: Step) {
  const [user, accounts] = await Promise.all([
    env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>(),
    listGoogleAccounts(env.DB, userId),
  ]);
  return STEP_SPECS[step].question({ name: user?.name ?? "you", accounts: accounts.map((a) => a.email) });
}

/** The next question, or done. */
export async function onboardingNext(env: Env, userId: string) {
  const profile = await getProfile(env.DB, userId);
  if (profile.onboardedAt) return { done: true as const };
  const step = profile.step ?? STEPS[0];
  return { done: false as const, step, index: STEPS.indexOf(step), total: STEPS.length, question: await questionFor(env, userId, step) };
}

async function advance(env: Env, userId: string, from: Step) {
  const next = STEPS[STEPS.indexOf(from) + 1];
  await saveProfile(env.DB, userId, next ? { step: next } : { step: null, onboardedAt: Date.now() });
  return onboardingNext(env, userId);
}

/** How an answer is read, whichever step it's for. */
const GUIDE = [
  "'Every day' or '7 days a week' means all seven days of the week; 'weekdays' means Monday to Friday. A range like '1-2pm' starts at 13:00.",
  "A part of the day is a time: morning 08:00, noon or lunch 12:00, afternoon 15:00, evening or dinner 18:00, night or bedtime 21:00. 'Twice a day' is 08:00 and 20:00.",
  "If they said no, none, skip, or didn't answer the question, return empty values. Never invent anything.",
];
const ACK_GUIDE =
  "ack: one short, natural sentence reacting to what they said, the way a friend who's paying attention would (the tone of 'Every day? That's real dedication.', in your own words). Specific to their answer, never generic like 'Got it, thanks for sharing'. It must not promise anything or say what you'll do (another line says exactly what was saved). No question, no emoji.";

const withAck = (schema: Record<string, unknown>) => ({
  ...schema,
  properties: { ...(schema.properties as object), ack: { type: "string" } },
});

/**
 * The goals step is claimed (moved on) before its apps are made, only if it's
 * still the current step: a second try that arrives while the first is still
 * designing finds it gone. False when someone else already has it.
 */
async function claimStep(env: Env, userId: string, step: Step) {
  const next = STEPS[STEPS.indexOf(step) + 1];
  if (!next) return true;
  const res = await env.DB.prepare("UPDATE profile SET step = ?, updated_at = ? WHERE user_id = ? AND step = ?")
    .bind(next, Date.now(), userId, step)
    .run();
  return res.meta.changes > 0;
}

/** Reads one answer into fields with the model, then saves them. */
export async function onboardingAnswer(env: Env, userId: string, step: Step, text: string) {
  // An answer for a step that isn't the current one is neither read nor
  // applied again: a retry after the first try went through but its reply was
  // lost (a timeout), or setup already done. The goals step makes apps, so
  // twice would be twice the apps. The phone is told where setup is now.
  const profile = await getProfile(env.DB, userId);
  if (profile.onboardedAt || step !== (profile.step ?? STEPS[0])) return { understood: null, next: await onboardingNext(env, userId) };
  const spec = STEP_SPECS[step];
  const tz = await env.DB.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  const question = await questionFor(env, userId, step);
  const read = (withReaction: boolean) =>
    generateText(env, {
      model: env.MEMORY_MODEL,
      // Every answer also gets a reaction in the assistant's own words, so setup
      // sounds like someone listening rather than a form being filled in.
      json: { schema: withReaction ? withAck(spec.schema) : spec.schema },
      fast: true,
      usage: { userId, purpose: "onboarding" },
      system: [
        "You read one answer from a new user setting up their personal assistant, and pull out only what they actually said.",
        "Times are 24-hour HH:MM in their own time zone" + (tz?.time_zone ? ` (${tz.time_zone})` : "") + ". 'Eight' in the morning is 08:00; 'ten at night' is 22:00.",
        ...GUIDE,
        ...(withReaction ? [ACK_GUIDE] : []),
      ].join("\n"),
      turns: [{ role: "user", text: JSON.stringify({ question, answer: text }) }],
    });
  let data: Extracted | null = null;
  // A reply that isn't JSON is read again, plainly: the free-text reaction is the
  // likeliest thing to break it, and losing it is better than losing the answer.
  for (const withReaction of [true, false]) {
    try {
      data = JSON.parse(await read(withReaction)) as Extracted;
      break;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  if (!data) throw new Error("I didn't quite get that. Could you say it another way?");
  // Goals: taken before a single app is designed (see claimStep). It isn't
  // handed back if something fails after: apps may already have been made.
  const claimed = step === "goals";
  if (claimed && !(await claimStep(env, userId, step))) return { understood: null, next: await onboardingNext(env, userId) };
  const applied = await spec.apply(env, userId, data);
  const { facts, addons, apps } = typeof applied === "string" ? ({ facts: applied } as Applied) : applied;
  const ack = typeof data.ack === "string" && !NOTHING_SAVED.has(facts) ? data.ack.trim().slice(0, 200) : "";
  const understood = ack ? `${ack} ${facts}` : facts;
  // addons: for the phone to add to its menu (Calorie); apps: made for them, for it to read again.
  const next = claimed ? await onboardingNext(env, userId) : await advance(env, userId, step);
  return { understood, next, ...(addons?.length && { addons }), ...(apps?.length && { apps }) };
}

// ---------- Routes ----------

export const onboarding = new Hono<{ Bindings: Env; Variables: Vars }>();

onboarding.get("/onboarding", async (c) => c.json(await onboardingNext(c.env, c.var.userId)));

const stepSchema = z.enum(STEPS as [Step, ...Step[]]);

onboarding.post("/onboarding/answer", async (c) => {
  const parsed = z.object({ step: stepSchema, text: z.string().trim().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "An answer is required" }, 400);
  try {
    return c.json(await onboardingAnswer(c.env, c.var.userId, parsed.data.step, parsed.data.text));
  } catch (err) {
    // Not part of their plan, the day's spend is used up, or no consent yet: said plainly (plans.ts).
    if (isModelRefused(err)) return refusedResponse(c, err);
    console.error("onboarding: couldn't read the answer", err);
    // No engine could answer: said plainly, the way a turn says it (llm.ts).
    if (isAiUnreachable(err)) return c.json({ error: AI_UNREACHABLE }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Couldn't read that" }, 502);
  }
});

onboarding.post("/onboarding/skip", async (c) => {
  const parsed = z.object({ step: stepSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Which step?" }, 400);
  return c.json({ understood: null, next: await advance(c.env, c.var.userId, parsed.data.step) });
});

/** "Finish later": onboarding stops asking, and can be started again from Settings. */
onboarding.post("/onboarding/finish", async (c) => {
  await saveProfile(c.env.DB, c.var.userId, { step: null, onboardedAt: Date.now() });
  return c.json({ done: true });
});

/** From Settings: go through it again. Nothing already set up is removed. */
onboarding.post("/onboarding/restart", async (c) => {
  await saveProfile(c.env.DB, c.var.userId, { step: STEPS[0], onboardedAt: null });
  return c.json(await onboardingNext(c.env, c.var.userId));
});

onboarding.get("/profile", async (c) => c.json({ profile: await getProfile(c.env.DB, c.var.userId) }));

// ---------- In conversation ----------

const FIELDS = ["wake_time", "sleep_time", "work_hours", "work_days", "nicknames", "gym", "leaving_checklist"] as const;

const TOOLS: ToolSpec[] = [
  {
    name: "profile_update",
    description:
      "Changes one fact about their day that OVOA plans around: when they get up or go to bed, work hours or days, nicknames, where they work out, what to check on the way out. For 'I get up at six now', 'I work Saturdays too'. To go through all of setup again, tell them it's in Settings.",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", enum: FIELDS },
        value: {
          type: "string",
          description:
            "wake_time / sleep_time: HH:MM. work_hours: HH:MM-HH:MM. work_days / nicknames / leaving_checklist: comma-separated (weekday names for work_days). gym: text.",
        },
      },
      required: ["field", "value"],
    },
  },
];

export const isProfileTool = (name: string) => name === "profile_update";

export function profileAssistant(env: Env, userId: string) {
  const callTool: CallTool = async (_name, args) => {
    const field = String(args.field ?? "");
    const value = String(args.value ?? "").trim();
    const list = value.split(",").map((s) => s.trim()).filter(Boolean);
    switch (field) {
      case "wake_time":
      case "sleep_time": {
        const m = parseClock(value);
        if (m === null) return { error: "value must be HH:MM" };
        await saveProfile(env.DB, userId, field === "wake_time" ? { wakeTime: m } : { sleepTime: m });
        return { saved: true, [field]: clockFromMinutes(m) };
      }
      case "work_hours": {
        const [start, end] = value.split("-").map(parseClock);
        if (start == null || end == null) return { error: "value must be HH:MM-HH:MM" };
        await saveProfile(env.DB, userId, { workStart: start, workEnd: end });
        return { saved: true };
      }
      case "work_days": {
        const days = toDays(list);
        if (!days.length) return { error: "value must be weekday names" };
        await saveProfile(env.DB, userId, { workDays: days });
        return { saved: true };
      }
      case "nicknames":
        await saveProfile(env.DB, userId, { nicknames: list.slice(0, 12) });
        return { saved: true };
      case "leaving_checklist":
        await saveProfile(env.DB, userId, { leavingChecklist: list.slice(0, 12) });
        return { saved: true };
      case "gym":
        await saveProfile(env.DB, userId, { gym: value.slice(0, 120) || null });
        return { saved: true };
      default:
        return { error: `field must be one of ${FIELDS.join(", ")}` };
    }
  };
  return { tools: TOOLS, callTool };
}
