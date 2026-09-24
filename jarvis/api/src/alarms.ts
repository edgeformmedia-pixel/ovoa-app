import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import { resolveDue } from "./context";
import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { addNote } from "./notes";
import { push } from "./push";
import { confirmRoutine, nextOccurrence, parseClock } from "./routines";
import { buckets, clock, clockFromMinutes } from "./time";
import type { Env, Vars } from "./types";

// Alarms, reminders, and nagging. See migrations/0026_alarms.sql.
//
// The phone does the real work — it keeps itself awake overnight for an alarm,
// buzzes the band every 30 seconds and talks — because only it can reach the
// band and the speaker. The server fires the moment (a silent push the phone
// acts on) and then keeps pushing a visible notification every two minutes
// until it hears it's done, for when the phone was asleep or killed.

/** Backstop pushes while something is still going off. */
const NAG_EVERY_MS = 2 * 60_000;
/** An alarm nobody stopped gives up after this long; a reminder after this. */
const ALARM_GIVE_UP_MS = 60 * 60_000;
const REMINDER_GIVE_UP_MS = 3 * 60 * 60_000;
/** Steps a hard alarm wants before it stops. */
export const HARD_ALARM_STEPS = 20;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

type AlarmRow = {
  id: string;
  user_id: string;
  time_minutes: number;
  days: string;
  label: string | null;
  hard: number;
  active: number;
  next_at: number | null;
  ringing_at: number | null;
  stopped_at: number | null;
  nagged_at: number | null;
};

async function tzOf(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  return validTimeZone(row?.time_zone);
}

const daysOf = (json: string) => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as number[]) : [];
  } catch {
    return [];
  }
};

/** Tells the phone to stop whatever is going off for `key` (an alarm id, a note id, a routine occurrence). */
export const stopNag = (env: Env, userId: string, key: string) =>
  push(env, userId, { silent: true, data: { type: "nag-stop", id: crypto.randomUUID(), key } }).catch(() => 0);

async function firstName(db: D1Database, userId: string) {
  const u = await db.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>();
  return (u?.name ?? "").split(" ")[0] || "there";
}

// ---------- Alarms ----------

export async function setAlarm(db: D1Database, userId: string, a: { minutes: number; days: number[]; label?: string | null; hard: boolean; on?: string | null }) {
  const timeZone = await tzOf(db, userId);
  // Asked twice for the same alarm ("wake me at 10:30" … "set an alarm for 10:30"):
  // one alarm, not two that both have to be stopped.
  const same = await db
    .prepare("SELECT id, next_at FROM alarms WHERE user_id = ? AND active = 1 AND time_minutes = ? AND days = ? LIMIT 1")
    .bind(userId, a.minutes, JSON.stringify(a.days))
    .first<{ id: string; next_at: number | null }>();
  if (same) {
    await db.prepare("UPDATE alarms SET hard = MAX(hard, ?), label = COALESCE(?, label) WHERE id = ?").bind(Number(a.hard), a.label ?? null, same.id).run();
    return { id: same.id, next: same.next_at, timeZone };
  }
  // A one-off on a given date: the next occurrence on or after that day.
  const from = a.on ? Math.max(Date.now(), resolveDue(`${a.on}T00:00`, timeZone) ?? Date.now()) - 1 : Date.now();
  const next = nextOccurrence([a.minutes], a.days, from, timeZone);
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO alarms (id, user_id, time_minutes, days, label, hard, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userId, a.minutes, JSON.stringify(a.days), a.label ?? null, Number(a.hard), next, Date.now())
    .run();
  return { id, next, timeZone };
}

export async function listAlarms(db: D1Database, userId: string) {
  const { results } = await db
    // Plus a one-off that's going off right now: it's no longer active, but a phone
    // that slept through it has to be able to find it, go off, and stop it.
    .prepare(
      `SELECT * FROM alarms WHERE user_id = ? AND (active = 1 OR ringing_at > ?)
        ORDER BY next_at`,
    )
    .bind(userId, Date.now() - ALARM_GIVE_UP_MS)
    .all<AlarmRow>();
  return results;
}

/** Stops a ringing alarm. A hard alarm only stops for the steps. */
export async function stopAlarm(env: Env, userId: string, opts: { id?: string; steps?: number }) {
  const db = env.DB;
  const alarm = opts.id
    ? await db.prepare("SELECT * FROM alarms WHERE id = ? AND user_id = ?").bind(opts.id, userId).first<AlarmRow>()
    : await db
        .prepare("SELECT * FROM alarms WHERE user_id = ? AND ringing_at IS NOT NULL AND stopped_at IS NULL ORDER BY ringing_at DESC LIMIT 1")
        .bind(userId)
        .first<AlarmRow>();
  if (!alarm || !alarm.ringing_at || alarm.stopped_at) return { error: "No alarm is going off." };
  if (alarm.hard && (opts.steps ?? 0) < HARD_ALARM_STEPS) {
    return { error: `It's a hard alarm: it stops after ${HARD_ALARM_STEPS} steps, not by asking. Get up and walk.` };
  }
  // "I'm awake" means awake: every ordinary alarm still going off stops, not
  // only the newest (two set for the same time kept one nagging, 2026-09-21).
  const { results: ringing } = await db
    .prepare("SELECT id FROM alarms WHERE user_id = ? AND ringing_at IS NOT NULL AND stopped_at IS NULL AND (hard = 0 OR id = ?)")
    .bind(userId, alarm.id)
    .all<{ id: string }>();
  for (const r of ringing) {
    await db.prepare("UPDATE alarms SET stopped_at = ? WHERE id = ?").bind(Date.now(), r.id).run();
    await stopNag(env, userId, `alarm:${r.id}`);
  }
  await logAction(db, userId, "alarm", `Alarm stopped${alarm.hard ? ` after ${opts.steps} steps` : ""}`, "chat", alarm.id);
  return { stopped: true };
}

// ---------- Reminders ----------

/** "Remind me to X at Y": an OVOA reminder, which buzzes the band (not an Apple Reminder). */
/** How close in time two reminders about the same thing have to be to be one reminder (sameReminder). */
const SAME_REMINDER_MS = 20 * 60_000;

/** Words that say nothing about what a reminder is for: "Water check" and "Gym check" are two things. */
const REMINDER_FILLER = new Set([
  "check", "reminder", "remind", "time", "today", "tonight", "tomorrow", "morning", "evening", "night",
  "keep", "going", "have", "your", "you", "about", "this", "that", "with", "from", "done", "make", "sure",
  "dont", "forget", "yet", "now", "did", "get", "go", "the", "and", "for",
]);

const reminderWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[‘’']/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !REMINDER_FILLER.has(w)),
  );

/**
 * Whether two reminders are the same one: set for within SAME_REMINDER_MS of
 * each other, about the same thing (a word that says what for, in both).
 * "Hey OVOA" on its own was answered by setting the water check at 10 AM a
 * second time, three turns after the first (action_log, 2026-09-24). Pure.
 */
export function sameReminder(a: { text: string; at: number }, b: { text: string; at: number }) {
  if (Math.abs(a.at - b.at) > SAME_REMINDER_MS) return false;
  const words = reminderWords(b.text);
  return [...reminderWords(a.text)].some((w) => words.has(w));
}

/** A reminder still to come that `text` at `at` would repeat (sameReminder), if there is one. */
async function existingReminder(db: D1Database, userId: string, text: string, at: number) {
  const { results } = await db
    .prepare(
      `SELECT text, remind_at FROM notes WHERE user_id = ? AND done = 0 AND reminded_at IS NULL AND remind_at BETWEEN ? AND ?`,
    )
    .bind(userId, at - SAME_REMINDER_MS, at + SAME_REMINDER_MS)
    .all<{ text: string; remind_at: number }>();
  return results.find((r) => sameReminder({ text: r.text, at: r.remind_at }, { text, at })) ?? null;
}

export async function setReminder(db: D1Database, userId: string, text: string, at: number, urgent: boolean) {
  const id = await addNote(db, userId, { text, tags: ["reminder"], remindAt: at });
  if (urgent) await db.prepare("UPDATE notes SET urgent = 1 WHERE id = ?").bind(id).run();
  return id;
}

/**
 * "I did it" / "I took my pill": whatever is nagging right now — an urgent
 * reminder or an urgent routine — stops. Returns what it stopped.
 */
export async function doneWithNag(env: Env, userId: string, hint?: string) {
  const db = env.DB;
  const since = Date.now() - REMINDER_GIVE_UP_MS;
  const [note, routine] = await Promise.all([
    db
      .prepare(
        `SELECT id, text FROM notes WHERE user_id = ? AND urgent = 1 AND done = 0 AND reminded_at IS NOT NULL AND reminded_at > ?
          ${hint ? "AND lower(text) LIKE ?" : ""} ORDER BY reminded_at DESC LIMIT 1`,
      )
      .bind(...(hint ? [userId, since, `%${hint.toLowerCase()}%`] : [userId, since]))
      .first<{ id: string; text: string }>(),
    db
      .prepare(
        `SELECT e.id, e.routine_id, e.due_at, r.title FROM routine_events e JOIN routines r ON r.id = e.routine_id
          WHERE e.user_id = ? AND e.status IN ('pending', 'snoozed') AND r.urgent = 1 AND e.due_at > ?
          ${hint ? "AND lower(r.title) LIKE ?" : ""} ORDER BY e.due_at DESC LIMIT 1`,
      )
      .bind(...(hint ? [userId, since, `%${hint.toLowerCase()}%`] : [userId, since]))
      .first<{ id: string; routine_id: string; due_at: number; title: string }>(),
  ]);
  const stopped: string[] = [];
  if (routine) {
    await confirmRoutine(db, userId, { eventId: routine.id, via: "voice" });
    await stopNag(env, userId, `routine:${routine.routine_id}:${routine.due_at}`);
    stopped.push(routine.title);
  }
  if (note) {
    await db.prepare("UPDATE notes SET done = 1 WHERE id = ?").bind(note.id).run();
    await stopNag(env, userId, `note:${note.id}`);
    await logAction(db, userId, "task", `Done: ${note.text.slice(0, 100)}`, "chat", note.id);
    stopped.push(note.text);
  }
  return stopped;
}

// ---------- The tick ----------

/**
 * Every two minutes: fire alarms that are due, and keep pushing anything still
 * going off — ringing alarms, urgent reminders and urgent routines — until it's
 * stopped or it's clearly been missed.
 */
export async function nagTick(env: Env) {
  const db = env.DB;
  const now = Date.now();
  let fired = 0;
  let nagged = 0;

  // Alarms that are due.
  const { results: due } = await db
    .prepare(
      `SELECT a.*, s.time_zone FROM alarms a JOIN settings s ON s.user_id = a.user_id
        WHERE a.active = 1 AND a.next_at IS NOT NULL AND a.next_at <= ? LIMIT 50`,
    )
    .bind(now)
    .all<AlarmRow & { time_zone: string | null }>();
  for (const a of due) {
    const timeZone = validTimeZone(a.time_zone);
    const days = daysOf(a.days);
    const next = days.length ? nextOccurrence([a.time_minutes], days, a.next_at! + 60_000, timeZone) : null;
    const claim = await db
      .prepare("UPDATE alarms SET next_at = ?, active = ?, ringing_at = ?, stopped_at = NULL, nagged_at = ? WHERE id = ? AND next_at = ?")
      .bind(next, next ? 1 : 0, a.next_at, now, a.id, a.next_at)
      .run();
    if (!claim.meta.changes) continue;
    // Too late to be worth waking anyone (the cron was down).
    if (now - a.next_at! > 30 * 60_000) continue;
    const name = await firstName(db, a.user_id);
    await push(env, a.user_id, {
      silent: true,
      data: { type: "alarm", id: crypto.randomUUID(), key: `alarm:${a.id}`, alarmId: a.id, hard: !!a.hard, label: a.label, name },
    });
    await push(env, a.user_id, {
      title: a.hard ? "Wake up — 20 steps to stop" : "Wake up",
      body: `Morning ${name}. ${a.label ?? `It's ${clock(now, timeZone)}.`}`,
      urgent: true,
      data: { type: "alarm", alarmId: a.id, hard: !!a.hard },
    });
    await logAction(db, a.user_id, "alarm", `Alarm went off${a.hard ? " (hard)" : ""}`, "system", a.id);
    fired++;
  }

  // Alarms still going off.
  const { results: ringing } = await db
    .prepare(
      "SELECT * FROM alarms WHERE ringing_at IS NOT NULL AND stopped_at IS NULL AND ringing_at > ? AND (nagged_at IS NULL OR nagged_at < ?) LIMIT 50",
    )
    .bind(now - ALARM_GIVE_UP_MS, now - NAG_EVERY_MS)
    .all<AlarmRow>();
  for (const a of ringing) {
    await db.prepare("UPDATE alarms SET nagged_at = ? WHERE id = ?").bind(now, a.id).run();
    const name = await firstName(db, a.user_id);
    await push(env, a.user_id, { silent: true, data: { type: "alarm", id: crypto.randomUUID(), key: `alarm:${a.id}`, alarmId: a.id, hard: !!a.hard, label: a.label, name } });
    await push(env, a.user_id, {
      title: a.hard ? `Still ${HARD_ALARM_STEPS} steps to go` : "Wake up",
      body: `Morning ${name}, wake up.`,
      urgent: true,
      data: { type: "alarm", alarmId: a.id, hard: !!a.hard },
    });
    nagged++;
  }

  // Urgent reminders that fired and aren't done.
  const { results: notes } = await db
    .prepare(
      `SELECT id, user_id, text FROM notes WHERE urgent = 1 AND done = 0 AND reminded_at IS NOT NULL AND reminded_at > ?
         AND (nagged_at IS NULL OR nagged_at < ?) LIMIT 50`,
    )
    .bind(now - REMINDER_GIVE_UP_MS, now - NAG_EVERY_MS)
    .all<{ id: string; user_id: string; text: string }>();
  for (const n of notes) {
    await db.prepare("UPDATE notes SET nagged_at = ? WHERE id = ?").bind(now, n.id).run();
    await push(env, n.user_id, { silent: true, data: { type: "nag", id: crypto.randomUUID(), key: `note:${n.id}`, label: n.text.slice(0, 120) } });
    await push(env, n.user_id, { title: "Still waiting", body: `${n.text.slice(0, 150)} — say "I did it" when it's done.`, urgent: true, data: { type: "note", noteId: n.id } });
    nagged++;
  }

  // Urgent routines (pills) still pending.
  const { results: events } = await db
    .prepare(
      `SELECT e.id, e.user_id, e.routine_id, e.due_at, r.title FROM routine_events e JOIN routines r ON r.id = e.routine_id
        WHERE r.urgent = 1 AND e.status IN ('pending', 'snoozed') AND e.due_at > ? AND (e.snooze_until IS NULL OR e.snooze_until < ?)
          AND (e.nagged_at IS NULL OR e.nagged_at < ?) LIMIT 50`,
    )
    .bind(now - REMINDER_GIVE_UP_MS, now, now - NAG_EVERY_MS)
    .all<{ id: string; user_id: string; routine_id: string; due_at: number; title: string }>();
  for (const e of events) {
    await db.prepare("UPDATE routine_events SET nagged_at = ? WHERE id = ?").bind(now, e.id).run();
    await push(env, e.user_id, {
      silent: true,
      data: { type: "nag", id: crypto.randomUUID(), key: `routine:${e.routine_id}:${e.due_at}`, label: e.title, routineId: e.routine_id, dueAt: e.due_at },
    });
    await push(env, e.user_id, {
      title: e.title,
      body: `Still waiting — say "I took it" when you have.`,
      urgent: true,
      data: { type: "routine", routineId: e.routine_id, eventId: e.id, dueAt: e.due_at },
      categoryId: "routine",
    });
    nagged++;
  }
  return { fired, nagged };
}

// ---------- Routes ----------

export const alarms = new Hono<{ Bindings: Env; Variables: Vars }>();

alarms.get("/alarms", async (c) => {
  const timeZone = await tzOf(c.env.DB, c.var.userId);
  const list = await listAlarms(c.env.DB, c.var.userId);
  return c.json({
    alarms: list.map((a) => ({
      id: a.id,
      at: clockFromMinutes(a.time_minutes),
      minutes: a.time_minutes,
      days: daysOf(a.days),
      label: a.label,
      hard: !!a.hard,
      nextAt: a.next_at,
      next: a.next_at ? `${buckets(a.next_at, timeZone).day} ${clock(a.next_at, timeZone)}` : null,
      ringing: !!a.ringing_at && !a.stopped_at,
      // Stopped since it last went off (by voice, say): the phone stops too.
      stopped: !!a.ringing_at && !!a.stopped_at && a.stopped_at >= a.ringing_at,
    })),
  });
});

alarms.post("/alarms", async (c) => {
  const parsed = z
    .object({ time: z.string(), days: z.array(z.number().int().min(0).max(6)).max(7).optional(), label: z.string().max(80).optional(), hard: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => null));
  const minutes = parsed.success ? parseClock(parsed.data.time) : null;
  if (!parsed.success || minutes === null) return c.json({ error: "time must be HH:MM" }, 400);
  const made = await setAlarm(c.env.DB, c.var.userId, { minutes, days: parsed.data.days ?? [], label: parsed.data.label ?? null, hard: !!parsed.data.hard });
  return c.json({ id: made.id, nextAt: made.next }, 201);
});

alarms.delete("/alarms/:id", async (c) => {
  await c.env.DB.prepare("UPDATE alarms SET active = 0, stopped_at = COALESCE(stopped_at, ?) WHERE id = ? AND user_id = ?")
    .bind(Date.now(), c.req.param("id"), c.var.userId)
    .run();
  return c.json({ ok: true });
});

/** From the phone: "I'm awake" tapped, or the steps counted for a hard alarm. */
alarms.post("/alarms/:id/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { steps?: number };
  const result = await stopAlarm(c.env, c.var.userId, { id: c.req.param("id"), steps: Number(body.steps) || 0 });
  return "error" in result ? c.json(result, 409) : c.json(result);
});

/** From the phone: the Done button on an urgent reminder. */
alarms.post("/nags/done", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string };
  const key = String(body.key ?? "");
  if (key.startsWith("note:")) {
    await c.env.DB.prepare("UPDATE notes SET done = 1 WHERE id = ? AND user_id = ?").bind(key.slice(5), c.var.userId).run();
  } else if (key.startsWith("routine:")) {
    const [, routineId, dueAt] = key.split(":");
    await confirmRoutine(c.env.DB, c.var.userId, { routineId, dueAt: Number(dueAt), via: "app" });
  }
  await stopNag(c.env, c.var.userId, key);
  return c.json({ ok: true });
});

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "alarm_set",
    // Short on purpose: a spoken turn carries it before every reply (toolbelt.ts SPOKEN_CORE).
    description:
      "Sets an alarm that buzzes the band and talks until they're up. hard: it won't stop until they've walked 20 steps ('hard alarm', 'make sure I get up').",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "HH:MM, 24-hour, local." },
        days: { type: "array", items: { type: "string", enum: WEEKDAYS }, description: "Repeats; leave out for once." },
        date: { type: "string", description: "YYYY-MM-DD, a one-off on a later day." },
        hard: { type: "boolean" },
        label: { type: "string", description: "What it's for ('flight')." },
      },
      required: ["time"],
    },
  },
  {
    name: "alarm_list",
    description: "Their alarms and when each next goes off.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "alarm_cancel",
    description: "Turns an alarm off for good. Get the id from alarm_list.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "alarm_stop",
    description: "Stops the alarm going off right now: 'I'm awake', 'stop the alarm', 'I'm up'. A hard alarm refuses: it stops after 20 steps.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "reminder_set",
    description:
      "'Remind me to X at Y': buzzes the band (or the phone) once, at that time, and shows the words. urgent: keeps buzzing every 30 s until they say it's done — pills, 'make sure I', 'don't let me forget'. Use this unless they name the Reminders app. One time only: anything every day is routine_add.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind them of, in their words." },
        at: { type: "string", description: "Local YYYY-MM-DDTHH:MM." },
        urgent: { type: "boolean" },
      },
      required: ["text", "at"],
    },
  },
  {
    name: "reminder_done",
    description:
      "Stops an urgent reminder or medication that's nagging: 'I took my pill', 'I did it', 'done, stop buzzing'. hint: a word from it (pill, water) when there could be more than one.",
    parameters: { type: "object", properties: { hint: { type: "string" } } },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isAlarmTool = (name: string) => NAMES.has(name);

export function alarmAssistant(env: Env, userId: string, timeZone: string, { voice = false } = {}) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    if (name === "alarm_set") {
      const minutes = parseClock(args.time);
      if (minutes === null) return { error: "time must be HH:MM, 24-hour" };
      const days = Array.isArray(args.days) ? args.days.map((d) => WEEKDAYS.indexOf(String(d).toLowerCase())).filter((d) => d >= 0) : [];
      const date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null;
      const made = await setAlarm(db, userId, { minutes, days, label: args.label ? String(args.label).slice(0, 80) : null, hard: !!args.hard, on: date });
      await push(env, userId, { silent: true, data: { type: "alarms-changed", id: crypto.randomUUID() } }).catch(() => 0);
      await logAction(db, userId, "alarm", `Alarm set for ${clockFromMinutes(minutes)}${args.hard ? " (hard)" : ""}`, "chat", made.id);
      return {
        set: true,
        when: made.next ? `${new Date(made.next).toLocaleDateString("en-US", { timeZone, weekday: "long" })} at ${clock(made.next, timeZone)}` : clockFromMinutes(minutes),
        ...(args.hard ? { note: `Hard alarm: it won't stop until ${HARD_ALARM_STEPS} steps. Say so.` } : {}),
      };
    }
    if (name === "alarm_list") {
      const list = await listAlarms(db, userId);
      return list.length
        ? { alarms: list.map((a) => ({ id: a.id, at: clockFromMinutes(a.time_minutes), repeats: daysOf(a.days).map((d) => WEEKDAYS[d]), hard: !!a.hard, label: a.label })) }
        : { alarms: 0 };
    }
    if (name === "alarm_cancel") {
      const { meta } = await db.prepare("UPDATE alarms SET active = 0 WHERE id = ? AND user_id = ?").bind(String(args.id ?? ""), userId).run();
      if (meta.changes) await push(env, userId, { silent: true, data: { type: "alarms-changed", id: crypto.randomUUID() } }).catch(() => 0);
      return meta.changes ? { cancelled: true } : { error: "No such alarm" };
    }
    if (name === "alarm_stop") return stopAlarm(env, userId, {});
    if (name === "reminder_set") {
      const text = String(args.text ?? "").trim();
      const at = resolveDue(String(args.at ?? ""), timeZone);
      if (!text) return { error: "text is required" };
      if (!at || at < Date.now() - 60_000) return { error: "at must be a future local YYYY-MM-DDTHH:MM" };
      const already = await existingReminder(db, userId, text, at);
      if (already) {
        return {
          set: false,
          already: `"${already.text}" ${new Date(already.remind_at).toLocaleDateString("en-US", { timeZone, weekday: "long" })} at ${clock(already.remind_at, timeZone)}`,
          note: "That reminder is already set, so nothing new was added. Don't set it again; say it's already on.",
        };
      }
      await setReminder(db, userId, text, at, !!args.urgent);
      await logAction(db, userId, "reminder", `Reminder: ${text.slice(0, 100)}`, "chat");
      return {
        set: true,
        when: `${new Date(at).toLocaleDateString("en-US", { timeZone, weekday: "long" })} at ${clock(at, timeZone)}`,
        note: args.urgent ? "Urgent: it will keep buzzing until they say it's done. Say so in a few words." : "It buzzes the band when it's time.",
      };
    }
    if (name === "reminder_done") {
      const stopped = await doneWithNag(env, userId, args.hint ? String(args.hint) : undefined);
      return stopped.length ? { stopped } : { error: "Nothing is nagging right now." };
    }
    return { error: `Unknown tool ${name}` };
  };
  // "Remind me" is OVOA's own reminder, which buzzes the band: that was the
  // decision when reminders that nag were built (2026-09-21), and the band is
  // the point. The phone section and the spoken core had drifted to the iPhone's
  // Reminders, so a spoken "remind me at four" could go either way; all three
  // now say reminder_set, and the Reminders app is used when it's named
  // (2026-09-23). "I'm awake" and "I took it" name no tool, and the app promises
  // that saying them stops a buzzing alarm or urgent reminder as well as tapping
  // does (NagOverlay), so the prompt names alarm_stop and reminder_done.
  return {
    tools: TOOLS,
    callTool,
    prompt: voice
      ? "Alarms and reminders are OVOA's own and buzz the band: 'wake me up at…' is alarm_set; 'remind me to… at…' is reminder_set, for one time only; anything every day ('hold me accountable to…', 'daily') is routine_add; 'I'm awake' / 'I'm up' is alarm_stop; 'I took it' / 'I did it' is reminder_done (ask more_tools for them if you don't have them). Use the phone's Reminders only when they name the Reminders app."
      : "Alarms and reminders are OVOA's own and buzz the band: 'wake me up at…' is alarm_set; 'remind me to… at…' is reminder_set (urgent for pills or 'make sure'), for one time only; anything every day ('hold me accountable to…', 'daily') is routine_add; 'I'm awake' is alarm_stop; 'I took it' / 'I did it' is reminder_done. Use the phone's Reminders (phone_reminder_create) only when they name the Reminders app.",
  };
}
