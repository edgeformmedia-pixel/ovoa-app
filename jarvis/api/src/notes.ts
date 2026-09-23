import { Hono } from "hono";
import { logAction } from "./actionlog";
import { capabilities } from "./capabilities";
import { resolveDue } from "./context";
import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { push } from "./push";
import { clock } from "./time";
import type { Env, Vars } from "./types";

// Mental notes. See migrations/0018_notes.sql.

const MAX_RESULTS = 20;

type NoteRow = {
  id: string;
  ts: number;
  text: string;
  tags: string;
  place: string | null;
  remind_at: number | null;
  reminded_at: number | null;
  done: number;
};

const tagsOf = (json: string) => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const cleanTags = (v: unknown) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .map((t) => String(t).trim().toLowerCase().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 8);

/**
 * Where a note's words came from (migrations/0036). "on_device": a recording
 * (the band's, or dictation) turned into text by the iPhone's own speech
 * recognition, so no audio ever reached this server; that is how free notes
 * are made (docs/paywall/05), and since 2026-09-23 how every spoken note is.
 * "server": transcribed here by /voice/transcribe, which only answers 410 now;
 * kept for older notes. "typed": everything else.
 */
export const NOTE_SOURCES = ["typed", "on_device", "server"] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

export async function addNote(
  db: D1Database,
  userId: string,
  n: { text: string; tags?: string[]; place?: string | null; remindAt?: number | null; placeId?: string | null; source?: NoteSource },
) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO notes (id, user_id, ts, text, tags, place, remind_at, place_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      id,
      userId,
      Date.now(),
      n.text.slice(0, 2000),
      JSON.stringify(n.tags ?? []),
      n.place ?? null,
      n.remindAt ?? null,
      n.placeId ?? null,
      n.source ?? "typed",
    )
    .run();
  return id;
}

/** Word search: every word has to appear, in the text, the tags or the place. */
export async function searchNotes(db: D1Database, userId: string, q: string) {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  if (!words.length) return [];
  const where = words.map(() => "(lower(text) LIKE ? OR lower(tags) LIKE ? OR lower(COALESCE(place, '')) LIKE ?)").join(" AND ");
  const { results } = await db
    .prepare(`SELECT * FROM notes WHERE user_id = ? AND ${where} ORDER BY ts DESC LIMIT ?`)
    .bind(userId, ...words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]), MAX_RESULTS)
    .all<NoteRow>();
  return results;
}

export async function listNotes(db: D1Database, userId: string, tag?: string, limit = MAX_RESULTS) {
  const { results } = await db
    .prepare(
      `SELECT * FROM notes WHERE user_id = ? AND done = 0 ${tag ? "AND tags LIKE ?" : ""} ORDER BY ts DESC LIMIT ?`,
    )
    .bind(...(tag ? [userId, `%"${tag.toLowerCase()}"%`, limit] : [userId, limit]))
    .all<NoteRow>();
  return results;
}

/**
 * Notes whose reminder time has come. Always a notification with the note's own
 * words, since a buzz alone can't say what it's about, and a buzz as well when
 * there's a band.
 */
export async function fireDueNotes(env: Env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, text, tags, urgent FROM notes WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND remind_at <= ? LIMIT 50",
  )
    .bind(now)
    .all<{ id: string; user_id: string; text: string; tags: string; urgent: number }>();
  for (const n of results) {
    const claim = await env.DB.prepare("UPDATE notes SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL").bind(now, n.id).run();
    if (!claim.meta.changes) continue;
    const caps = await capabilities(env.DB, n.user_id);
    // "Remind Sarah at 6" (remind_other): the text arrives ready, one tap from being sent.
    const other = /^Text (.+?): ([\s\S]+)$/.exec(n.text);
    await push(
      env,
      n.user_id,
      n.tags.includes('"remind_other"') && other
        ? { title: `Text ${other[1]}?`, body: other[2].slice(0, 180), data: { type: "remind-other", who: other[1], text: other[2] } }
        : { title: "Reminder", body: n.text.slice(0, 180), data: { type: "note", noteId: n.id } },
    );
    if (n.urgent) {
      // The phone buzzes every 30 s until it hears "I did it" (alarms.ts keeps pushing too).
      await push(env, n.user_id, { silent: true, data: { type: "nag", id: crypto.randomUUID(), key: `note:${n.id}`, label: n.text.slice(0, 120) } });
    } else if (caps.band) {
      await push(env, n.user_id, { silent: true, data: { type: "buzz", id: crypto.randomUUID(), pattern: "reminder", reason: n.text.slice(0, 180) } });
    }
    await logAction(env.DB, n.user_id, "reminder_fired", `Reminded: ${n.text.slice(0, 120)}`, "system", n.id);
  }
  return results.length;
}

const TOOLS: ToolSpec[] = [
  {
    name: "note_add",
    description:
      "Keeps something they want to remember, word for word: a fact, an idea, something to do. Use for 'remember that…', 'note that…', 'make a note…'. It can also bring the note back at a time. A plain 'remind me to call Mum at 5' is still an ordinary phone reminder, not a note. Tag with 'todo' for things to do, which then show up on tomorrow's list.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note, in their words, complete on its own." },
        tags: { type: "array", items: { type: "string" }, description: "A few short tags: todo, house, work, gift…" },
        remindAt: { type: "string", description: "Local YYYY-MM-DDTHH:MM to remind them, if they asked for a reminder." },
        place: { type: "string", description: "A place it's about ('the pharmacy'), if they said one." },
      },
      required: ["text"],
    },
  },
  {
    name: "note_search",
    description: "Finds notes they kept, by words in them. For 'what was the Wi-Fi password', 'what did I note about the dentist'.",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
  {
    name: "note_list",
    description: "Their recent notes, optionally only one tag ('todo').",
    parameters: { type: "object", properties: { tag: { type: "string" } } },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isNoteTool = (name: string) => NAMES.has(name);

export function notesAssistant(env: Env, userId: string, timeZone: string, opts: { voice?: boolean } = {}) {
  const db = env.DB;
  const show = (n: NoteRow) => ({
    id: n.id,
    text: n.text,
    tags: tagsOf(n.tags),
    kept: new Date(n.ts).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" }),
    ...(n.place && { place: n.place }),
    ...(n.remind_at && { remind: new Date(n.remind_at).toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }) }),
  });

  const callTool: CallTool = async (name, args) => {
    if (name === "note_add") {
      const text = String(args.text ?? "").trim();
      if (!text) return { error: "text is required" };
      const remindAt = args.remindAt ? resolveDue(String(args.remindAt), timeZone) : null;
      if (args.remindAt && !remindAt) return { error: "remindAt must be YYYY-MM-DDTHH:MM" };
      if (remindAt && remindAt < Date.now()) return { error: "That time has already passed." };
      const place = String(args.place ?? "").trim().slice(0, 120) || null;
      // A place OVOA has learned (location.ts) has a geofence, so the note can fire on arrival.
      const known = place
        ? await db
            .prepare("SELECT id, name FROM places WHERE user_id = ? AND (lower(name) LIKE ? OR kind = ?) LIMIT 1")
            .bind(userId, `%${place.toLowerCase()}%`, place.toLowerCase())
            .first<{ id: string; name: string | null }>()
        : null;
      const id = await addNote(db, userId, { text, tags: cleanTags(args.tags), place, remindAt, placeId: known?.id ?? null });
      return {
        saved: true,
        id,
        ...(remindAt && { reminder: `${new Date(remindAt).toLocaleDateString("en-US", { timeZone, weekday: "long" })} at ${clock(remindAt, timeZone)}` }),
        ...(place &&
          (known
            ? { place: known.name ?? place, note: "It will come up when they next arrive there. Say so briefly." }
            : {
                note: "Kept the place with it, but OVOA hasn't learned that place yet (it needs the location timeline on, and a few visits). Say so briefly.",
              })),
      };
    }
    if (name === "note_search") {
      const found = await searchNotes(db, userId, String(args.q ?? ""));
      return found.length ? { notes: found.map(show) } : { notes: 0, note: "Nothing noted about that." };
    }
    if (name === "note_list") {
      const tag = args.tag ? String(args.tag).trim().toLowerCase().replace(/^#/, "") : undefined;
      const list = await listNotes(db, userId, tag);
      return list.length ? { notes: list.map(show) } : { notes: 0 };
    }
    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: opts.voice ? TOOLS.filter((t) => t.name !== "note_list") : TOOLS,
    callTool,
    prompt:
      "When they want something remembered word for word, or reminded at a time, keep it with note_add; find it again with note_search. Notes tagged 'todo' go on tomorrow's list.",
  };
}

// ---------- Routes ----------

export const notes = new Hono<{ Bindings: Env; Variables: Vars }>();

notes.get("/notes", async (c) => {
  const q = c.req.query("q");
  const tag = c.req.query("tag");
  const list = q ? await searchNotes(c.env.DB, c.var.userId, q) : await listNotes(c.env.DB, c.var.userId, tag, 100);
  return c.json({ notes: list.map((n) => ({ ...n, tags: tagsOf(n.tags) })) });
});

notes.post("/notes", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; tags?: unknown; remindAt?: unknown; source?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required" }, 400);
  // Text only, always: a note never carries audio, whoever transcribed it. Free
  // (plans.ts), including the notes the phone transcribed itself.
  const source = body?.source ?? "typed";
  if (!(NOTE_SOURCES as readonly unknown[]).includes(source)) return c.json({ error: `source must be one of ${NOTE_SOURCES.join(", ")}` }, 400);
  const tz = await c.env.DB.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(c.var.userId).first<{ time_zone: string | null }>();
  const remindAt = typeof body?.remindAt === "string" ? resolveDue(body.remindAt, validTimeZone(tz?.time_zone)) : null;
  const id = await addNote(c.env.DB, c.var.userId, { text, tags: cleanTags(body?.tags), remindAt, source: source as NoteSource });
  await logAction(c.env.DB, c.var.userId, "note", `Noted: ${text.slice(0, 120)}`, "chat", id);
  return c.json({ id }, 201);
});

notes.patch("/notes/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { done?: unknown } | null;
  if (typeof body?.done !== "boolean") return c.json({ error: "done is required" }, 400);
  const { meta } = await c.env.DB.prepare("UPDATE notes SET done = ? WHERE id = ? AND user_id = ?")
    .bind(Number(body.done), c.req.param("id"), c.var.userId)
    .run();
  return meta.changes ? c.json({ ok: true }) : c.json({ error: "No such note" }, 404);
});

notes.delete("/notes/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return c.json({ ok: true });
});
