import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import { sendBuzz } from "./buzz";
import { validTimeZone } from "./google/assistant";
import { googleAccessToken, listGoogleAccounts } from "./google/oauth";
import { toolsByName } from "./google/tools";
import type { CallTool, ToolSpec } from "./llm";
import { push } from "./push";
import { addDays, atLocalTime, buckets, dayRange } from "./time";
import type { Env, Vars } from "./types";
import { inSlice, type Slice } from "./sweep";

// Tomorrow's list, and the nudge to go to bed. See migrations/0019_todos.sql.
//
// Built only from what OVOA already has — promises, notes, routines, today's
// leftovers — so it works with no Google account and no band. Google Tasks,
// when connected, gets a copy; the band, when there is one, gets the bedtime tap.

/** Lines on a day's list. More than this and it's a backlog, not a plan. */
export const LIST_SIZE = 10;
/** When no bedtime was given in setup. */
export const DEFAULT_SLEEP = 23 * 60;
/** How long before bedtime the list is built. */
const BUILD_LEAD_MIN = 60;
/** How late after the moment each daily thing may still happen (a cron that was down, a phone that was off). */
const BUILD_GRACE_MIN = 180;
const BEDTIME_GRACE_MIN = 30;

export type Candidate = {
  text: string;
  source: "commitment" | "note" | "routine" | "carried" | "user";
  sourceId: string | null;
  /** Due within a day and a half. */
  dueSoon: boolean;
  /** Owed to someone rather than to themselves. */
  fromPerson: boolean;
  ageDays: number;
  /** 0-3, when the user said how much it matters. */
  priority: number;
};

/**
 * How much a line deserves a place on the list. Something due tomorrow beats
 * something owed to a person beats something old; age is capped so a
 * month-old note doesn't outrank everything forever.
 */
export const score = (c: Candidate) => (c.dueSoon ? 3 : 0) + (c.fromPerson ? 2 : 0) + Math.min(c.ageDays, 7) * 0.5 + c.priority;

/** The top of a pile of candidates, with the same thing from two places kept once. */
export function pick(candidates: Candidate[], size = LIST_SIZE) {
  const seen = new Set<string>();
  return candidates
    .map((c) => ({ ...c, score: score(c) }))
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      const key = c.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, size);
}

async function gather(db: D1Database, userId: string, day: string, timeZone: string): Promise<Candidate[]> {
  const now = Date.now();
  const age = (ts: number) => Math.max(0, (now - ts) / 86_400_000);
  const [dayStart, dayEnd] = dayRange(day, timeZone);
  const today = addDays(day, -1);
  const [todayStart] = dayRange(today, timeZone);

  const [promises, notes, carried, missed] = await Promise.all([
    db
      // Favors the model wasn't sure of wait for the user to say they're real.
      .prepare(
        "SELECT id, text, who, due_at, created_at FROM context_commitments WHERE user_id = ? AND status = 'open' AND (confidence IS NULL OR confidence >= 0.8) ORDER BY created_at DESC LIMIT 40",
      )
      .bind(userId)
      .all<{ id: string; text: string; who: string | null; due_at: number | null; created_at: number }>(),
    db
      .prepare(`SELECT id, text, ts FROM notes WHERE user_id = ? AND done = 0 AND tags LIKE '%"todo"%' ORDER BY ts DESC LIMIT 40`)
      .bind(userId)
      .all<{ id: string; text: string; ts: number }>(),
    db
      .prepare("SELECT id, text, source, source_id, priority, created_at FROM todos WHERE user_id = ? AND date = ? AND done = 0")
      .bind(userId, today)
      .all<{ id: string; text: string; source: string; source_id: string | null; priority: number; created_at: number }>(),
    // Missed today, but not medication: a missed dose is for a doctor's advice, not a to-do line.
    db
      .prepare(
        `SELECT DISTINCT r.id, r.title FROM routine_events e JOIN routines r ON r.id = e.routine_id
          WHERE e.user_id = ? AND e.status = 'missed' AND e.due_at >= ? AND e.due_at < ? AND r.kind != 'med'`,
      )
      .bind(userId, todayStart, dayStart)
      .all<{ id: string; title: string }>(),
  ]);

  return [
    ...promises.results.map((p) => ({
      text: p.who ? `${p.text} (for ${p.who})` : p.text,
      source: "commitment" as const,
      sourceId: p.id,
      dueSoon: !!p.due_at && p.due_at < dayEnd + 12 * 3_600_000,
      fromPerson: !!p.who,
      ageDays: age(p.created_at),
      priority: 0,
    })),
    ...notes.results.map((n) => ({
      text: n.text,
      source: "note" as const,
      sourceId: n.id,
      dueSoon: false,
      fromPerson: false,
      ageDays: age(n.ts),
      priority: 0,
    })),
    ...carried.results.map((t) => ({
      text: t.text,
      // Keeps pointing at where it first came from, so ticking it off closes that too.
      source: (t.source === "user" ? "user" : "carried") as Candidate["source"],
      sourceId: t.source_id ?? t.id,
      dueSoon: true,
      fromPerson: false,
      ageDays: age(t.created_at),
      priority: t.priority,
    })),
    ...missed.results.map((r) => ({
      text: `Catch up: ${r.title}`,
      source: "routine" as const,
      sourceId: r.id,
      dueSoon: false,
      fromPerson: false,
      ageDays: 0,
      priority: 0,
    })),
  ];
}

/** Builds (or rebuilds) the list for `day`. Lines the user added by hand are kept. */
export async function buildTodos(env: Env, userId: string, day: string, timeZone: string) {
  const db = env.DB;
  // Lines added by hand stay, so a candidate saying the same thing isn't added twice.
  const { results: kept } = await db
    .prepare("SELECT text FROM todos WHERE user_id = ? AND date = ? AND (source = 'user' OR done = 1)")
    .bind(userId, day)
    .all<{ text: string }>();
  const already = new Set(kept.map((k) => k.text.toLowerCase()));
  const top = pick((await gather(db, userId, day, timeZone)).filter((c) => !already.has(c.text.toLowerCase())));
  const now = Date.now();
  // A line already copied to Google Tasks or Reminders — on this list before a
  // rebuild, or on today's and carried over — keeps its copy instead of getting a second one.
  const { results: before } = await db
    .prepare("SELECT text, synced_to, external_id FROM todos WHERE user_id = ? AND date IN (?, ?) AND synced_to IS NOT NULL")
    .bind(userId, day, addDays(day, -1))
    .all<{ text: string; synced_to: string; external_id: string | null }>();
  const copies = new Map(before.map((b) => [b.text, b]));
  await db.batch([
    db.prepare("DELETE FROM todos WHERE user_id = ? AND date = ? AND source != 'user' AND done = 0").bind(userId, day),
    ...top.map((c, i) => {
      const text = c.text.slice(0, 300);
      const copy = copies.get(text);
      return db
        .prepare(
          `INSERT INTO todos (id, user_id, date, text, source, source_id, priority, score, synced_to, external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          userId,
          day,
          text,
          c.source === "user" ? "carried" : c.source,
          c.sourceId,
          c.priority,
          c.score,
          copy?.synced_to ?? null,
          copy?.external_id ?? null,
          now + i,
        );
    }),
  ]);
  await syncToGoogle(env, userId, day).catch((err) => console.error("todos: Google Tasks copy failed", err));
  return listTodos(db, userId, day);
}

/**
 * A copy in Google Tasks, when an account is connected, into the default
 * account's default list. Only lines not already copied, so a rebuild doesn't
 * duplicate them. Reminders gets its copy from the phone (lib/todos.ts).
 */
async function syncToGoogle(env: Env, userId: string, day: string) {
  const accounts = await listGoogleAccounts(env.DB, userId);
  const account = accounts.find((a) => a.isDefault) ?? accounts[0];
  if (!account || !account.scopes.some((s) => s.includes("tasks"))) return;
  const { results } = await env.DB.prepare("SELECT id, text FROM todos WHERE user_id = ? AND date = ? AND synced_to IS NULL AND done = 0")
    .bind(userId, day)
    .all<{ id: string; text: string }>();
  if (!results.length) return;
  const ctx = { token: await googleAccessToken(env, userId, account.id), timeZone: "UTC" };
  const add = toolsByName.get("tasks_add")!;
  for (const t of results) {
    const made = (await add.run(ctx, { title: t.text, due: day, notes: "From OVOA's list for the day" })) as { id?: string };
    await env.DB.prepare("UPDATE todos SET synced_to = 'google_tasks', external_id = ? WHERE id = ?").bind(made.id ?? null, t.id).run();
  }
}

export async function listTodos(db: D1Database, userId: string, day: string) {
  const { results } = await db
    .prepare(
      "SELECT id, date, text, source, source_id, priority, score, done, synced_to, external_id FROM todos WHERE user_id = ? AND date = ? ORDER BY done, score DESC, created_at",
    )
    .bind(userId, day)
    .all<{ id: string; date: string; text: string; source: string; source_id: string | null; priority: number; score: number; done: number; synced_to: string | null; external_id: string | null }>();
  return results;
}

/** Ticks a line off, and whatever it came from: the promise, the note. */
export async function completeTodo(db: D1Database, userId: string, id: string) {
  const row = await db
    .prepare("UPDATE todos SET done = 1, done_at = ? WHERE id = ? AND user_id = ? AND done = 0 RETURNING text, source, source_id")
    .bind(Date.now(), id, userId)
    .first<{ text: string; source: string; source_id: string | null }>();
  if (!row) return null;
  if (row.source_id && row.source === "commitment") {
    await db.prepare("UPDATE context_commitments SET status = 'done' WHERE id = ? AND user_id = ?").bind(row.source_id, userId).run();
  } else if (row.source_id && row.source === "note") {
    await db.prepare("UPDATE notes SET done = 1 WHERE id = ? AND user_id = ?").bind(row.source_id, userId).run();
  }
  // The same line on any later day's list goes too.
  await db.prepare("UPDATE todos SET done = 1, done_at = ? WHERE user_id = ? AND done = 0 AND text = ?").bind(Date.now(), userId, row.text).run();
  return row.text;
}

async function mark(db: D1Database, userId: string, kind: string, day: string) {
  const res = await db
    .prepare("INSERT OR IGNORE INTO daily_marks (user_id, kind, day, at) VALUES (?, ?, ?, ?)")
    .bind(userId, kind, day, Date.now())
    .run();
  return !!res.meta.changes;
}

/**
 * The bedtime that belongs to the evening of `day`. A bedtime after midnight
 * (00:30) is still that evening's, so it lands on the next calendar day.
 */
export function bedtimeFor(day: string, sleep: number, timeZone: string) {
  return sleep >= 12 * 60 ? atLocalTime(day, sleep, timeZone) : atLocalTime(addDays(day, 1), sleep, timeZone);
}

/**
 * Every two minutes: anyone whose bedtime is an hour off gets tomorrow's list
 * built; anyone whose bedtime has come gets told. Each happens once per
 * evening (daily_marks), however many ticks land in the window.
 */
export async function eveningTick(env: Env, slice?: Slice) {
  const db = env.DB;
  const now = Date.now();
  // Only people the phone can reach; everyone else gets their list when they open the app.
  const { results } = await db
    .prepare(
      `SELECT s.user_id, s.time_zone, p.sleep_time FROM settings s
         LEFT JOIN profile p ON p.user_id = s.user_id
        WHERE EXISTS (SELECT 1 FROM push_tokens t WHERE t.user_id = s.user_id)`,
    )
    .all<{ user_id: string; time_zone: string | null; sleep_time: number | null }>();

  let built = 0;
  let told = 0;
  for (const u of results) {
    if (!inSlice(u.user_id, slice)) continue;
    const timeZone = validTimeZone(u.time_zone);
    const sleep = u.sleep_time ?? DEFAULT_SLEEP;
    const today = buckets(now, timeZone).day;
    for (const evening of [addDays(today, -1), today]) {
      const bedtime = bedtimeFor(evening, sleep, timeZone);
      const buildAt = bedtime - BUILD_LEAD_MIN * 60_000;
      if (now >= buildAt && now < buildAt + BUILD_GRACE_MIN * 60_000 && (await mark(db, u.user_id, "todos", evening))) {
        try {
          const tomorrow = addDays(evening, 1);
          const list = await buildTodos(env, u.user_id, tomorrow, timeZone);
          await logAction(db, u.user_id, "todo_list", `Built tomorrow's list: ${list.length} things`, "system");
          if (list.length) {
            await push(env, u.user_id, {
              title: "Tomorrow's list is ready",
              body: list.slice(0, 3).map((t) => t.text).join(" · ").slice(0, 180),
              data: { type: "todos", date: tomorrow },
            });
          }
          built++;
        } catch (err) {
          console.error(`todos: couldn't build for ${u.user_id}`, err);
        }
      }
      if (now >= bedtime && now < bedtime + BEDTIME_GRACE_MIN * 60_000 && (await mark(db, u.user_id, "bedtime", evening))) {
        // A tap on the wrist with a band, a notification without one (sendBuzz decides).
        await sendBuzz(env, u.user_id, "double", "Time for bed — tomorrow's list is ready.", "system");
        told++;
      }
    }
  }
  return { built, told };
}

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "todo_list",
    description:
      "The to-do list for a day: built each evening an hour before bed from what they promised, notes tagged todo, today's leftovers and missed routines. Use for 'what's on my list', 'what do I need to do tomorrow'.",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD. Leave out for today." }, rebuild: { type: "boolean", description: "Build it fresh now (e.g. for tomorrow, before the evening)." } },
    },
  },
  {
    name: "todo_done",
    description: "Ticks something off the list (and the promise or note it came from). Get the id from todo_list.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "todo_add",
    description: "Puts something on a day's list by hand. It stays even when the list is rebuilt.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD; leave out for today." } },
      required: ["text"],
    },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isTodoTool = (name: string) => NAMES.has(name);

const validDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export function todosAssistant(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const today = () => buckets(Date.now(), timeZone).day;
  const callTool: CallTool = async (name, args) => {
    if (name === "todo_list") {
      const day = validDay(args.date) ?? today();
      const list = args.rebuild ? await buildTodos(env, userId, day, timeZone) : await listTodos(db, userId, day);
      if (!list.length) return { date: day, todos: 0, note: day === today() ? "Nothing on today's list." : "No list for that day yet; rebuild: true builds one now." };
      return { date: day, todos: list.map((t) => ({ id: t.id, text: t.text, done: !!t.done })) };
    }
    if (name === "todo_done") {
      const text = await completeTodo(db, userId, String(args.id ?? ""));
      return text ? { done: text } : { error: "No such open item. Get the id from todo_list." };
    }
    if (name === "todo_add") {
      const text = String(args.text ?? "").trim();
      if (!text) return { error: "text is required" };
      const day = validDay(args.date) ?? today();
      await db
        .prepare("INSERT INTO todos (id, user_id, date, text, source, priority, score, created_at) VALUES (?, ?, ?, ?, 'user', 1, 10, ?)")
        .bind(crypto.randomUUID(), userId, day, text.slice(0, 300), Date.now())
        .run();
      return { added: true, date: day };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt: "Each evening, an hour before bed, OVOA builds tomorrow's to-do list and says goodnight at bedtime. Read it with todo_list; tick things off with todo_done.",
  };
}

// ---------- Routes ----------

export const todos = new Hono<{ Bindings: Env; Variables: Vars }>();

async function tzOf(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  return validTimeZone(row?.time_zone);
}

todos.get("/todos", async (c) => {
  const timeZone = await tzOf(c.env.DB, c.var.userId);
  const day = validDay(c.req.query("date")) ?? buckets(Date.now(), timeZone).day;
  return c.json({ date: day, todos: await listTodos(c.env.DB, c.var.userId, day) });
});

todos.post("/todos/build", async (c) => {
  const timeZone = await tzOf(c.env.DB, c.var.userId);
  const body = (await c.req.json().catch(() => ({}))) as { date?: string };
  const day = validDay(body.date) ?? addDays(buckets(Date.now(), timeZone).day, 1);
  return c.json({ date: day, todos: await buildTodos(c.env, c.var.userId, day, timeZone) });
});

todos.post("/todos/:id/done", async (c) => {
  const text = await completeTodo(c.env.DB, c.var.userId, c.req.param("id"));
  if (!text) return c.json({ error: "No such open item" }, 404);
  await logAction(c.env.DB, c.var.userId, "task", `Done: ${text.slice(0, 120)}`, "chat");
  return c.json({ ok: true });
});

/** The phone copied these into Reminders. */
todos.post("/todos/synced", async (c) => {
  const parsed = z
    .object({ items: z.array(z.object({ id: z.string().max(64), externalId: z.string().max(200) })).max(20) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid" }, 400);
  if (!parsed.data.items.length) return c.json({ ok: true });
  await c.env.DB.batch(
    parsed.data.items.map((i) =>
      c.env.DB.prepare("UPDATE todos SET synced_to = 'apple_reminders', external_id = ? WHERE id = ? AND user_id = ? AND synced_to IS NULL")
        .bind(i.externalId, i.id, c.var.userId),
    ),
  );
  return c.json({ ok: true });
});
