import { Hono } from "hono";
import { z } from "zod";
import { validTimeZone } from "./google/assistant";
import { digestBlock, type Extracted } from "./people";
import { generateText, isModelRefused, type CallTool, type ToolSpec } from "./llm";
import { atLocalTime, buckets, clock, dayRange } from "./time";
import { blockedFor } from "./plans";
import type { Env, Vars } from "./types";

// Transcripts: everything said, titled every five minutes, every hour, every
// day. See migrations/0022_captures.sql.
//
// Kept 14 days (retention.ts, docs/retention.md), except a recording made on
// purpose (source 'recording'): its words stay until the user deletes them. A
// day's title row turns into the day's summary once the nightly writer has done
// it (daysummary.ts, summarised_at), and outlives the rest; the titler below
// leaves a summarised day alone.
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
/** The longest line kept (storeLine and storeLines cut there). */
export const LINE_MAX = 4000;

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
    .bind(crypto.randomUUID(), userId, ts, clean.slice(0, LINE_MAX), source)
    .run();
  return true;
}

/**
 * A long text as lines of at most LINE_MAX, so none of it is cut: a
 * recording's transcript can be 20,000 characters (POST /context/blocks).
 * Split after a sentence where there's one in the second half of the stretch,
 * else at a space, else where it has to be.
 */
export function linesOf(text: string, max = LINE_MAX) {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const stretch = rest.slice(0, max + 1);
    const sentence = Math.max(stretch.lastIndexOf(". "), stretch.lastIndexOf("? "), stretch.lastIndexOf("! "));
    let cut = sentence >= max / 2 ? sentence + 1 : stretch.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The same, for a batch: one settings read and one write instead of a round trip
 * per sentence. The phone overhears far more than it answers, and all of it has
 * to be cheap or none of it is worth keeping.
 */
export async function storeLines(
  db: D1Database,
  userId: string,
  lines: { text: string; ts: number }[],
  source: LineSource,
) {
  const clean = lines
    .map((l) => ({ text: l.text.trim().slice(0, LINE_MAX), ts: l.ts }))
    .filter((l) => l.text);
  if (!clean.length) return 0;
  const s = await db
    .prepare("SELECT context_enabled, capture_everything FROM settings WHERE user_id = ?")
    .bind(userId)
    .first<{ context_enabled: number; capture_everything: number }>();
  const allowed = source === "background" ? !!s?.capture_everything : !!(s?.context_enabled || s?.capture_everything);
  if (!allowed) return 0;
  await db.batch(
    clean.map((l) =>
      db
        .prepare("INSERT INTO raw_captures (id, user_id, ts, text, source) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), userId, l.ts, l.text, source),
    ),
  );
  return clean.length;
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

async function writeTitle(env: Env, userId: string, system: string, body: string, schema: Record<string, unknown> = titleSchema) {
  const raw = await generateText(env, {
    model: env.MEMORY_MODEL,
    fast: true,
    usage: { userId, purpose: "transcripts" },
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

/** Writes a title. Never over a day's summary (daysummary.ts), which covers more than the words. */
async function upsert(db: D1Database, userId: string, grain: string, bucket: string, start: number, t: { title: string | null; summary: string | null }, sources: string, covers: number) {
  await db
    .prepare(
      `INSERT INTO transcript_titles (user_id, grain, bucket, start, title, summary, sources, covers, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, grain, bucket) DO UPDATE SET title = excluded.title, summary = excluded.summary,
         sources = excluded.sources, covers = excluded.covers, updated_at = excluded.updated_at
       WHERE transcript_titles.summarised_at IS NULL`,
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
  // Titles are written by a model, which is Base's (plans.ts). Asked once per person per tick.
  const blocked = new Map<string, Promise<Awaited<ReturnType<typeof blockedFor>>>>();
  for (const b of due) {
    const timeZone = validTimeZone(b.time_zone);
    if (!blocked.has(b.user_id)) blocked.set(b.user_id, blockedFor(env, b.user_id, "base"));
    const why = await blocked.get(b.user_id);
    if (why === "plan" || why === "consent") {
      // No plan with AI, or no consent to send words to one: filed untitled, so
      // it stops coming back as due and holding up everyone else's blocks
      // behind it. The words are still there to read.
      await upsert(db, b.user_id, "5m", new Date(b.start).toISOString(), b.start, { title: null, summary: null }, "", b.n);
      continue;
    }
    // Over today's allowance: left due, and titled tomorrow.
    if (why) continue;
    const { results: lines } = await db
      .prepare("SELECT ts, text, source FROM raw_captures WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
      .bind(b.user_id, b.start, b.start + BLOCK_MS)
      .all<{ ts: number; text: string; source: string }>();
    const sources = [...new Set(lines.map((l) => l.source))].sort().join(",");
    try {
      const t = await writeTitle(
        env,
        b.user_id,
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
      // Refused by the gate (plans.ts modelGate): left due, like the allowance case above.
      if (!isModelRefused(err)) console.error("transcripts: couldn't title a block", err);
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
        userId,
        "You title one hour of someone's day from the titles of its five-minute stretches. Lead with what mattered; skip background noise unless it's all there was.",
        blocks.map((b) => `${clock(b.start, timeZone)} ${b.title ?? "(untitled)"} [${b.sources}]`).join("\n"),
      );
      const sources = [...new Set(blocks.flatMap((b) => (b.sources ?? "").split(",")).filter(Boolean))].sort().join(",");
      await upsert(db, userId, "hour", hour, start, t, sources, blocks.length);
      days.set(`${userId}|${hour.slice(0, 10)}`, { userId, day: hour.slice(0, 10), timeZone });
    } catch (err) {
      if (!isModelRefused(err)) console.error("transcripts: couldn't title an hour", err);
    }
  }

  for (const { userId, day, timeZone } of days.values()) {
    const [from, to] = dayRange(day, timeZone);
    const existing = await db
      .prepare("SELECT updated_at, summarised_at FROM transcript_titles WHERE user_id = ? AND grain = 'day' AND bucket = ?")
      .bind(userId, day)
      .first<{ updated_at: number; summarised_at: number | null }>();
    // The day's summary is written; a late line doesn't get a model call to be thrown away.
    if (existing?.summarised_at) continue;
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
        userId,
        "You title a whole day from its hours. The title says what the day was; the summary gives the two or three things worth remembering from it.",
        hoursOfDay.map((h) => `${clock(h.start, timeZone)} ${h.title ?? ""} — ${h.summary ?? ""}`).join("\n"),
      );
      await upsert(db, userId, "day", day, from, t, "", hoursOfDay.length);
    } catch (err) {
      if (!isModelRefused(err)) console.error("transcripts: couldn't title a day", err);
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

const heardSchema = z.object({
  lines: z
    .array(z.object({ ts: z.number().int().positive(), text: z.string().trim().min(1).max(4000) }))
    .max(200),
});

/**
 * Everything the phone overheard and decided was not for the assistant. Until
 * now that was written to the device log and dropped, so "what did I say today"
 * could only answer from the handful of sentences addressed to OVOA. storeLines
 * still enforces the setting: nothing is kept unless capture-everything is on,
 * which is a development flag for one named account (index.ts, isDevAccount).
 */
transcripts.post("/transcripts/heard", async (c) => {
  const parsed = heardSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid lines" }, 400);
  return c.json({ kept: await storeLines(c.env.DB, c.var.userId, parsed.data.lines, "background") });
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
      "What was said on a day, hour by hour, with a title for every five minutes. For 'what did I talk about this morning', 'what happened today'. Covers the last 14 days; before that, only the day's summary and recordings made on purpose.",
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
    description: "Finds lines anyone said that contain some words, across the last 14 days and every recording they made on purpose.",
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
      if (!d.hours.length) {
        // Past 14 days the words are gone and the day is its summary (daysummary.ts).
        return d.title || d.summary
          ? { date: d.date, title: d.title, summary: d.summary, note: "Only the day's summary is kept after 14 days." }
          : { date: d.date, nothing: "No transcript for that day." };
      }
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
      "You keep a transcript of what was said, titled every five minutes, every hour and every day, for 14 days; after that a day keeps only its summary, and recordings they made on purpose keep their words. Read it with transcript_day, transcript_between and transcript_search when they ask what was said or what happened. Lines marked Overheard were background.",
  };
}
