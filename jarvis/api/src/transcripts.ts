import { Hono } from "hono";
import { validTimeZone } from "./google/assistant";
import { digestBlock, type Extracted } from "./people";
import { generateText, type CallTool, type ToolSpec } from "./llm";
import { atLocalTime, buckets, clock, dayRange } from "./time";
import type { Env, Vars } from "./types";

// Transcripts: everything said, titled every five minutes, every hour, every
// day. See migrations/0022_captures.sql.
//
// Storing is cheap and happens as each line arrives; titling is the expensive
// part and happens on the cron, once a block is over, a few blocks at a time.
// A line that turns up late makes its block out of date, and the block, its
// hour and its day are written again.

export type LineSource = "mic" | "assistant" | "recording" | "background";

export const BLOCK_MS = 5 * 60_000;
export const TRANSCRIPT_RETAIN_DAYS = 14;
/** Blocks titled per tick. The rest wait two minutes. */
const BLOCKS_PER_TICK = 20;
/** Today's title is rewritten at most this often while the day is still going. */
const DAY_REFRESH_MS = 15 * 60_000;
const MAX_PROMPT_CHARS = 8000;

export const blockStart = (ts: number) => Math.floor(ts / BLOCK_MS) * BLOCK_MS;

/**
 * Keeps one line. Background lines only for a development account with
 * capture-everything on; everything else whenever the timeline or capture is on.
 */
export async function storeLine(db: D1Database, userId: string, text: string, source: LineSource, ts = Date.now()) {
  const clean = text.trim();
  if (!clean) return false;
  const s = await db
    .prepare("SELECT context_enabled, capture_everything FROM settings WHERE user_id = ?")
    .bind(userId)
    .first<{ context_enabled: number; capture_everything: number }>();
  const allowed = source === "background" ? !!s?.capture_everything : !!(s?.context_enabled || s?.capture_everything);
  if (!allowed) return false;
  await db
    .prepare("INSERT INTO raw_captures (id, user_id, ts, text, source) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, ts, clean.slice(0, 4000), source)
    .run();
  return true;
}

// ---------- Titling ----------

const titleSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "At most seven words: what this stretch was about." },
    summary: { type: "string", description: "One or two plain sentences: what was said or done, with names and specifics." },
  },
  required: ["title", "summary"],
};

/**
 * A five-minute block's pass does more than title it: the same call says who
 * came up and what was learned about them, anything someone asked the user to
 * do, and any name the user was called by (people.ts files all of it).
 */
const blockSchema = {
  type: "object",
  properties: {
    ...titleSchema.properties,
    people: {
      type: "array",
      description: "People other than the user who were mentioned or spoke, with anything worth remembering about them.",
      items: {
        type: "object",
        properties: { name: { type: "string" }, facts: { type: "array", items: { type: "string" } } },
        required: ["name"],
      },
    },
    favors: {
      type: "array",
      description: "Things someone asked THE USER to do (not things the user asked OVOA). Empty if none.",
      items: {
        type: "object",
        properties: {
          who: { type: "string" },
          what: { type: "string", description: "What they asked, as a to-do: 'send Sarah the deck'." },
          quote: { type: "string", description: "Their words." },
          due: { type: "string", description: "YYYY-MM-DD or YYYY-MM-DDTHH:MM if a time was said." },
          confidence: { type: "number", description: "0-1: how sure you are it was really asked of the user." },
        },
        required: ["what", "confidence"],
      },
    },
    calledUser: {
      type: "array",
      items: { type: "string" },
      description: "Names someone used to address the user, only when it's clear the user was the one addressed and answered.",
    },
  },
  required: ["title", "summary"],
};

async function writeTitle(env: Env, system: string, body: string, schema: Record<string, unknown> = titleSchema) {
  const raw = await generateText(env, {
    model: env.MEMORY_MODEL,
    fast: true,
    json: { schema },
    system,
    turns: [{ role: "user", text: body.slice(0, MAX_PROMPT_CHARS) }],
  });
  const parsed = JSON.parse(raw) as { title?: string; summary?: string } & Extracted;
  return {
    title: String(parsed.title ?? "").slice(0, 100) || null,
    summary: String(parsed.summary ?? "").slice(0, 600) || null,
    extracted: { people: parsed.people, favors: parsed.favors, calledUser: parsed.calledUser } as Extracted,
  };
}

/**
 * Files a titled block in the timeline (context_blocks), so "Your days" and the
 * timeline tools see what was said, not only what was recorded on purpose.
 * Re-titling a block updates the same row.
 */
async function fileInTimeline(
  db: D1Database,
  userId: string,
  start: number,
  existing: string | null,
  t: { title: string | null; summary: string | null; extracted: Extracted },
) {
  const people = (t.extracted.people ?? []).map((p) => p.name).filter(Boolean);
  if (existing) {
    await db
      .prepare("UPDATE context_blocks SET title = ?, summary = ?, people = ? WHERE id = ? AND user_id = ?")
      .bind(t.title, t.summary, people.length ? JSON.stringify(people) : null, existing, userId)
      .run();
    return existing;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO context_blocks (id, user_id, started_at, ended_at, source, title, summary, category, people, has_transcript, created_at)
       VALUES (?, ?, ?, ?, 'voice', ?, ?, 'transcript', ?, 1, ?)`,
    )
    .bind(id, userId, start, start + BLOCK_MS, t.title, t.summary, people.length ? JSON.stringify(people) : null, Date.now())
    .run();
  return id;
}

const SOURCE_LABEL: Record<string, string> = { mic: "They said", assistant: "OVOA said", recording: "Recorded", background: "Overheard" };

async function upsert(db: D1Database, userId: string, grain: string, bucket: string, start: number, t: { title: string | null; summary: string | null }, sources: string, covers: number) {
  await db
    .prepare(
      `INSERT INTO transcript_titles (user_id, grain, bucket, start, title, summary, sources, covers, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, grain, bucket) DO UPDATE SET title = excluded.title, summary = excluded.summary,
         sources = excluded.sources, covers = excluded.covers, updated_at = excluded.updated_at`,
    )
    .bind(userId, grain, bucket, start, t.title, t.summary, sources, covers, Date.now())
    .run();
}

/**
 * Titles finished five-minute blocks that are new or have gained lines, then
 * the hours and days they belong to. Called every two minutes.
 */
export async function titleTranscripts(env: Env) {
  const db = env.DB;
  const now = Date.now();
  const { results: due } = await db
    .prepare(
      `SELECT c.user_id, (c.ts / ${BLOCK_MS}) * ${BLOCK_MS} AS start, COUNT(*) AS n, s.time_zone, s.context_enabled,
              MAX(t.block_id) AS block_id, u.name AS user_name
         FROM raw_captures c
         JOIN users u ON u.id = c.user_id
         JOIN settings s ON s.user_id = c.user_id
         LEFT JOIN transcript_titles t ON t.user_id = c.user_id AND t.grain = '5m' AND t.start = (c.ts / ${BLOCK_MS}) * ${BLOCK_MS}
        WHERE c.ts < ? AND c.ts > ?
        GROUP BY c.user_id, start
       HAVING COUNT(*) > COALESCE(MAX(t.covers), 0)
        ORDER BY start LIMIT ?`,
    )
    // A block is titled once it's over, plus a minute for a slow upload.
    .bind(blockStart(now - 60_000), now - TRANSCRIPT_RETAIN_DAYS * 86_400_000, BLOCKS_PER_TICK)
    .all<{ user_id: string; start: number; n: number; time_zone: string | null; context_enabled: number; block_id: string | null; user_name: string }>();

  const hours = new Map<string, { userId: string; hour: string; timeZone: string }>();
  for (const b of due) {
    const timeZone = validTimeZone(b.time_zone);
    const { results: lines } = await db
      .prepare("SELECT ts, text, source FROM raw_captures WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .bind(b.user_id, b.start, b.start + BLOCK_MS)
      .all<{ ts: number; text: string; source: string }>();
    const sources = [...new Set(lines.map((l) => l.source))].sort().join(",");
    try {
      const t = await writeTitle(
        env,
        [
          `You title five minutes of ${b.user_name}'s day from a transcript. 'They said' is ${b.user_name}; 'OVOA said' is their assistant.`,
          "Lines marked 'Overheard' were picked up in the background (TV, other people, the room) and may be noise; say so if that's all there is.",
          "Never invent what isn't there. Only list a favor when someone really asked the user to do something, and be honest in the confidence.",
        ].join(" "),
        lines.map((l) => `[${clock(l.ts, timeZone)}] ${SOURCE_LABEL[l.source] ?? l.source}: ${l.text}`).join("\n"),
        blockSchema,
      );
      await upsert(db, b.user_id, "5m", new Date(b.start).toISOString(), b.start, t, sources, b.n);
      if (b.context_enabled) {
        const blockId = await fileInTimeline(db, b.user_id, b.start, b.block_id, t);
        await db
          .prepare("UPDATE transcript_titles SET block_id = ? WHERE user_id = ? AND grain = '5m' AND start = ?")
          .bind(blockId, b.user_id, b.start)
          .run();
        await digestBlock(env, b.user_id, blockId, t.extracted, timeZone).catch((err) => console.error("transcripts: couldn't file what was said", err));
      }
      const hour = buckets(b.start, timeZone).hour;
      hours.set(`${b.user_id}|${hour}`, { userId: b.user_id, hour, timeZone });
    } catch (err) {
      console.error("transcripts: couldn't title a block", err);
    }
  }

  const days = new Map<string, { userId: string; day: string; timeZone: string }>();
  for (const { userId, hour, timeZone } of hours.values()) {
    const start = atLocalTime(hour.slice(0, 10), Number(hour.slice(11, 13)) * 60, timeZone);
    const { results: blocks } = await db
      .prepare("SELECT start, title, sources FROM transcript_titles WHERE user_id = ? AND grain = '5m' AND start >= ? AND start < ? ORDER BY start")
      .bind(userId, start, start + 3_600_000)
      .all<{ start: number; title: string | null; sources: string | null }>();
    if (!blocks.length) continue;
    try {
      const t = await writeTitle(
        env,
        "You title one hour of someone's day from the titles of its five-minute stretches. Lead with what mattered; skip background noise unless it's all there was.",
        blocks.map((b) => `${clock(b.start, timeZone)} ${b.title ?? "(untitled)"} [${b.sources}]`).join("\n"),
      );
      const sources = [...new Set(blocks.flatMap((b) => (b.sources ?? "").split(",")).filter(Boolean))].sort().join(",");
      await upsert(db, userId, "hour", hour, start, t, sources, blocks.length);
      days.set(`${userId}|${hour.slice(0, 10)}`, { userId, day: hour.slice(0, 10), timeZone });
    } catch (err) {
      console.error("transcripts: couldn't title an hour", err);
    }
  }

  for (const { userId, day, timeZone } of days.values()) {
    const [from, to] = dayRange(day, timeZone);
    const existing = await db
      .prepare("SELECT updated_at FROM transcript_titles WHERE user_id = ? AND grain = 'day' AND bucket = ?")
      .bind(userId, day)
      .first<{ updated_at: number }>();
    // Today is still being lived: its summary is rewritten now and then, not after every block.
    if (existing && now < to && now - existing.updated_at < DAY_REFRESH_MS) continue;
    const { results: hoursOfDay } = await db
      .prepare("SELECT start, title, summary FROM transcript_titles WHERE user_id = ? AND grain = 'hour' AND start >= ? AND start < ? ORDER BY start")
      .bind(userId, from, to)
      .all<{ start: number; title: string | null; summary: string | null }>();
    if (!hoursOfDay.length) continue;
    try {
      const t = await writeTitle(
        env,
        "You title a whole day from its hours. The title says what the day was; the summary gives the two or three things worth remembering from it.",
        hoursOfDay.map((h) => `${clock(h.start, timeZone)} ${h.title ?? ""} — ${h.summary ?? ""}`).join("\n"),
      );
      await upsert(db, userId, "day", day, from, t, "", hoursOfDay.length);
    } catch (err) {
      console.error("transcripts: couldn't title a day", err);
    }
  }
  return due.length;
}

// ---------- Reading ----------

async function tzOf(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  return validTimeZone(row?.time_zone);
}

/** A day: its title, then each hour with its title and its five-minute blocks (titled or not yet). */
export async function transcriptDay(db: D1Database, userId: string, day: string, timeZone: string) {
  const [from, to] = dayRange(day, timeZone);
  const [dayRow, { results: titles }, { results: counts }] = await Promise.all([
    db.prepare("SELECT title, summary FROM transcript_titles WHERE user_id = ? AND grain = 'day' AND bucket = ?").bind(userId, day).first<{
      title: string | null;
      summary: string | null;
    }>(),
    db
      .prepare("SELECT grain, bucket, start, title, summary, sources FROM transcript_titles WHERE user_id = ? AND grain IN ('5m', 'hour') AND start >= ? AND start < ?")
      .bind(userId, from, to)
      .all<{ grain: string; bucket: string; start: number; title: string | null; summary: string | null; sources: string | null }>(),
    db
      .prepare(
        `SELECT (ts / ${BLOCK_MS}) * ${BLOCK_MS} AS start, COUNT(*) AS lines, GROUP_CONCAT(DISTINCT source) AS sources
           FROM raw_captures WHERE user_id = ? AND ts >= ? AND ts < ? GROUP BY start ORDER BY start`,
      )
      .bind(userId, from, to)
      .all<{ start: number; lines: number; sources: string }>(),
  ]);

  const blockTitles = new Map(titles.filter((t) => t.grain === "5m").map((t) => [t.start, t]));
  const hourTitles = new Map(titles.filter((t) => t.grain === "hour").map((t) => [t.bucket, t]));
  const hours = new Map<string, { hour: string; start: number; label: string; title: string | null; summary: string | null; blocks: unknown[] }>();
  for (const c of counts) {
    const hour = buckets(c.start, timeZone).hour;
    let h = hours.get(hour);
    if (!h) {
      const t = hourTitles.get(hour);
      h = {
        hour,
        start: atLocalTime(day, Number(hour.slice(11, 13)) * 60, timeZone),
        label: clock(atLocalTime(hour.slice(0, 10), Number(hour.slice(11, 13)) * 60, timeZone), timeZone),
        title: t?.title ?? null,
        summary: t?.summary ?? null,
        blocks: [],
      };
      hours.set(hour, h);
    }
    const t = blockTitles.get(c.start);
    h.blocks.push({
      start: c.start,
      at: clock(c.start, timeZone),
      title: t?.title ?? null,
      summary: t?.summary ?? null,
      lines: c.lines,
      sources: c.sources.split(",").sort(),
    });
  }
  return { date: day, title: dayRow?.title ?? null, summary: dayRow?.summary ?? null, hours: [...hours.values()] };
}

export async function transcriptLines(db: D1Database, userId: string, from: number, to: number) {
  const { results } = await db
    .prepare("SELECT id, ts, text, source FROM raw_captures WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 500")
    .bind(userId, from, to)
    .all<{ id: string; ts: number; text: string; source: LineSource }>();
  return results;
}

export async function searchTranscripts(db: D1Database, userId: string, q: string) {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  if (!words.length) return [];
  const { results } = await db
    .prepare(
      `SELECT id, ts, text, source FROM raw_captures WHERE user_id = ? AND ${words.map(() => "lower(text) LIKE ?").join(" AND ")} ORDER BY ts DESC LIMIT 50`,
    )
    .bind(userId, ...words.map((w) => `%${w}%`))
    .all<{ id: string; ts: number; text: string; source: LineSource }>();
  return results;
}

// ---------- Routes ----------

export const transcripts = new Hono<{ Bindings: Env; Variables: Vars }>();

transcripts.get("/transcripts/day/:date", async (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "Bad date" }, 400);
  const timeZone = validTimeZone(c.req.query("timeZone") ?? (await tzOf(c.env.DB, c.var.userId)));
  return c.json(await transcriptDay(c.env.DB, c.var.userId, date, timeZone));
});

transcripts.get("/transcripts/lines", async (c) => {
  const from = Number(c.req.query("from"));
  const to = Number(c.req.query("to"));
  if (!(from > 0 && to > from)) return c.json({ error: "from and to are required" }, 400);
  return c.json({ lines: await transcriptLines(c.env.DB, c.var.userId, from, Math.min(to, from + 86_400_000)) });
});

transcripts.get("/transcripts/search", async (c) => {
  return c.json({ lines: await searchTranscripts(c.env.DB, c.var.userId, c.req.query("q") ?? "") });
});

/** "Forget that": the lines in a span, and the titles written from them. */
transcripts.delete("/transcripts", async (c) => {
  const from = Number(c.req.query("from"));
  const to = Number(c.req.query("to"));
  if (!(from > 0 && to > from)) return c.json({ error: "from and to are required" }, 400);
  const db = c.env.DB;
  const { meta } = await db.prepare("DELETE FROM raw_captures WHERE user_id = ? AND ts >= ? AND ts < ?").bind(c.var.userId, from, to).run();
  // The timeline entries written from those words go too.
  await db
    .prepare(
      `DELETE FROM context_blocks WHERE user_id = ? AND id IN (
         SELECT block_id FROM transcript_titles WHERE user_id = ? AND grain = '5m' AND start >= ? AND start < ? AND block_id IS NOT NULL)`,
    )
    .bind(c.var.userId, c.var.userId, blockStart(from), to)
    .run();
  await db.prepare("DELETE FROM transcript_titles WHERE user_id = ? AND grain = '5m' AND start >= ? AND start < ?").bind(c.var.userId, blockStart(from), to).run();
  return c.json({ ok: true, forgot: meta.changes ?? 0 });
});

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "transcript_day",
    description:
      "What was said on a day, hour by hour, with a title for every five minutes. For 'what did I talk about this morning', 'what happened today'. Covers the last 14 days.",
    parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; leave out for today." } } },
  },
  {
    name: "transcript_between",
    description: "The exact words said in a stretch of time, for 'what did I say around 3pm', 'what was that about the car earlier'.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; leave out for today." },
        from: { type: "string", description: "HH:MM, 24-hour." },
        to: { type: "string", description: "HH:MM, 24-hour." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "transcript_search",
    description: "Finds lines anyone said that contain some words, across the last 14 days.",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isTranscriptTool = (name: string) => NAMES.has(name);

const hm = (v: unknown) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function transcriptAssistant(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const today = () => buckets(Date.now(), timeZone).day;
  const dayOf = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : today());
  const line = (l: { ts: number; text: string; source: string }) => `[${clock(l.ts, timeZone)}] ${SOURCE_LABEL[l.source] ?? l.source}: ${l.text}`;

  const callTool: CallTool = async (name, args) => {
    if (name === "transcript_day") {
      const d = await transcriptDay(db, userId, dayOf(args.date), timeZone);
      if (!d.hours.length) return { date: d.date, nothing: "No transcript for that day." };
      return {
        date: d.date,
        title: d.title,
        summary: d.summary,
        hours: d.hours.map((h) => ({
          hour: h.label,
          title: h.title,
          blocks: (h.blocks as { at: string; title: string | null }[]).map((b) => `${b.at} ${b.title ?? "(not titled yet)"}`),
        })),
      };
    }
    if (name === "transcript_between") {
      const day = dayOf(args.date);
      const from = hm(args.from);
      const to = hm(args.to);
      if (from === null || to === null || to <= from) return { error: "from and to must be HH:MM, from before to" };
      const lines = await transcriptLines(db, userId, atLocalTime(day, from, timeZone), atLocalTime(day, to, timeZone));
      return lines.length ? { lines: lines.map(line) } : { nothing: "Nothing was said then." };
    }
    if (name === "transcript_search") {
      const found = await searchTranscripts(db, userId, String(args.q ?? ""));
      return found.length
        ? { lines: found.map((l) => `${buckets(l.ts, timeZone).day} ${line(l)}`) }
        : { nothing: "No line with those words." };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt:
      "You keep a transcript of what was said, titled every five minutes, every hour and every day, for 14 days. Read it with transcript_day, transcript_between and transcript_search when they ask what was said or what happened. Lines marked Overheard were background.",
  };
}
