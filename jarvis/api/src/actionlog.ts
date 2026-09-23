import { dayRange } from "./time";

// The record of what OVOA did, as opposed to what it said. See
// migrations/0013_action_log.sql.
//
// Writing a row never fails the thing it records: an assistant that sent the
// email and then reported an error because the log was busy is worse than one
// with a gap in its log.

export type ActionSource = "chat" | "agent" | "system" | "approval";

/**
 * Roughly how long each kind of thing would have taken by hand, in minutes.
 * Deliberately conservative — shown as "~estimated", and an assistant that
 * claims to have saved you an hour a day stops being believed on day two.
 */
export const MINUTES_SAVED: Record<string, number> = {
  email_draft: 3,
  email_send: 2,
  event: 1,
  event_change: 1,
  reminder: 0.5,
  task: 0.5,
  note: 0.5,
  contact: 1,
  text: 1,
  doc: 2,
  sheet: 1,
  job: 1,
  todo_list: 3,
  routine_done: 0.5,
  routine_fired: 0,
  workout_log: 2,
  favor_caught: 2,
  food: 0.5,
  agent_run: 0,
  command: 0,
  buzz: 0,
};

/**
 * Tools that change something, and what kind of action each one is. Lookups are
 * left out: reading the calendar isn't a thing done *for* someone, and logging
 * every search would drown the feed.
 */
const TOOL_KINDS: Record<string, string> = {
  gmail_send: "email_send",
  gmail_create_draft: "email_draft",
  calendar_create_event: "event",
  calendar_update_event: "event_change",
  phone_calendar_create_event: "event",
  phone_calendar_update_event: "event_change",
  phone_reminder_create: "reminder",
  phone_reminder_complete: "task",
  tasks_add: "reminder",
  tasks_complete: "task",
  phone_contact_create: "contact",
  phone_contact_update: "contact",
  phone_message_compose: "text",
  phone_email_compose: "email_draft",
  docs_create: "doc",
  docs_append: "doc",
  sheets_create: "sheet",
  sheets_append: "sheet",
  sheets_update: "sheet",
  agent_schedule: "job",
  note_add: "note",
  routine_add: "reminder",
  routine_confirm: "routine_done",
  todo_done: "task",
  food_log: "food",
  food_amend: "food",
};

export const kindForTool = (name: string): string | null => TOOL_KINDS[name] ?? null;

/**
 * Whether a tool result means the thing actually happened. Parked actions come
 * back as waiting for approval, and those are logged when they are approved, not
 * when they were proposed.
 */
export function toolSucceeded(result: unknown) {
  if (!result || typeof result !== "object") return result !== undefined && result !== null;
  const r = result as Record<string, unknown>;
  if ("error" in r) return false;
  return r.status !== "waiting_for_user_approval" && r.status !== "running_on_phone";
}

export async function logAction(
  db: D1Database,
  userId: string,
  kind: string,
  summary: string,
  source: ActionSource,
  refId?: string | null,
) {
  try {
    await db
      .prepare(
        "INSERT INTO action_log (id, user_id, ts, kind, summary, source, ref_id, minutes_saved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), userId, Date.now(), kind, summary.slice(0, 300), source, refId ?? null, MINUTES_SAVED[kind] ?? 0)
      .run();
  } catch (err) {
    console.error("action log: couldn't write", kind, err);
  }
}

/** A tool call, in words: "calendar_create_event: Dentist" is enough for a feed line. */
export function describeToolCall(name: string, args: Record<string, unknown>) {
  // food_log's items have the names: "food log: oatmeal, coffee".
  const items = Array.isArray(args.items)
    ? args.items.map((i) => (i && typeof i === "object" ? (i as Record<string, unknown>).name : null)).filter((n) => typeof n === "string").join(", ")
    : undefined;
  const what = [args.title, args.subject, args.name, args.text, args.to, items, args.which]
    .find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const label = name.replace(/^(phone|agent)_/, "").replace(/_/g, " ");
  return what ? `${label}: ${what.trim().slice(0, 120)}` : label;
}

export type ActionRow = {
  id: string;
  ts: number;
  kind: string;
  summary: string;
  source: ActionSource;
  ref_id: string | null;
  minutes_saved: number;
};

export async function getActions(db: D1Database, userId: string, from: number, to: number, limit = 200) {
  const { results } = await db
    .prepare(
      "SELECT id, ts, kind, summary, source, ref_id, minutes_saved FROM action_log WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?",
    )
    .bind(userId, from, to, limit)
    .all<ActionRow>();
  return results;
}

/** One local day, counted: how many of each kind, and the estimated minutes. */
export async function dailyRollup(db: D1Database, userId: string, day: string, timeZone: string) {
  const [from, to] = dayRange(day, timeZone);
  const { results } = await db
    .prepare(
      "SELECT kind, COUNT(*) AS n, SUM(minutes_saved) AS minutes FROM action_log WHERE user_id = ? AND ts >= ? AND ts < ? GROUP BY kind",
    )
    .bind(userId, from, to)
    .all<{ kind: string; n: number; minutes: number | null }>();
  const counts: Record<string, number> = {};
  let minutesSaved = 0;
  for (const r of results) {
    counts[r.kind] = r.n;
    minutesSaved += r.minutes ?? 0;
  }
  return { day, counts, minutesSaved: Math.round(minutesSaved * 10) / 10 };
}
