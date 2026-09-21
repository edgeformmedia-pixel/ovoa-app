import { Hono } from "hono";
import { dailyRollup, getActions } from "./actionlog";
import { validTimeZone } from "./google/assistant";
import { listRoutines, streak } from "./routines";
import { addDays, buckets, clock, dayRange } from "./time";
import { listTodos } from "./todos";
import type { Env, Vars } from "./types";

// The home screen: what OVOA did, what's due, what slipped.
//
// Built entirely from rows that already exist — the action log, routines and
// their occurrences, the day's list — so it shows whatever ran, with or without
// a band, Google or a watch. Minutes saved are an estimate and are labelled so
// on the phone; they are never presented as measured.

type Card =
  | { kind: "summary"; title: string; body: string; minutesSaved: number; counts: Record<string, number> }
  | { kind: "todos"; title: string; date: string; items: { id: string; text: string; done: boolean }[] }
  | {
      kind: "routines";
      title: string;
      items: { id: string; title: string; at: string; dueAt: number; status: string; streak: number }[];
    }
  | { kind: "streak"; title: string; body: string; routineId: string }
  | { kind: "missed"; title: string; body: string; routineId: string }
  | { kind: "agent"; title: string; items: { at: string; text: string }[] }
  | { kind: "week"; title: string; body: string; minutesSaved: number }
  | { kind: "workout"; title: string; body: string; workoutId: string }
  | { kind: "favor"; title: string; body: string; commitmentId: string; unsure: boolean }
  | { kind: "activity"; title: string; items: { at: string; text: string; source: string }[] };

/** What a count means, in words, for the summary line. */
const DONE_KINDS: Record<string, [string, string]> = {
  email_send: ["email sent", "emails sent"],
  email_draft: ["draft written", "drafts written"],
  event: ["event added", "events added"],
  reminder: ["reminder set", "reminders set"],
  task: ["task ticked off", "tasks ticked off"],
  note: ["note kept", "notes kept"],
  text: ["text written", "texts written"],
  routine_done: ["routine done", "routines done"],
  todo_list: ["list built", "lists built"],
};

const WORKOUT_WORDS: Record<string, string> = { strength: "Strength", run_walk: "Run or walk", cardio: "Cardio" };

/** Routine streaks worth a card of their own. */
const STREAK_CARD_DAYS = 3;

export async function buildFeed(db: D1Database, userId: string, timeZone: string): Promise<Card[]> {
  const now = Date.now();
  const today = buckets(now, timeZone).day;
  const [todayStart, todayEnd] = dayRange(today, timeZone);
  const weekStart = dayRange(addDays(today, -6), timeZone)[0];

  const [rollup, recent, todos, routines, events, week, workouts, favors] = await Promise.all([
    dailyRollup(db, userId, today, timeZone),
    getActions(db, userId, now - 86_400_000, now + 1, 60),
    listTodos(db, userId, today),
    listRoutines(db, userId),
    db
      .prepare(
        `SELECT e.id, e.routine_id, e.due_at, e.status, r.title FROM routine_events e JOIN routines r ON r.id = e.routine_id
          WHERE e.user_id = ? AND e.due_at >= ? AND e.due_at < ? ORDER BY e.due_at`,
      )
      .bind(userId, now - 86_400_000, todayEnd)
      .all<{ id: string; routine_id: string; due_at: number; status: string; title: string }>(),
    db
      .prepare("SELECT SUM(minutes_saved) AS minutes, COUNT(*) AS n FROM action_log WHERE user_id = ? AND ts >= ?")
      .bind(userId, weekStart)
      .first<{ minutes: number | null; n: number }>(),
    db
      .prepare("SELECT id, start_at, end_at, kind, confirmed_kind, summary FROM workouts WHERE user_id = ? AND start_at >= ? ORDER BY start_at DESC LIMIT 3")
      .bind(userId, now - 86_400_000)
      .all<{ id: string; start_at: number; end_at: number; kind: string; confirmed_kind: string | null; summary: string | null }>(),
    db
      .prepare(
        `SELECT id, text, who, quote, confidence FROM context_commitments
          WHERE user_id = ? AND origin = 'favor' AND status = 'open' AND created_at > ? ORDER BY created_at DESC LIMIT 5`,
      )
      .bind(userId, now - 3 * 86_400_000)
      .all<{ id: string; text: string; who: string | null; quote: string | null; confidence: number | null }>(),
  ]);

  const cards: Card[] = [];

  const done = Object.entries(DONE_KINDS)
    .filter(([kind]) => rollup.counts[kind])
    .map(([kind, [one, many]]) => `${rollup.counts[kind]} ${rollup.counts[kind] === 1 ? one : many}`);
  cards.push({
    kind: "summary",
    title: "Today",
    body: done.length ? done.join(" · ") : "Nothing done for you yet today.",
    minutesSaved: rollup.minutesSaved,
    counts: rollup.counts,
  });

  if (todos.length) {
    cards.push({
      kind: "todos",
      title: "Today's list",
      date: today,
      items: todos.map((t) => ({ id: t.id, text: t.text, done: !!t.done })),
    });
  }

  const streaks = new Map(await Promise.all(routines.map(async (r) => [r.id, await streak(db, r.id, timeZone)] as const)));
  const todaysEvents = events.results.filter((e) => e.due_at >= todayStart);
  const upcoming = routines
    .filter((r) => r.next_due_at && r.next_due_at < todayEnd && !todaysEvents.some((e) => e.routine_id === r.id && e.due_at === r.next_due_at))
    .map((r) => ({ id: r.id, title: r.title, at: clock(r.next_due_at!, timeZone), dueAt: r.next_due_at!, status: "upcoming", streak: streaks.get(r.id) ?? 0 }));
  const routineItems = [
    ...todaysEvents.map((e) => ({
      id: e.routine_id,
      title: e.title,
      at: clock(e.due_at, timeZone),
      dueAt: e.due_at,
      status: e.status,
      streak: streaks.get(e.routine_id) ?? 0,
    })),
    ...upcoming,
  ].sort((a, b) => a.dueAt - b.dueAt);
  if (routineItems.length) cards.push({ kind: "routines", title: "Routines today", items: routineItems });

  for (const e of events.results.filter((e) => e.status === "missed")) {
    cards.push({ kind: "missed", title: "Missed", body: `${e.title} at ${clock(e.due_at, timeZone)}`, routineId: e.routine_id });
  }
  for (const r of routines) {
    const days = streaks.get(r.id) ?? 0;
    if (days >= STREAK_CARD_DAYS) {
      cards.push({ kind: "streak", title: `${days} days in a row`, body: r.title, routineId: r.id });
    }
  }

  for (const w of workouts.results) {
    const minutes = Math.round((w.end_at - w.start_at) / 60_000);
    cards.push({
      kind: "workout",
      title: `${w.confirmed_kind ?? WORKOUT_WORDS[w.kind] ?? w.kind} · ${minutes} min · ${clock(w.start_at, timeZone)}`,
      body: w.summary ?? "",
      workoutId: w.id,
    });
  }

  for (const f of favors.results) {
    const unsure = (f.confidence ?? 1) < 0.8;
    cards.push({
      kind: "favor",
      title: unsure ? `Did ${f.who ?? "someone"} ask you to…` : `${f.who ?? "Someone"} asked you to…`,
      body: f.quote ? `${f.text} — "${f.quote}"` : f.text,
      commitmentId: f.id,
      unsure,
    });
  }

  const byAgent = recent.filter((a) => a.source === "agent" && a.kind !== "agent_run");
  if (byAgent.length) {
    cards.push({
      kind: "agent",
      title: "Done on its own",
      items: byAgent.slice(0, 6).map((a) => ({ at: clock(a.ts, timeZone), text: a.summary })),
    });
  }

  if ((week?.n ?? 0) > 0) {
    const minutes = Math.round((week?.minutes ?? 0) * 10) / 10;
    cards.push({
      kind: "week",
      title: "This week",
      body: `${week!.n} things done for you`,
      minutesSaved: minutes,
    });
  }

  const shown = recent.filter((a) => !["agent_run", "buzz", "routine_fired"].includes(a.kind));
  if (shown.length) {
    cards.push({
      kind: "activity",
      title: "Recently",
      items: shown.slice(0, 8).map((a) => ({ at: clock(a.ts, timeZone), text: a.summary, source: a.source })),
    });
  }

  return cards;
}

export const feed = new Hono<{ Bindings: Env; Variables: Vars }>();

feed.get("/feed", async (c) => {
  const row = await c.env.DB.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(c.var.userId).first<{ time_zone: string | null }>();
  return c.json({ cards: await buildFeed(c.env.DB, c.var.userId, validTimeZone(row?.time_zone)) });
});
