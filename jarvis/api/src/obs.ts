import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { isModelRefused } from "./llm";
import type { Env, Vars } from "./types";

// What the server knows about itself. See migrations/0029_observability.sql for
// why the tables are shaped the way they are.
//
// Three rules, and they are the reason this file exists rather than a handful
// of console.error calls:
//
//   1. Errors are counted, not listed. One row per fingerprint with a count,
//      because 166 copies of one failure is one sentence, not 166 rows.
//   2. Writing a log never fails the thing it records -- the same rule
//      actionlog.ts works to.
//   3. Everything is bounded. Rollups by the hour, pruned nightly: the purge
//      (retention.ts) deletes a row 14 days after it was last touched.

/** A request slower than this earns a row even though it succeeded. */
const SLOW_MS = 10_000;

/**
 * Routes too chatty to log when they work. The phone posts /logs every three
 * seconds (app/src/lib/remoteLog.ts), and a tail full of that is a tail nobody
 * reads. They are still recorded when they fail.
 */
const QUIET_ROUTES = new Set(["/logs", "/"]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * One line, one prefix. Every line the server writes starts "ovoa.<facet> " and
 * then key=value pairs, so `npx wrangler tail --format pretty | grep ovoa.err`
 * is a usable tool and the dashboard's text search finds a route by name.
 * Whitespace inside a value is replaced, so one event is always exactly one
 * line and grep never splits it in half.
 */
export function say(facet: string, fields: Record<string, unknown>) {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    pairs.push(`${key}=${typeof value === "number" ? value : String(value).replace(/\s+/g, "_").slice(0, 200)}`);
  }
  console.log(`ovoa.${facet} ${pairs.join(" ")}`);
}

export type ErrorKind = "error" | "stall" | "gone" | "engines_down" | "cron";

/**
 * The shape of an error, with everything that differs between two of the same
 * error taken out: ids, long numbers, quoted text, email addresses, and
 * anything past the first line.
 *
 * Short numbers are kept on purpose. "429", "402" and "4006" are the whole
 * content of an engine failure, and a fingerprint that threw them away would
 * merge "rate limited" with "out of credit".
 */
export function fingerprint(kind: string, route: string, message: string) {
  const shape = message
    .split("\n")[0]
    .replace(UUID, "<id>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d{5,}\b/g, "<n>")
    .trim()
    .slice(0, 200);
  return `${kind} ${route} ${shape}`;
}

export type ErrorRecord = {
  kind: ErrorKind;
  route: string;
  message: string;
  status?: number;
  stack?: string;
  requestId?: string;
  userId?: string | null;
  ms?: number;
};

/**
 * Writes one occurrence down. An upsert, so the hundredth copy of a failure
 * costs one row and one write, and `count` is the number the morning after
 * actually wants to know.
 */
export async function recordError(env: Env, e: ErrorRecord) {
  const message = e.message.slice(0, 500);
  const fp = fingerprint(e.kind, e.route, message);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO error_events (fingerprint, kind, route, status, message, stack, count, first_seen, last_seen,
                                 last_request_id, last_user_id, last_ms)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
            count           = count + 1,
            last_seen       = excluded.last_seen,
            status          = excluded.status,
            message         = excluded.message,
            stack           = excluded.stack,
            last_request_id = excluded.last_request_id,
            last_user_id    = excluded.last_user_id,
            last_ms         = excluded.last_ms`,
    )
      .bind(
        fp,
        e.kind,
        e.route.slice(0, 120),
        e.status ?? null,
        message,
        e.stack?.slice(0, 2000) ?? null,
        now,
        now,
        e.requestId ?? null,
        e.userId ?? null,
        e.ms ?? null,
      )
      .run();
  } catch (err) {
    // Rule 2. A 500 caused by the error log being busy is worse than a gap.
    console.error(`ovoa.err.write fp=${fp}`, err);
  }
}

/** waitUntil when there is one, inline when there isn't (a unit test, a direct call). */
function after(c: Context, work: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work.catch(() => {});
  }
}

/**
 * The route as it was registered ("/agent/jobs/:id"), so one row covers every
 * job and no id ends up in the log.
 *
 * routePath() reads c.req.routeIndex, which compose sets on each dispatch and
 * never resets, so after next() it names the deepest handler that actually ran.
 * A request the auth middleware refused never reaches a route handler and comes
 * back as "*"; for those the path is used instead with its ids taken out.
 */
export function labelFor(c: Context) {
  let path = "";
  try {
    path = routePath(c);
  } catch {
    path = "";
  }
  // Hono reports a wildcard middleware's own route as "/*", not "*", so the
  // original test never fired and every pre-route failure was filed under "/*".
  if (path && path !== "*" && path !== "/*") return path;
  return c.req.path.replace(UUID, ":id").replace(/\/\d+(?=\/|$)/g, "/:n").slice(0, 120);
}

/**
 * Every request in one line, and every failure in the table.
 *
 * Registered first, so the duration covers the whole request including cors and
 * auth. It reads c.error rather than wrapping next() in a try/catch, because
 * Hono hands a thrown error to app.onError one dispatch level below this and
 * sets context.error before it does (hono/dist/compose.js). A try/catch here
 * would run first and change which response the client gets.
 *
 * One thing this cannot measure: a streamed /chat returns its Response the
 * instant the stream is handed over, so the ms here is a few milliseconds and
 * the status is always 200. The turn's own timing is the ovoa.turn line, and
 * its failures come from streamTurn.
 */
export function observe(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const started = Date.now();
    // Cloudflare's own request id, sent to every Worker. Using it rather than a
    // fresh uuid means a row in error_events can be found in Workers Logs.
    const requestId = (c.req.header("cf-ray") ?? crypto.randomUUID()).slice(0, 40);
    c.set("requestId", requestId);
    await next();
    // A CORS preflight is not an event; logging it doubles the tail for nothing.
    if (c.req.method === "OPTIONS") return;
    const ms = Date.now() - started;
    const status = c.res.status;
    const route = labelFor(c);
    const userId = c.get("userId") as string | undefined;
    // A refusal (no plan, the day's spend used up, no consent) reaches
    // app.onError on routes that don't catch it, which sets c.error, but it's
    // an answer, not a fault: no failure line, no error row. Slow, it's a stall.
    const failed = (!!c.error && !isModelRefused(c.error)) || status >= 500;
    if (failed || ms >= SLOW_MS || !QUIET_ROUTES.has(route)) {
      say("req", { rid: requestId, m: c.req.method, route, status, ms, user: userId?.slice(0, 8) });
    }
    if (!failed && ms < SLOW_MS) return;
    after(
      c,
      recordError(c.env, {
        kind: failed ? "error" : "stall",
        route,
        status,
        ms,
        requestId,
        userId: userId ?? null,
        message: failed ? (c.error?.message ?? `${status} with no error attached`) : `slow: ${ms} ms`,
        stack: failed ? c.error?.stack : undefined,
      }),
    );
  };
}

/** UTC hour bucket, "2026-09-21T14". These rollups are for the operator, so UTC. */
const hourOf = (at: number) => new Date(at).toISOString().slice(0, 13);

export type EngineAttempt = { engine: string; model: string; outcome: string; ms: number; error?: string };

/**
 * Every engine attempt a turn made, rolled up by the hour. A turn tries up to
 * three engines and also reports the ones it skipped, so a bad hour is maybe a
 * dozen rows instead of thousands, and "which engine answered and which were
 * dead" stays one SELECT.
 */
export async function noteEngines(env: Env, attempts: EngineAttempt[]) {
  if (!attempts.length) return;
  const hour = hourOf(Date.now());
  const now = Date.now();
  const db = env.DB;
  try {
    await db.batch(
      attempts.map((a) =>
        db
          .prepare(
            `INSERT INTO engine_stats (hour, engine, model, outcome, n, ms_total, ms_max, last_error, last_at)
                  VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT(hour, engine, model, outcome) DO UPDATE SET
                  n          = n + 1,
                  ms_total   = ms_total + excluded.ms_total,
                  ms_max     = MAX(ms_max, excluded.ms_max),
                  last_error = COALESCE(excluded.last_error, last_error),
                  last_at    = excluded.last_at`,
          )
          .bind(hour, a.engine, a.model.slice(0, 80), a.outcome, a.ms, a.ms, a.error?.slice(0, 300) ?? null, now),
      ),
    );
  } catch (err) {
    console.error("ovoa.err.write engine_stats", err);
  }
}

/**
 * One tick of one cron. `ticks` is the heartbeat -- 30 in a complete hour on the
 * two-minute beat -- and `decided` is whatever that tick actually did, summed
 * into `did` and kept verbatim in `last_detail` when it was not empty.
 */
export async function noteTick(env: Env, cron: string, ms: number, decided: Record<string, number>, errors: number) {
  const busy = Object.entries(decided).filter(([, n]) => n > 0);
  const did = busy.reduce((n, [, v]) => n + v, 0);
  const detail = busy.length ? JSON.stringify(Object.fromEntries(busy)).slice(0, 500) : null;
  try {
    await env.DB.prepare(
      `INSERT INTO cron_ticks (hour, cron, ticks, did, errors, ms_total, ms_max, last_detail, last_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hour, cron) DO UPDATE SET
            ticks       = ticks + 1,
            did         = did + excluded.did,
            errors      = errors + excluded.errors,
            ms_total    = ms_total + excluded.ms_total,
            ms_max      = MAX(ms_max, excluded.ms_max),
            last_detail = COALESCE(excluded.last_detail, last_detail),
            last_at     = excluded.last_at`,
    )
      .bind(hourOf(Date.now()), cron.slice(0, 40), did, errors, ms, ms, detail, Date.now())
      .run();
  } catch (err) {
    console.error("ovoa.err.write cron_ticks", err);
  }
}

// ---------- Reading it back ----------

/**
 * Kinds whose `detail` may be returned. An allowlist, not a denylist: the first
 * version named the two kinds that happened to carry speech that week, and
 * `agent` (a reminder's label, the agent's own command), `res` (a whole reply
 * sentence) and `perf` (a turn's `heard "…"`) all walked straight past it. A
 * kind that is not named here is withheld, so the next one added is too.
 *
 * `req` is deliberately absent: the app puts the request body in a req row's
 * detail, and on /chat the request body is the sentence the user just spoke.
 */
const DETAIL_OK = new Set(["err", "warn", "file", "ble", "probe", "nav"]);

/** True when this kind's detail must not leave the server. */
export const withholdsDetail = (kind: string) => !DETAIL_OK.has(kind);

/** The kinds that carry what somebody said. Kept for the tests that name them. */
export const SPEECH_KINDS = new Set(["voice", "log", "agent", "res", "perf"]);

const SECRETS: [RegExp, string][] = [
  [/\bBearer\s+[\w.\-]+/gi, "Bearer …"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "<jwt>"],
  [/ExponentPushToken\[[^\]]*\]/g, "ExponentPushToken[…]"],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, "<key>"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "<key>"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>"],
  // Session tokens, password hashes and salts are all long unbroken runs.
  [/\b[A-Za-z0-9_-]{32,}\b/g, "<long>"],
];

/**
 * What is safe to hand back over HTTP.
 *
 * Everything quoted goes first, because that is exactly how the app writes down
 * what it heard: `heard: "call my mother at four"` (app/src/lib/voice.ts). Then
 * anything token-shaped. What is left is the shape of what happened, which is
 * what debugging needs and is not a transcript.
 */
export function scrub(text: string | null | undefined) {
  if (!text) return null;
  let out = text.replace(/"[^"]*"/g, '"…"').replace(/'[^']{12,}'/g, "'…'");
  for (const [re, mask] of SECRETS) out = out.replace(re, mask);
  return out.slice(0, 500);
}

/** "30m", "6h", "2d", or a plain epoch. An hour by default. */
export function sinceFrom(raw: string | undefined) {
  const hour = Date.now() - 3_600_000;
  if (!raw) return hour;
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    return Date.now() - Math.min(Number(m[1]) * unit, 30 * 86_400_000);
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : hour;
}
