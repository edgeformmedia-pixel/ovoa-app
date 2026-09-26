import { Hono } from "hono";
import { z } from "zod";
import { logAction, type ActionSource } from "./actionlog";
import { sendBuzz, type BuzzPattern, BUZZ_PATTERNS } from "./buzz";
import { capabilities } from "./capabilities";
import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { push } from "./push";
import { reach } from "./reach";
import { addDays, atLocalTime, buckets, clock, clockFromMinutes, inQuietHours, localWeekday } from "./time";
import type { Env, Vars } from "./types";

// Routines, medications and reminders. See migrations/0016_routines.sql.
//
// A routine is a title and some times of day. Each time it comes round the cron
// writes an occurrence, taps the wrist if there's a band, and waits to hear it
// was done. Nothing heard: at 15 minutes it buzzes again, at an hour it says it
// out loud, and when the window closes it is written down as missed. Hearing it
// was done can come from a notification's Done button, from saying "took it", or
// from ticking the reminder off in Apple Reminders itself.
//
// None of this needs a band, Google, a watch or location. The band makes it a
// tap instead of a notification; that is all.

export type RoutineKind = "med" | "pet" | "habit" | "custom";
const KINDS: RoutineKind[] = ["med", "pet", "habit", "custom"];

/** Unconfirmed this long after the due time: buzz again. */
export const ESCALATE_BUZZ_MIN = 15;
/** Unconfirmed this long: say it out loud. */
export const ESCALATE_SPEAK_MIN = 60;
/** Routines per user. A reminder system with 200 entries is a notification firehose. */
const MAX_ROUTINES = 60;
const DEFAULT_SNOOZE_MIN = 10;

export type RoutineRow = {
  id: string;
  user_id: string;
  kind: RoutineKind;
  title: string;
  times: string;
  days: string;
  buzz_pattern: string;
  meta_json: string | null;
  context: string | null;
  window_minutes: number;
  active: number;
  external_source: string | null;
  external_id: string | null;
  next_due_at: number | null;
  urgent: number;
  created_at: number;
  updated_at: number;
};

const parseList = (json: string | null) => {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
};

// ---------- When ----------

/**
 * The first occurrence strictly after `from`, or null if the routine has no
 * times. Walks the user's own days, so 8:00 is 8:00 in their kitchen on the day
 * the clocks change too.
 */
export function nextOccurrence(times: number[], days: number[], from: number, timeZone: string): number | null {
  if (!times.length) return null;
  const sorted = [...times].sort((a, b) => a - b);
  const today = buckets(from, timeZone).day;
  for (let i = 0; i <= 8; i++) {
    const day = addDays(today, i);
    if (days.length && !days.includes(localWeekday(atLocalTime(day, 720, timeZone), timeZone))) continue;
    for (const t of sorted) {
      const at = atLocalTime(day, t, timeZone);
      if (at > from) return at;
    }
  }
  return null;
}

/** Every occurrence in [from, to), for scheduling the phone's local notifications. */
export function occurrencesBetween(times: number[], days: number[], from: number, to: number, timeZone: string) {
  const out: number[] = [];
  let at = nextOccurrence(times, days, from - 1, timeZone);
  while (at !== null && at < to && out.length < 200) {
    out.push(at);
    at = nextOccurrence(times, days, at, timeZone);
  }
  return out;
}

/** "08:00" or "8:00" → 480. */
export function parseClock(value: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function describeRoutine(r: Pick<RoutineRow, "times" | "days">) {
  const times = parseList(r.times).sort((a, b) => a - b).map(clockFromMinutes);
  const days = parseList(r.days);
  const when = days.length && days.length < 7 ? `on ${days.map((d) => WEEKDAYS[d].slice(0, 3)).join(", ")}` : "every day";
  return `${when} at ${times.join(" and ")}`;
}

// ---------- Changing them ----------

async function timeZoneFor(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  return validTimeZone(row?.time_zone);
}

export type NewRoutine = {
  kind: RoutineKind;
  title: string;
  times: number[];
  days?: number[];
  buzzPattern?: BuzzPattern;
  context?: "work" | "personal" | null;
  windowMinutes?: number;
  externalSource?: RoutineRow["external_source"];
  externalId?: string | null;
  meta?: Record<string, unknown>;
  /** Keeps buzzing until confirmed. Medication is urgent unless said otherwise. */
  urgent?: boolean;
};

/** Words that say nothing about what a reminder or routine is for: "Water check" and "Gym check" are two things. */
const SUBJECT_FILLER = new Set([
  "check", "checkin", "reminder", "remind", "routine", "daily", "every", "day", "time", "today", "tonight",
  "tomorrow", "morning", "evening", "night", "keep", "going", "have", "your", "you", "about", "this", "that",
  "with", "from", "done", "make", "sure", "dont", "forget", "yet", "now", "did", "get", "the", "and", "for",
]);

const subjectWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[‘’']/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !SUBJECT_FILLER.has(w)),
  );

/**
 * Whether two reminders' or routines' words are about the same thing: a word
 * that says what for, in both ("Water check" and "Gallon of water"; not "Water
 * check" and "Gym check"). Pure.
 */
export function sameSubject(a: string, b: string) {
  const words = subjectWords(b);
  return [...subjectWords(a)].some((w) => words.has(w));
}

/**
 * The active routine `title` would repeat, if there is one. The day after
 * "hold me accountable to the gym" was set up, "what time is it?" was answered
 * with an apology that it never was, and the gym and water routines were
 * added a second time (followup-probe against production, 2026-09-24).
 */
async function existingRoutine(db: D1Database, userId: string, title: string) {
  const { results } = await db
    .prepare("SELECT id, title, times, days FROM routines WHERE user_id = ? AND active = 1")
    .bind(userId)
    .all<{ id: string; title: string; times: string; days: string }>();
  return results.find((r) => sameSubject(r.title, title)) ?? null;
}

export async function createRoutine(db: D1Database, userId: string, r: NewRoutine) {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM routines WHERE user_id = ? AND active = 1").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ROUTINES) throw new Error(`There are already ${MAX_ROUTINES} routines. Remove one first.`);
  const timeZone = await timeZoneFor(db, userId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const times = [...new Set(r.times)].sort((a, b) => a - b);
  const days = [...new Set(r.days ?? [])].sort();
  await db
    .prepare(
      `INSERT INTO routines (id, user_id, kind, title, times, days, buzz_pattern, meta_json, context, window_minutes,
                             external_source, external_id, next_due_at, created_at, updated_at, urgent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      r.kind,
      r.title.slice(0, 120),
      JSON.stringify(times),
      JSON.stringify(days),
      r.buzzPattern ?? (r.kind === "med" ? "meds" : "reminder"),
      r.meta ? JSON.stringify(r.meta) : null,
      r.context ?? null,
      r.windowMinutes ?? 120,
      r.externalSource ?? null,
      r.externalId ?? null,
      nextOccurrence(times, days, now, timeZone),
      now,
      now,
      Number(r.urgent ?? r.kind === "med"),
    )
    .run();
  return id;
}

export async function updateRoutine(
  db: D1Database,
  userId: string,
  id: string,
  patch: { title?: string; times?: number[]; days?: number[]; active?: boolean; buzzPattern?: BuzzPattern },
) {
  const row = await db.prepare("SELECT * FROM routines WHERE id = ? AND user_id = ?").bind(id, userId).first<RoutineRow>();
  if (!row) return null;
  const timeZone = await timeZoneFor(db, userId);
  const times = patch.times ? [...new Set(patch.times)].sort((a, b) => a - b) : parseList(row.times);
  const days = patch.days ? [...new Set(patch.days)].sort() : parseList(row.days);
  const active = patch.active ?? !!row.active;
  await db
    .prepare(
      `UPDATE routines SET title = ?, times = ?, days = ?, active = ?, buzz_pattern = ?, next_due_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(
      patch.title?.slice(0, 120) ?? row.title,
      JSON.stringify(times),
      JSON.stringify(days),
      Number(active),
      patch.buzzPattern ?? row.buzz_pattern,
      active ? nextOccurrence(times, days, Date.now(), timeZone) : null,
      Date.now(),
      id,
      userId,
    )
    .run();
  return id;
}

export async function listRoutines(db: D1Database, userId: string, includeInactive = false) {
  const { results } = await db
    .prepare(`SELECT * FROM routines WHERE user_id = ? ${includeInactive ? "" : "AND active = 1"} ORDER BY created_at`)
    .bind(userId)
    .all<RoutineRow>();
  return results;
}

// ---------- Firing ----------

const TITLES: Record<RoutineKind, string> = { med: "Medication", pet: "Pet", habit: "Reminder", custom: "Reminder" };

type DueRow = RoutineRow & {
  time_zone: string | null;
  quiet_start: number;
  quiet_end: number;
  routines_synced_at: number | null;
};

/**
 * Tells the user an occurrence is due: a buzz when there's a band, and a
 * visible notification when the phone doesn't already have its own copy
 * scheduled. Medications go through quiet hours; a water reminder at 2am does not.
 */
async function announce(env: Env, r: DueRow, eventId: string, dueAt: number, line: string, again = false) {
  const timeZone = validTimeZone(r.time_zone);
  if (r.kind !== "med" && inQuietHours(Date.now(), timeZone, r.quiet_start, r.quiet_end)) return "quiet";
  const caps = await capabilities(env.DB, r.user_id);
  // Urgent (pills): the phone buzzes every 30 s until it hears "I took it"; the
  // two-minute backstop pushes are alarms.ts's nagTick.
  if (r.urgent && !again) {
    await push(env, r.user_id, {
      silent: true,
      data: { type: "nag", id: crypto.randomUUID(), key: `routine:${r.id}:${dueAt}`, label: r.title, routineId: r.id, dueAt },
    });
  }
  const pattern = (BUZZ_PATTERNS as string[]).includes(r.buzz_pattern) ? (r.buzz_pattern as BuzzPattern) : "reminder";
  if (caps.band) await sendBuzz(env, r.user_id, pattern, line, "system", r.id);
  // The phone's local notification covers the first announcement when it knows
  // about this routine. Follow-ups, and routines it hasn't synced yet, come from here.
  const phoneHasIt = !again && !!r.routines_synced_at && r.routines_synced_at >= r.updated_at;
  if (!phoneHasIt && !caps.band) {
    await push(env, r.user_id, {
      title: TITLES[r.kind],
      body: line,
      urgent: r.kind === "med",
      data: { type: "routine", routineId: r.id, eventId, dueAt },
      categoryId: "routine",
    });
  }
  return caps.band ? "band" : phoneHasIt ? "phone" : "push";
}

/** Every routine whose next occurrence has come. Called from the cron, every two minutes. */
export async function fireDueRoutines(env: Env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT r.*, s.time_zone, s.quiet_start, s.quiet_end, d.routines_synced_at
       FROM routines r
       JOIN settings s ON s.user_id = r.user_id
       LEFT JOIN device_state d ON d.user_id = r.user_id
      WHERE r.active = 1 AND r.next_due_at IS NOT NULL AND r.next_due_at <= ?
      ORDER BY r.next_due_at LIMIT 50`,
  )
    .bind(now)
    .all<DueRow>();

  let fired = 0;
  for (const r of results) {
    const due = r.next_due_at!;
    const timeZone = validTimeZone(r.time_zone);
    const next = nextOccurrence(parseList(r.times), parseList(r.days), Math.max(due, now - 60_000), timeZone);
    // Claimed first, and only if nobody else moved it: two overlapping ticks fire once.
    const claim = await env.DB.prepare("UPDATE routines SET next_due_at = ? WHERE id = ? AND next_due_at = ?")
      .bind(next, r.id, due)
      .run();
    if (!claim.meta.changes) continue;

    // A tick that ran very late (the cron was down) records it as missed rather
    // than announcing something the window has already closed on.
    const stale = due < now - r.window_minutes * 60_000;
    const eventId = crypto.randomUUID();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO routine_events (id, routine_id, user_id, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(eventId, r.id, r.user_id, due, stale ? "missed" : "pending", now)
      .run();
    // Once a day per routine: the days now old enough go into its running streak.
    await settleQuietly(env.DB, r.id, timeZone);
    // Already confirmed from the phone before the server got here.
    if (!inserted.meta.changes || stale) continue;

    try {
      const how = await announce(env, r, eventId, due, `${r.title} — ${clock(due, timeZone)}`);
      await logAction(env.DB, r.user_id, "routine_fired", `${r.title} (${how})`, "system", r.id);
      fired++;
    } catch (err) {
      console.error(`routines: couldn't announce ${r.id}`, err);
    }
  }
  return fired;
}

/**
 * Chasing what hasn't been confirmed: buzz again at 15 minutes, say it at an
 * hour, and write it down as missed when its window closes.
 */
export async function escalate(env: Env) {
  const now = Date.now();
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT e.id AS event_id, e.due_at, e.status, e.escalation, e.snooze_until,
              r.*, s.time_zone, s.quiet_start, s.quiet_end, d.routines_synced_at
         FROM routine_events e
         JOIN routines r ON r.id = e.routine_id
         JOIN settings s ON s.user_id = e.user_id
         LEFT JOIN device_state d ON d.user_id = e.user_id
        WHERE e.status IN ('pending', 'snoozed') AND e.due_at <= ?
        ORDER BY e.due_at LIMIT 100`,
    )
    .bind(now)
    .all<DueRow & { event_id: string; due_at: number; status: string; escalation: number; snooze_until: number | null }>();

  let changed = 0;
  for (const e of results) {
    const age = now - e.due_at;
    const timeZone = validTimeZone(e.time_zone);

    if (age >= e.window_minutes * 60_000) {
      await db.prepare("UPDATE routine_events SET status = 'missed' WHERE id = ? AND status IN ('pending', 'snoozed')").bind(e.event_id).run();
      await settleQuietly(db, e.id, timeZone);
      await logAction(db, e.user_id, "routine_missed", `Missed: ${e.title} (${clock(e.due_at, timeZone)})`, "system", e.id);
      changed++;
      continue;
    }

    if (e.status === "snoozed") {
      if (e.snooze_until && e.snooze_until <= now) {
        await db.prepare("UPDATE routine_events SET status = 'pending', snooze_until = NULL WHERE id = ?").bind(e.event_id).run();
        await announce(env, e, e.event_id, e.due_at, `${e.title} — snoozed ${DEFAULT_SNOOZE_MIN} min, now due`, true);
        changed++;
      }
      continue;
    }

    if (e.urgent) continue;
    if (e.escalation === 0 && age >= ESCALATE_BUZZ_MIN * 60_000) {
      await db.prepare("UPDATE routine_events SET escalation = 1 WHERE id = ? AND escalation = 0").bind(e.event_id).run();
      await announce(env, e, e.event_id, e.due_at, `Still waiting: ${e.title}`, true);
      changed++;
    } else if (e.escalation === 1 && age >= ESCALATE_SPEAK_MIN * 60_000) {
      await db.prepare("UPDATE routine_events SET escalation = 2 WHERE id = ? AND escalation = 1").bind(e.event_id).run();
      if (e.kind !== "med" && inQuietHours(now, timeZone, e.quiet_start, e.quiet_end)) continue;
      const line = e.kind === "med" ? `Did you take ${e.title}?` : `Did you do ${e.title}?`;
      // Spoken by the phone if it's awake to do it; the notification goes either way,
      // since a silent push to a suspended app may never arrive.
      await push(env, e.user_id, { silent: true, data: { type: "speak", id: crypto.randomUUID(), text: line } });
      // The accountability check-in: a text for someone who texts OVOA (reach.ts), where "done"
      // is routine_confirm and "later" a snooze; the notification with its buttons otherwise.
      await reach(env, e.user_id, {
        kind: "routine",
        text: `${line} Text "done" when you have, or "snooze" for later.`,
        push: {
          title: TITLES[e.kind],
          body: line,
          urgent: e.kind === "med",
          data: { type: "routine", routineId: e.id, eventId: e.event_id, dueAt: e.due_at },
          categoryId: "routine",
        },
      });
      changed++;
    }
  }
  return changed;
}

// ---------- Hearing it was done ----------

type Confirm = { routineId?: string; eventId?: string; dueAt?: number; via: "notification" | "voice" | "app" | "external" };

/**
 * Marks an occurrence done. Without a specific one, it's the most recent that
 * is still waiting — which is what "took it" means.
 */
export async function confirmRoutine(db: D1Database, userId: string, c: Confirm, source: ActionSource = "chat", env?: Env) {
  const now = Date.now();
  let event: { id: string; routine_id: string; due_at: number } | null = null;

  if (c.eventId) {
    event = await db
      .prepare("SELECT id, routine_id, due_at FROM routine_events WHERE id = ? AND user_id = ?")
      .bind(c.eventId, userId)
      .first();
  } else if (c.routineId && c.dueAt) {
    event = await db
      .prepare("SELECT id, routine_id, due_at FROM routine_events WHERE routine_id = ? AND user_id = ? AND due_at = ?")
      .bind(c.routineId, userId, c.dueAt)
      .first();
    if (!event) {
      // Confirmed on the phone before the server's tick reached it: record it now,
      // so the tick finds it done and says nothing.
      const own = await db.prepare("SELECT 1 FROM routines WHERE id = ? AND user_id = ?").bind(c.routineId, userId).first();
      if (!own) return null;
      const id = crypto.randomUUID();
      await db
        .prepare(
          "INSERT OR IGNORE INTO routine_events (id, routine_id, user_id, due_at, status, confirmed_at, via, created_at) VALUES (?, ?, ?, ?, 'done', ?, ?, ?)",
        )
        .bind(id, c.routineId, userId, c.dueAt, now, c.via, now)
        .run();
      event = { id, routine_id: c.routineId, due_at: c.dueAt };
    }
  } else {
    event = await db
      .prepare(
        `SELECT id, routine_id, due_at FROM routine_events
          WHERE user_id = ? AND status IN ('pending', 'snoozed') ${c.routineId ? "AND routine_id = ?" : ""}
          ORDER BY due_at DESC LIMIT 1`,
      )
      .bind(...(c.routineId ? [userId, c.routineId] : [userId]))
      .first();
  }
  if (!event) return null;

  await db
    .prepare("UPDATE routine_events SET status = 'done', confirmed_at = COALESCE(confirmed_at, ?), via = COALESCE(via, ?) WHERE id = ?")
    .bind(now, c.via, event.id)
    .run();
  const routine = await db
    .prepare("SELECT r.title, s.time_zone FROM routines r LEFT JOIN settings s ON s.user_id = r.user_id WHERE r.id = ?")
    .bind(event.routine_id)
    .first<{ title: string; time_zone: string | null }>();
  await settleQuietly(db, event.routine_id, validTimeZone(routine?.time_zone));
  await logAction(db, userId, "routine_done", `Done: ${routine?.title ?? "routine"}`, source, event.routine_id);
  if (env) {
    // An urgent one is buzzing on the phone: tell it to stop (alarms.ts nags).
    await push(env, userId, { silent: true, data: { type: "nag-stop", id: crypto.randomUUID(), key: `routine:${event.routine_id}:${event.due_at}` } }).catch(() => 0);
  }
  return { eventId: event.id, routineId: event.routine_id, title: routine?.title ?? null, dueAt: event.due_at };
}

export async function snoozeRoutine(db: D1Database, userId: string, c: Omit<Confirm, "via"> & { minutes?: number }) {
  const minutes = Math.min(120, Math.max(1, Math.round(c.minutes ?? DEFAULT_SNOOZE_MIN)));
  const event = c.eventId
    ? await db.prepare("SELECT id FROM routine_events WHERE id = ? AND user_id = ?").bind(c.eventId, userId).first<{ id: string }>()
    : c.routineId && c.dueAt
      ? await db
          .prepare("SELECT id FROM routine_events WHERE routine_id = ? AND user_id = ? AND due_at = ?")
          .bind(c.routineId, userId, c.dueAt)
          .first<{ id: string }>()
      : null;
  if (!event) return null;
  await db
    .prepare("UPDATE routine_events SET status = 'snoozed', snooze_until = ? WHERE id = ? AND status IN ('pending', 'snoozed')")
    .bind(Date.now() + minutes * 60_000, event.id)
    .run();
  return { eventId: event.id, minutes };
}

// ---------- The streak ----------
//
// Days in a row with every occurrence done. Occurrences (routine_events) are
// deleted after 14 days (retention.ts), so the streak can't be counted from
// them alone: the days that are gone live on the routine row as a running
// total, `streak` days in a row ending on `streak_day`. Days after streak_day
// are counted from the events that are still there. A day is folded into the
// total once it is as old as the purge's window, when nothing can change it any
// more: as occurrences are written (settleStreak below), and by the purge itself
// just before it deletes them.

/** Days this old are settled into the routine's running streak. The purge's own window (retention.ts RETAIN_DAYS). */
export const STREAK_SETTLED_DAYS = 14;

export type StreakCarry = { streak: number; day: string | null };

/** Each local day's outcome: true when everything due that day was done. */
export function dayOutcomes(events: { due_at: number; status: string }[], timeZone: string) {
  const byDay = new Map<string, boolean>();
  for (const e of events) {
    const day = buckets(e.due_at, timeZone).day;
    byDay.set(day, (byDay.get(day) ?? true) && e.status === "done");
  }
  return byDay;
}

/**
 * The running total brought forward through `through`: each day after the
 * carry's that had something due adds one when all of it was done and starts
 * again from nothing when it wasn't. A day with nothing due doesn't break it.
 */
export function foldStreak(carry: StreakCarry, byDay: Map<string, boolean>, through: string): StreakCarry {
  if (carry.day !== null && carry.day >= through) return carry;
  const days = [...byDay.keys()].filter((d) => (carry.day === null || d > carry.day) && d <= through).sort();
  let streak = carry.streak;
  for (const d of days) streak = byDay.get(d) ? streak + 1 : 0;
  return { streak, day: through };
}

/**
 * Days in a row with every occurrence done, counting back from yesterday — and
 * today too, once today's are all in. A day with nothing due doesn't break it.
 * Days up to the carry's are the carry's; only later days are read from `byDay`.
 */
export function streakFrom(byDay: Map<string, boolean>, today: string, carry: StreakCarry = { streak: 0, day: null }) {
  const after = (d: string) => carry.day === null || d > carry.day;
  let oldest: string | null = null;
  for (const d of byDay.keys()) if (after(d) && (oldest === null || d < oldest)) oldest = d;
  let count = 0;
  let day = byDay.get(today) ? today : addDays(today, -1);
  for (let i = 0; i < 400; i++) {
    if (!after(day)) return count + carry.streak;
    const ok = byDay.get(day);
    if (ok === undefined) {
      // Nothing was due that day: skip over it, unless we've run off the end of
      // the history, where the carry (if any) takes over.
      if (oldest === null || day < oldest) return carry.day === null ? count : count + carry.streak;
    } else if (!ok) {
      return count;
    } else {
      count++;
    }
    day = addDays(day, -1);
  }
  return count;
}

export async function streak(db: D1Database, routineId: string, timeZone: string) {
  const [row, { results }] = await Promise.all([
    db.prepare("SELECT streak, streak_day FROM routines WHERE id = ?").bind(routineId).first<{ streak: number; streak_day: string | null }>(),
    db
      .prepare("SELECT due_at, status FROM routine_events WHERE routine_id = ? ORDER BY due_at DESC LIMIT 400")
      .bind(routineId)
      .all<{ due_at: number; status: string }>(),
  ]);
  return streakFrom(dayOutcomes(results, timeZone), buckets(Date.now(), timeZone).day, {
    streak: row?.streak ?? 0,
    day: row?.streak_day ?? null,
  });
}

/**
 * Folds every day up to the one `cutoff` falls in into the routine's running
 * streak, from the events still there. Called where occurrences are written
 * (which keeps it current for anything in use) and by the purge for every
 * routine whose events it is about to delete, with its own cutoff. Returns
 * whether the row moved. Cheap when there's nothing to do: one read.
 */
export async function settleStreak(db: D1Database, routineId: string, timeZone: string, cutoff = Date.now() - STREAK_SETTLED_DAYS * 86_400_000) {
  const through = buckets(cutoff, timeZone).day;
  const row = await db
    .prepare("SELECT streak, streak_day FROM routines WHERE id = ?")
    .bind(routineId)
    .first<{ streak: number; streak_day: string | null }>();
  if (!row || (row.streak_day !== null && row.streak_day >= through)) return false;
  const from = row.streak_day === null ? 0 : atLocalTime(addDays(row.streak_day, 1), 0, timeZone);
  const to = atLocalTime(addDays(through, 1), 0, timeZone);
  const { results } = await db
    .prepare("SELECT due_at, status FROM routine_events WHERE routine_id = ? AND due_at >= ? AND due_at < ?")
    .bind(routineId, from, to)
    .all<{ due_at: number; status: string }>();
  const next = foldStreak({ streak: row.streak, day: row.streak_day }, dayOutcomes(results, timeZone), through);
  // Only over the value read: two settles at once can't both add the same days.
  const { meta } = await db
    .prepare("UPDATE routines SET streak = ?, streak_day = ? WHERE id = ? AND streak_day IS ?")
    .bind(next.streak, next.day, routineId, row.streak_day)
    .run();
  return !!meta.changes;
}

/** settleStreak for a write site: never fails the write it follows. */
function settleQuietly(db: D1Database, routineId: string, timeZone: string) {
  return settleStreak(db, routineId, timeZone).catch((err) => (console.error(`routines: couldn't settle the streak of ${routineId}`, err), false));
}

// ---------- The phone's side ----------

const syncSchema = z.object({
  source: z.literal("apple_reminders"),
  /** Everything currently in the list. A routine whose reminder has gone is switched off. */
  items: z
    .array(
      z.object({
        externalId: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(120),
        times: z.array(z.number().int().min(0).max(1439)).min(1).max(12),
        days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      }),
    )
    .max(60),
});

export const routines = new Hono<{ Bindings: Env; Variables: Vars }>();

async function routinesView(db: D1Database, userId: string) {
  const timeZone = await timeZoneFor(db, userId);
  const list = await listRoutines(db, userId);
  const today = buckets(Date.now(), timeZone).day;
  const [from, to] = [atLocalTime(today, 0, timeZone), atLocalTime(addDays(today, 1), 0, timeZone)];
  const { results: events } = await db
    .prepare("SELECT id, routine_id, due_at, status FROM routine_events WHERE user_id = ? AND due_at >= ? AND due_at < ? ORDER BY due_at")
    .bind(userId, from, to)
    .all<{ id: string; routine_id: string; due_at: number; status: string }>();
  return Promise.all(
    list.map(async (r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      times: parseList(r.times),
      days: parseList(r.days),
      when: describeRoutine(r),
      buzzPattern: r.buzz_pattern,
      externalSource: r.external_source,
      externalId: r.external_id,
      nextDueAt: r.next_due_at,
      updatedAt: r.updated_at,
      streak: await streak(db, r.id, timeZone),
      today: events.filter((e) => e.routine_id === r.id).map(({ routine_id: _, ...e }) => e),
    })),
  );
}

routines.get("/routines", async (c) => c.json({ routines: await routinesView(c.env.DB, c.var.userId) }));

/**
 * The phone read the Medications list in Apple Reminders. Apple owns that
 * schedule, so what it says wins: new reminders become routines, changed ones
 * are updated, and ones that were deleted there are switched off here.
 *
 * The answer says what the phone still has to do on its side: create the
 * reminders for meds added by voice or onboarding, and tick off the ones the
 * user confirmed in OVOA.
 */
routines.post("/routines/sync", async (c) => {
  const parsed = syncSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid sync" }, 400);
  const db = c.env.DB;
  const userId = c.var.userId;
  const { source, items } = parsed.data;
  const existing = (await listRoutines(db, userId, true)).filter((r) => r.external_source === source);
  const byExternal = new Map(existing.filter((r) => r.external_id).map((r) => [r.external_id!, r]));

  for (const item of items) {
    const row = byExternal.get(item.externalId);
    const days = item.days ?? [];
    if (!row) {
      await createRoutine(db, userId, { kind: "med", title: item.title, times: item.times, days, externalSource: source, externalId: item.externalId });
    } else if (
      row.title !== item.title ||
      JSON.stringify(parseList(row.times)) !== JSON.stringify([...item.times].sort((a, b) => a - b)) ||
      JSON.stringify(parseList(row.days)) !== JSON.stringify([...days].sort()) ||
      !row.active
    ) {
      await updateRoutine(db, userId, row.id, { title: item.title, times: item.times, days, active: true });
    }
  }
  const seen = new Set(items.map((i) => i.externalId));
  for (const row of existing) {
    if (row.external_id && row.active && !seen.has(row.external_id)) {
      await updateRoutine(db, userId, row.id, { active: false });
    }
  }

  const toCreate = (await listRoutines(db, userId)).filter((r) => r.external_source === source && !r.external_id);
  const { results: toWriteBack } = await db
    .prepare(
      `SELECT e.id AS eventId, r.external_id AS externalId, e.due_at AS dueAt
         FROM routine_events e JOIN routines r ON r.id = e.routine_id
        WHERE e.user_id = ? AND e.status = 'done' AND e.written_back = 0 AND e.via != 'external'
          AND r.external_source = ? AND r.external_id IS NOT NULL AND e.due_at > ?`,
    )
    .bind(userId, source, Date.now() - 2 * 86_400_000)
    .all();
  return c.json({
    routines: await routinesView(db, userId),
    toCreate: toCreate.map((r) => ({ id: r.id, title: r.title, times: parseList(r.times), days: parseList(r.days) })),
    toWriteBack,
  });
});

/** The phone created the reminder for a routine; remember which one it is. */
routines.post("/routines/:id/external", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { externalId?: unknown } | null;
  if (typeof body?.externalId !== "string" || !body.externalId) return c.json({ error: "externalId is required" }, 400);
  const { meta } = await c.env.DB.prepare("UPDATE routines SET external_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(body.externalId, Date.now(), c.req.param("id"), c.var.userId)
    .run();
  return meta.changes ? c.json({ ok: true }) : c.json({ error: "No such routine" }, 404);
});

routines.post("/routines/written-back", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((i): i is string => typeof i === "string").slice(0, 100) : [];
  if (ids.length) {
    await c.env.DB.prepare(
      `UPDATE routine_events SET written_back = 1 WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(c.var.userId, ...ids)
      .run();
  }
  return c.json({ ok: true });
});

/** The phone scheduled its local notifications from the current routines. */
routines.post("/routines/scheduled", async (c) => {
  await c.env.DB.prepare(
    `INSERT INTO device_state (user_id, routines_synced_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET routines_synced_at = excluded.routines_synced_at`,
  )
    .bind(c.var.userId, Date.now(), Date.now())
    .run();
  return c.json({ ok: true });
});

const occurrenceSchema = z.object({
  eventId: z.string().max(64).optional(),
  dueAt: z.number().int().positive().optional(),
  via: z.enum(["notification", "voice", "app", "external"]).optional(),
  minutes: z.number().int().min(1).max(120).optional(),
});

routines.post("/routines/:id/confirm", async (c) => {
  const parsed = occurrenceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid confirmation" }, 400);
  const done = await confirmRoutine(
    c.env.DB,
    c.var.userId,
    { routineId: c.req.param("id"), eventId: parsed.data.eventId, dueAt: parsed.data.dueAt, via: parsed.data.via ?? "app" },
    "chat",
    c.env,
  );
  return done ? c.json(done) : c.json({ error: "Nothing waiting for that routine" }, 404);
});

routines.post("/routines/:id/snooze", async (c) => {
  const parsed = occurrenceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid snooze" }, 400);
  const snoozed = await snoozeRoutine(c.env.DB, c.var.userId, {
    routineId: c.req.param("id"),
    eventId: parsed.data.eventId,
    dueAt: parsed.data.dueAt,
    minutes: parsed.data.minutes,
  });
  return snoozed ? c.json(snoozed) : c.json({ error: "Nothing waiting for that routine" }, 404);
});

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "routine_add",
    description:
      "Sets up something that repeats at fixed times of day: medication, walking the dog, drinking water, stretching. OVOA reminds them at each time (a buzz on the band, or a notification), follows up if it isn't done, and keeps a streak. For medication, it also goes into their Apple Reminders 'Medications' list, which stays the real copy. Not for one-off reminders.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, in their words: 'Vitamin D', 'Walk Rex', 'Water'." },
        kind: { type: "string", enum: KINDS, description: "med for any medication or supplement; pet; habit; custom." },
        urgent: {
          type: "boolean",
          description: "Keep buzzing until they confirm. Medication is urgent unless they say otherwise; anything else only if they ask.",
        },
        times: { type: "array", items: { type: "string" }, description: "Local times as HH:MM, 24-hour." },
        days: {
          type: "array",
          items: { type: "string", enum: WEEKDAYS },
          description: "Only these weekdays. Leave out for every day.",
        },
      },
      required: ["title", "kind", "times"],
    },
  },
  {
    name: "routine_list",
    description: "Their routines and medications, when each is due, today's status and the streak. Use when they ask what's set up, or before changing one.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "routine_change",
    description: "Changes the times or days of a routine, pauses it, resumes it, or removes it. Get the id from routine_list first.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["update", "pause", "resume", "remove"] },
        times: { type: "array", items: { type: "string" }, description: "For update: the new HH:MM times." },
        days: { type: "array", items: { type: "string", enum: WEEKDAYS }, description: "For update: the new weekdays; empty for every day." },
      },
      required: ["id", "action"],
    },
  },
  {
    name: "routine_confirm",
    description:
      "Records that they did it: 'took it', 'walked the dog', 'done'. Without an id, it's the routine most recently reminded about. With snoozeMinutes it snoozes instead.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Which routine, if it isn't the most recent one." },
        snoozeMinutes: { type: "number", description: "Snooze instead of confirming, for this many minutes." },
      },
    },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isRoutineTool = (name: string) => NAMES.has(name);
const VOICE_TOOLS = new Set(["routine_add", "routine_list", "routine_confirm"]);

const toMinutes = (list: unknown) =>
  Array.isArray(list) ? list.map(parseClock).filter((m): m is number => m !== null) : [];
const toDays = (list: unknown) =>
  Array.isArray(list) ? list.map((d) => WEEKDAYS.indexOf(String(d).toLowerCase())).filter((d) => d >= 0) : [];

/**
 * Tells the phone its routines changed, so it reschedules now instead of on its
 * next sync. Only a nudge: the phone's six-hourly sync catches it regardless.
 */
export const routinesChanged = (env: Env, userId: string) =>
  push(env, userId, { silent: true, data: { type: "routines-changed", id: crypto.randomUUID() } }).catch(() => 0);

export function routinesAssistant(env: Env, userId: string, timeZone: string, opts: { voice?: boolean; fromAgent?: boolean } = {}) {
  const db = env.DB;
  const source: ActionSource = opts.fromAgent ? "agent" : "chat";

  const callTool: CallTool = async (name, args) => {
    if (name === "routine_add") {
      const title = String(args.title ?? "").trim();
      const kind = String(args.kind ?? "custom") as RoutineKind;
      const times = toMinutes(args.times);
      if (!title) return { error: "title is required" };
      if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
      if (!times.length) return { error: "times must be HH:MM, 24-hour" };
      const already = await existingRoutine(db, userId, title);
      if (already) {
        return {
          added: false,
          already: { id: already.id, title: already.title, when: describeRoutine(already) },
          note: "That routine is already set up, so nothing was added. Don't add it again: say it's already on, and when.",
        };
      }
      try {
        const id = await createRoutine(db, userId, {
          kind,
          title,
          times,
          days: toDays(args.days),
          urgent: args.urgent === undefined ? kind === "med" : !!args.urgent,
          // Medication goes into Apple Reminders as well; the phone creates it there on its next sync.
          externalSource: kind === "med" ? "apple_reminders" : null,
        });
        await routinesChanged(env, userId);
        const when = describeRoutine({ times: JSON.stringify(times), days: JSON.stringify(toDays(args.days)) });
        return {
          added: true,
          id,
          when,
          note:
            kind === "med"
              ? "Also going into their Medications list in Apple Reminders. Say so in a few words."
              : "Say when it will remind them, in a few words.",
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (name === "routine_list") {
      const list = await routinesView(db, userId);
      if (!list.length) return { routines: 0, note: "Nothing set up yet." };
      return {
        routines: list.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          when: r.when,
          streakDays: r.streak,
          today: r.today.map((e) => `${clock(e.due_at, timeZone)} ${e.status}`),
          next: r.nextDueAt ? new Date(r.nextDueAt).toLocaleString("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }) : null,
          ...(r.externalSource === "apple_reminders" && { from: "Apple Reminders" }),
        })),
      };
    }

    if (name === "routine_change") {
      const id = String(args.id ?? "");
      const action = String(args.action ?? "");
      if (action === "remove") {
        // The agent's own turns never delete; the user can, by asking.
        if (opts.fromAgent) return { error: "Removing a routine needs the user." };
        const { meta } = await db.prepare("DELETE FROM routines WHERE id = ? AND user_id = ?").bind(id, userId).run();
        if (meta.changes) await routinesChanged(env, userId);
        return meta.changes ? { removed: true } : { error: "No such routine" };
      }
      if (action === "pause" || action === "resume") {
        const ok = await updateRoutine(db, userId, id, { active: action === "resume" });
        if (ok) await routinesChanged(env, userId);
        return ok ? { status: action === "pause" ? "paused" : "active" } : { error: "No such routine" };
      }
      if (action === "update") {
        const times = args.times === undefined ? undefined : toMinutes(args.times);
        if (times && !times.length) return { error: "times must be HH:MM, 24-hour" };
        const ok = await updateRoutine(db, userId, id, { times, days: args.days === undefined ? undefined : toDays(args.days) });
        if (ok) await routinesChanged(env, userId);
        return ok ? { updated: true } : { error: "No such routine" };
      }
      return { error: "action must be update, pause, resume or remove" };
    }

    if (name === "routine_confirm") {
      const routineId = args.id ? String(args.id) : undefined;
      if (args.snoozeMinutes) {
        const pending = await db
          .prepare(
            `SELECT id FROM routine_events WHERE user_id = ? AND status IN ('pending', 'snoozed') ${routineId ? "AND routine_id = ?" : ""} ORDER BY due_at DESC LIMIT 1`,
          )
          .bind(...(routineId ? [userId, routineId] : [userId]))
          .first<{ id: string }>();
        if (!pending) return { error: "Nothing is waiting to be snoozed." };
        const s = await snoozeRoutine(db, userId, { eventId: pending.id, minutes: Number(args.snoozeMinutes) });
        return s ? { snoozed: true, minutes: s.minutes } : { error: "Couldn't snooze it." };
      }
      const done = await confirmRoutine(db, userId, { routineId, via: "voice" }, source, env);
      return done ? { confirmed: done.title } : { error: "Nothing is waiting to be confirmed right now." };
    }

    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: opts.voice ? TOOLS.filter((t) => VOICE_TOOLS.has(t.name)) : TOOLS,
    callTool,
    prompt: [
      "Routines are things at fixed times every day or on certain weekdays — medication, the dog, water. Set them up with routine_add; OVOA reminds them, follows up, and keeps a streak. A one-off reminder is a phone reminder, not a routine.",
      "'Hold me accountable to…', 'every day', 'daily', 'once a day' is a routine, never reminder_set (that is one time only). If they didn't say when, ask what time, then routine_add with it.",
      "When they say they did it ('took it', 'done', 'walked him'), call routine_confirm.",
      "Medication schedules belong to their Apple Reminders 'Medications' list; OVOA mirrors it. Never tell them OVOA is the only place a medication is kept.",
    ].join("\n"),
  };
}
