import type { LlmUsage } from "./llm";
import { llmCostMicro, sttCostMicro, ttsCostMicro, type TokenPrice, usd } from "./pricing";

// What each person's day cost, written down as it happens.
//
// See migrations/0033_usage.sql for why the table is shaped the way it is.
// Three rules, the same ones obs.ts works to:
//
//   1. Rolled up, not listed. One row per (person, day, kind, engine, model),
//      added to in place. A busy day is dozens of rows, never thousands.
//   2. Writing a row never fails the request it describes. A turn that was
//      answered but not counted is a gap in a report; a turn that failed
//      because the counter was busy is a person left waiting.
//   3. Bounded. Ninety days, pruned nightly.
//
// The dollar figure on each row is an estimate at list price (pricing.ts),
// worked out when the row is written so the report needs no price history.

export type UsageKind = "turn" | "llm_call" | "tts" | "stt_stream" | "stt_clip" | "search";

export type UsageRow = {
  /** The person, or null for work done for nobody in particular. */
  userId: string | null;
  kind: UsageKind;
  engine?: string;
  model?: string;
  /** Calls, turns, clips, searches. */
  n?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  chars?: number;
  seconds?: number;
  /** Cost in millionths of a dollar. Worked out by the helpers below. */
  microUsd?: number;
  /** When it happened; the row lands on this day (UTC). */
  at?: number;
};

/** UTC day, 'YYYY-MM-DD'. Days are the operator's days, like the other rollups. */
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Adds rows to the day's totals. A batch, so one turn's model calls, voiced
 * sentences and turn row cost one round trip. Never throws.
 */
export async function recordUsage(env: { DB: D1Database }, rows: UsageRow[]) {
  if (!rows.length) return;
  const now = Date.now();
  const db = env.DB;
  try {
    await db.batch(
      rows.map((r) =>
        db
          .prepare(
            `INSERT INTO usage_daily (user_id, day, kind, engine, model, n, input_tokens, cached_tokens, output_tokens, chars, seconds, est_micro_usd, last_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, day, kind, engine, model) DO UPDATE SET
                  n             = n + excluded.n,
                  input_tokens  = input_tokens + excluded.input_tokens,
                  cached_tokens = cached_tokens + excluded.cached_tokens,
                  output_tokens = output_tokens + excluded.output_tokens,
                  chars         = chars + excluded.chars,
                  seconds       = seconds + excluded.seconds,
                  est_micro_usd = est_micro_usd + excluded.est_micro_usd,
                  last_at       = excluded.last_at`,
          )
          .bind(
            r.userId ?? "",
            dayOf(r.at ?? now),
            r.kind,
            (r.engine ?? "").slice(0, 40),
            (r.model ?? "").slice(0, 80),
            whole(r.n ?? 1),
            whole(r.inputTokens),
            whole(r.cachedTokens),
            whole(r.outputTokens),
            whole(r.chars),
            Math.max(0, Number(r.seconds) || 0),
            whole(r.microUsd),
            r.at ?? now,
          ),
      ),
    );
  } catch (err) {
    // Rule 2.
    console.error("ovoa.err.write usage_daily", err);
  }
}

/** A non-negative integer, whatever arrived. */
const whole = (n: number | undefined) => Math.max(0, Math.round(Number(n) || 0));

// ---------- Rows for each kind of spend ----------

/** One model call, from the engine's own usage counts (llm.ts reports them; this prices them). */
export function llmRow(userId: string | null, u: LlmUsage, glmPrice?: TokenPrice): UsageRow {
  const tokens = { input: u.inputTokens, cached: u.cachedTokens, output: u.outputTokens };
  return {
    userId,
    kind: "llm_call",
    engine: u.engine,
    model: u.model,
    n: 1,
    inputTokens: u.inputTokens,
    cachedTokens: u.cachedTokens,
    outputTokens: u.outputTokens,
    // GLM's price is the user's provider's price, not the table's (pricing.ts).
    microUsd: llmCostMicro(u.model, tokens, new Date(), (u.engine as string) === "glm" ? glmPrice : undefined),
  };
}

export function ttsRow(userId: string | null, engine: string, voice: string, chars: number): UsageRow {
  return { userId, kind: "tts", engine, model: voice, n: 1, chars, microUsd: ttsCostMicro(engine, chars) };
}

export function sttClipRow(userId: string | null, engine: string, seconds: number): UsageRow {
  return { userId, kind: "stt_clip", engine, n: 1, seconds, microUsd: sttCostMicro(engine, seconds) };
}

export function sttStreamRow(userId: string | null, engine: string, seconds: number, connections: number): UsageRow {
  return { userId, kind: "stt_stream", engine, n: connections, seconds, microUsd: sttCostMicro(engine, seconds) };
}

export function searchRow(userId: string | null, engine: string): UsageRow {
  return { userId, kind: "search", engine, n: 1 };
}

export function turnRow(userId: string, engine: string, voice: boolean): UsageRow {
  return { userId, kind: "turn", engine, model: voice ? "voice" : "text", n: 1 };
}

// ---------- Reading it back ----------

/** A day's totals for one person, summed across engines. */
export type DayTotals = {
  day: string;
  turns: number;
  llmCalls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ttsChars: number;
  streamSeconds: number;
  clipSeconds: number;
  searches: number;
  microUsd: number;
  /** The same cost, split by what it was spent on. */
  by: Record<string, number>;
};

type Row = {
  user_id: string;
  day: string;
  kind: UsageKind;
  engine: string;
  model: string;
  n: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  chars: number;
  seconds: number;
  est_micro_usd: number;
};

function emptyDay(day: string): DayTotals {
  return {
    day,
    turns: 0,
    llmCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    ttsChars: 0,
    streamSeconds: 0,
    clipSeconds: 0,
    searches: 0,
    microUsd: 0,
    by: {},
  };
}

/** Folds one table row into a day's totals. Exported for the unit test. */
export function foldRow(into: DayTotals, r: Row) {
  switch (r.kind) {
    case "turn":
      into.turns += r.n;
      break;
    case "llm_call":
      into.llmCalls += r.n;
      into.inputTokens += r.input_tokens;
      into.cachedTokens += r.cached_tokens;
      into.outputTokens += r.output_tokens;
      break;
    case "tts":
      into.ttsChars += r.chars;
      break;
    case "stt_stream":
      into.streamSeconds += r.seconds;
      break;
    case "stt_clip":
      into.clipSeconds += r.seconds;
      break;
    case "search":
      into.searches += r.n;
      break;
  }
  into.microUsd += r.est_micro_usd;
  if (r.est_micro_usd) {
    const label = r.kind === "llm_call" ? `ai (${r.engine})` : r.kind === "tts" ? `voice (${r.engine})` : r.kind === "stt_stream" ? "mic" : r.kind === "stt_clip" ? "clips" : r.kind;
    into.by[label] = (into.by[label] ?? 0) + r.est_micro_usd;
  }
  return into;
}

/** Everyone's days since `fromDay`, for the operator. Newest first within each person. */
export async function usageByPerson(db: D1Database, fromDay: string) {
  const { results } = await db
    .prepare(
      `SELECT u.user_id, u.day, u.kind, u.engine, u.model, u.n, u.input_tokens, u.cached_tokens, u.output_tokens,
              u.chars, u.seconds, u.est_micro_usd, p.name
         FROM usage_daily u LEFT JOIN users p ON p.id = u.user_id
        WHERE u.day >= ?
        ORDER BY u.user_id, u.day DESC`,
    )
    .bind(fromDay)
    .all<Row & { name: string | null }>();
  const people = new Map<string, { userId: string; name: string; days: Map<string, DayTotals> }>();
  for (const r of results) {
    const person = people.get(r.user_id) ?? { userId: r.user_id, name: r.name ?? (r.user_id ? "(deleted)" : "(server)"), days: new Map() };
    people.set(r.user_id, person);
    foldRow(person.days.get(r.day) ?? person.days.set(r.day, emptyDay(r.day)).get(r.day)!, r);
  }
  return [...people.values()].map((p) => {
    const days = [...p.days.values()];
    const total = days.reduce((t, d) => foldTotals(t, d), emptyDay("total"));
    return { userId: p.userId, name: p.name, days: days.map(describe), total: describe(total) };
  });
}

/** One person's own numbers: today and the month so far. For the app's Dev tools. */
export async function usageForPerson(db: D1Database, userId: string, now = Date.now()) {
  const today = dayOf(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const { results } = await db
    .prepare(
      `SELECT user_id, day, kind, engine, model, n, input_tokens, cached_tokens, output_tokens, chars, seconds, est_micro_usd
         FROM usage_daily WHERE user_id = ? AND day >= ?`,
    )
    .bind(userId, monthStart)
    .all<Row>();
  const day = emptyDay(today);
  const month = emptyDay(monthStart);
  for (const r of results) {
    if (r.day === today) foldRow(day, r);
    foldRow(month, r);
  }
  return { today: describe(day), month: describe(month) };
}

function foldTotals(into: DayTotals, d: DayTotals) {
  into.turns += d.turns;
  into.llmCalls += d.llmCalls;
  into.inputTokens += d.inputTokens;
  into.cachedTokens += d.cachedTokens;
  into.outputTokens += d.outputTokens;
  into.ttsChars += d.ttsChars;
  into.streamSeconds += d.streamSeconds;
  into.clipSeconds += d.clipSeconds;
  into.searches += d.searches;
  into.microUsd += d.microUsd;
  for (const [k, v] of Object.entries(d.by)) into.by[k] = (into.by[k] ?? 0) + v;
  return into;
}

/** The totals with the dollar figure spelled out, and seconds rounded. */
function describe(d: DayTotals) {
  return {
    ...d,
    streamSeconds: Math.round(d.streamSeconds),
    clipSeconds: Math.round(d.clipSeconds * 10) / 10,
    estUsd: usd(d.microUsd),
    by: Object.fromEntries(Object.entries(d.by).map(([k, v]) => [k, usd(v)])),
  };
}

/** Nightly. Ninety days is enough to compare three billing months. */
export function pruneUsage(db: D1Database, now: number) {
  return db.prepare("DELETE FROM usage_daily WHERE day < ?").bind(dayOf(now - 90 * 86_400_000));
}
