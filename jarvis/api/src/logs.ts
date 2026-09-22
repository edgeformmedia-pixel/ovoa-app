import { Hono } from "hono";
import { z } from "zod";
import { isMeantForAssistant } from "./ambient";
import { sessionForToken } from "./auth";
import { scrub, sinceFrom, SPEECH_KINDS } from "./obs";
import type { Env } from "./types";

// The app uploads its log here every few seconds. Public on purpose, so crashes
// before sign-in still arrive; a bearer token, when sent, tags the rows with the user.

export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most rows one device may store in an hour. The app collapses repeats now
 * (app/src/lib/devlog.ts), so a phone on a current build writes a few hundred
 * lines a day — but a build already on someone's phone does not, and one of
 * them wrote 7,150 copies of a single line in a day (device_logs, 2026-09-21).
 * This is the only thing standing between that build and the table until every
 * tester updates.
 */
const MAX_ROWS_PER_HOUR = 2000;

/**
 * Devices being throttled, and until when. Per isolate, which is enough: it
 * saves the count on the common case and a cold isolate simply counts once.
 */
const throttledUntil = new Map<string, number>();

const uploadSchema = z.object({
  deviceId: z.string().min(8).max(64),
  sessionId: z.string().min(4).max(64),
  build: z.string().max(64).optional(),
  /** What was true of the phone for this whole batch: app state, reachability, free disk. */
  context: z.string().max(1000).optional(),
  entries: z
    .array(
      z.object({
        time: z.number().int(),
        kind: z.string().max(16),
        text: z.string().max(1000),
        detail: z.string().max(4000).optional(),
        // Everything below is optional so a build still on a tester's phone keeps working.
        level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
        /** How many identical lines this row stands for: the app collapses repeats. */
        count: z.number().int().min(1).max(10_000_000).optional(),
        /** Gapless within one session, so a hole here means an upload never arrived. */
        seq: z.number().int().optional(),
        route: z.string().max(120).optional(),
        state: z.string().max(16).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const logs = new Hono<{ Bindings: Env }>();

/**
 * How many rows this device has stored in the last hour, and whether that is
 * already too many. Indexed by device_logs_device (device_id, time).
 */
async function overTheLimit(env: Env, deviceId: string, now: number) {
  const until = throttledUntil.get(deviceId);
  if (until && until > now) return true;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM device_logs WHERE device_id = ? AND received_at > ?")
    .bind(deviceId, now - 3_600_000)
    .first<{ n: number }>();
  if ((row?.n ?? 0) < MAX_ROWS_PER_HOUR) return false;
  // Held off for ten minutes, then counted again: the hour is a rolling window,
  // so a device that stops flooding gets back in without waiting the full hour.
  throttledUntil.set(deviceId, now + 10 * 60_000);
  console.log(`ovoa.logs.throttled device=${deviceId.slice(0, 12)} rows=${row?.n ?? 0} cap=${MAX_ROWS_PER_HOUR}`);
  return true;
}

logs.post("/logs", async (c) => {
  const parsed = uploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid logs" }, 400);
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const session = token ? await sessionForToken(c.env.DB, token).catch(() => null) : null;
  const { deviceId, sessionId, build, context, entries } = parsed.data;
  const now = Date.now();
  const db = c.env.DB;
  // 200 OK on purpose: the phone is not at fault and must not keep retrying a
  // batch we are deliberately declining. It drops them and carries on.
  if (await overTheLimit(c.env, deviceId, now).catch(() => false)) {
    return c.json({ ok: true, stored: 0, throttled: true, cap: MAX_ROWS_PER_HOUR });
  }
  await db.batch([
    ...entries.map((e) =>
      db
        .prepare(
          "INSERT INTO device_logs (device_id, user_id, session_id, app_build, time, kind, text, detail, received_at, level, count, seq, route, app_state, context) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          deviceId,
          session?.userId ?? null,
          sessionId,
          build ?? null,
          e.time,
          e.kind,
          e.text,
          e.detail ?? null,
          now,
          e.level ?? null,
          e.count ?? 1,
          e.seq ?? null,
          e.route ?? null,
          e.state ?? null,
          context ?? null,
        ),
    ),
    // Roughly 1 upload in 50 also clears out old rows.
    ...(Math.random() < 0.02 ? [db.prepare("DELETE FROM device_logs WHERE received_at < ?").bind(now - KEEP_MS)] : []),
  ]);
  return c.json({ ok: true, stored: entries.length });
});

/** Checks the always-listening gate on a sentence, without any user's history. Needs the DEBUG_KEY secret. */
logs.post("/debug/ambient", async (c) => {
  if (!c.env.DEBUG_KEY || c.req.header("x-debug-key") !== c.env.DEBUG_KEY) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  if (!body?.text) return c.json({ error: "text is required" }, 400);
  const started = Date.now();
  const addressed = await isMeantForAssistant(c.env, null, body.text, "OVOA");
  return c.json({ addressed, ms: Date.now() - started });
});

/**
 * The logs, without D1 credentials.
 *
 *   GET /debug/logs?since=2h&kind=err&text=chat&limit=100&detail=1
 *   (header: x-debug-key)
 *
 * Everything the phone uploaded and everything the server wrote down, in one
 * answer, so "the phone said X at 14:03" sits next to "the server threw Y at
 * 14:03". The alternative was `wrangler d1 execute` from a machine with the
 * right Cloudflare login, which on 2026-09-21 was the only way to learn that
 * 166 "couldn't get a reply" meant every engine was out of credit at once.
 *
 * SELECT only, and nothing here writes. What it will not return: the words.
 * device_logs carries what the user said out loud -- `heard: "..."` in `text`,
 * and the whole reply in `detail` (app/src/lib/voice.ts) -- so text is scrubbed
 * of anything quoted, `detail` is withheld unless asked for, and it is never
 * returned at all for the kinds that carry speech. Token-shaped strings and
 * long unbroken runs (session tokens, password hashes, salts) are masked
 * wherever they appear.
 */
logs.get("/debug/logs", async (c) => {
  if (!c.env.DEBUG_KEY || c.req.header("x-debug-key") !== c.env.DEBUG_KEY) return c.json({ error: "Not found" }, 404);
  const db = c.env.DB;
  const since = sinceFrom(c.req.query("since"));
  const kind = c.req.query("kind")?.slice(0, 16) || null;
  const needle = c.req.query("text")?.slice(0, 80) || null;
  const like = needle ? `%${needle}%` : null;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
  const wantDetail = c.req.query("detail") === "1";

  const [device, errors, engines, cron] = await Promise.all([
    db
      .prepare(
        `SELECT time, kind, level, count, text, detail, app_build, session_id, substr(device_id, 1, 12) AS device
           FROM device_logs
          WHERE time >= ?
            AND (?2 IS NULL OR kind = ?2)
            AND (?3 IS NULL OR text LIKE ?3)
          ORDER BY time DESC LIMIT ?4`,
      )
      .bind(since, kind, like, limit)
      .all<{
        time: number;
        kind: string;
        level: string | null;
        count: number;
        text: string;
        detail: string | null;
        app_build: string | null;
        session_id: string;
        device: string;
      }>(),
    db
      .prepare(
        `SELECT fingerprint, kind, route, status, message, stack, count, first_seen, last_seen, last_ms, last_request_id
           FROM error_events
          WHERE last_seen >= ?
            AND (?2 IS NULL OR kind = ?2)
            AND (?3 IS NULL OR message LIKE ?3 OR route LIKE ?3)
          ORDER BY last_seen DESC LIMIT 100`,
      )
      .bind(since, kind, like)
      .all<{ message: string; stack: string | null; count: number }>(),
    db
      .prepare(
        `SELECT hour, engine, model, outcome, n, ms_total / n AS ms_avg, ms_max, last_error, last_at
           FROM engine_stats WHERE last_at >= ? ORDER BY hour DESC, engine LIMIT 200`,
      )
      .bind(since)
      .all<{ last_error: string | null }>(),
    db
      .prepare(
        `SELECT hour, cron, ticks, did, errors, ms_max, last_detail, last_at
           FROM cron_ticks WHERE last_at >= ? ORDER BY hour DESC LIMIT 48`,
      )
      .bind(since)
      .all<{ cron: string; ticks: number; last_at: number }>(),
  ]);

  // The beat, in one number. A lastTickMs over a few minutes on the two-minute
  // cron means it stopped, which nothing in device_logs would ever show.
  const beat = cron.results.find((r) => r.cron.startsWith("*/2"));
  return c.json({
    now: Date.now(),
    since,
    health: {
      lastTickMs: beat ? Date.now() - beat.last_at : null,
      ticksThisHour: beat?.ticks ?? 0,
      errorKinds: errors.results.length,
      loudest: errors.results.slice().sort((a, b) => b.count - a.count)[0] ?? null,
    },
    device: device.results.map((r) => ({
      time: r.time,
      kind: r.kind,
      level: r.level,
      count: r.count,
      text: scrub(r.text),
      // Only when asked for, and never for a kind that carries speech:
      // "asking the assistant" puts the whole sentence in detail.
      ...(wantDetail && !SPEECH_KINDS.has(r.kind) && r.detail ? { detail: scrub(r.detail) } : {}),
      build: r.app_build,
      session: r.session_id,
      device: r.device,
    })),
    errors: errors.results.map((r) => ({
      ...r,
      message: scrub(r.message),
      stack: wantDetail ? scrub(r.stack) : undefined,
    })),
    engines: engines.results.map((r) => ({ ...r, last_error: scrub(r.last_error) })),
    cron: cron.results,
  });
});
