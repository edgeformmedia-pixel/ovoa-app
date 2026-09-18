import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Capture, CaptureStatus } from "./types.js";

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "audio"), { recursive: true });

/**
 * SQLite keeps local dev zero-config. The query surface below is deliberately
 * plain SQL so swapping in Postgres for a real deployment is a driver change,
 * not a rewrite.
 */
const db = new Database(path.join(config.dataDir, "ovoa.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS captures (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    closed_at    TEXT,
    duration_sec REAL,
    bytes        INTEGER NOT NULL DEFAULT 0,
    transcript   TEXT,
    title        TEXT,
    summary      TEXT,
    action_items TEXT NOT NULL DEFAULT '[]',
    segments     TEXT NOT NULL DEFAULT '[]',
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS captures_started_at ON captures (started_at DESC);

  -- Full-text index over transcripts. Kept as a standalone table rather than an
  -- external-content one so a failed enrichment cannot desync it from captures.
  CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
    id UNINDEXED, transcript, title, summary
  );

  -- Latest state the phone reported. One row; the pendant has no clock, GPS, or
  -- network of its own, so everything situational comes from the handset.
  CREATE TABLE IF NOT EXISTS device_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    reported_at  TEXT NOT NULL,
    latitude     REAL,
    longitude    REAL,
    place_label  TEXT,
    battery_pct  INTEGER,
    timezone     TEXT
  );
`);

interface Row {
  id: string;
  status: string;
  started_at: string;
  closed_at: string | null;
  duration_sec: number | null;
  bytes: number;
  transcript: string | null;
  title: string | null;
  summary: string | null;
  action_items: string;
  error: string | null;
}

function toCapture(row: Row): Capture {
  return {
    id: row.id,
    status: row.status as CaptureStatus,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    durationSec: row.duration_sec,
    bytes: row.bytes,
    transcript: row.transcript,
    title: row.title,
    summary: row.summary,
    actionItems: JSON.parse(row.action_items) as string[],
    error: row.error,
  };
}

export const captures = {
  create(id: string): Capture {
    db.prepare(
      `INSERT INTO captures (id, status, started_at) VALUES (?, 'recording', ?)`,
    ).run(id, new Date().toISOString());
    return this.get(id)!;
  },

  get(id: string): Capture | null {
    const row = db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id) as Row | undefined;
    return row ? toCapture(row) : null;
  },

  list(limit = 50): Capture[] {
    const rows = db
      .prepare(`SELECT * FROM captures ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(toCapture);
  },

  addBytes(id: string, n: number): void {
    db.prepare(`UPDATE captures SET bytes = bytes + ? WHERE id = ?`).run(n, id);
  },

  setStatus(id: string, status: CaptureStatus, error?: string): void {
    db.prepare(`UPDATE captures SET status = ?, error = ? WHERE id = ?`).run(
      status,
      error ?? null,
      id,
    );
  },

  close(id: string, durationSec: number): void {
    db.prepare(
      `UPDATE captures SET status = 'processing', closed_at = ?, duration_sec = ? WHERE id = ?`,
    ).run(new Date().toISOString(), durationSec, id);
  },

  saveTranscript(id: string, transcript: string, segments: unknown): void {
    db.prepare(`UPDATE captures SET transcript = ?, segments = ? WHERE id = ?`).run(
      transcript,
      JSON.stringify(segments),
      id,
    );
    this.reindex(id);
  },

  saveEnrichment(
    id: string,
    e: { title: string; summary: string; actionItems: string[] },
  ): void {
    db.prepare(
      `UPDATE captures SET title = ?, summary = ?, action_items = ?, status = 'ready' WHERE id = ?`,
    ).run(e.title, e.summary, JSON.stringify(e.actionItems), id);
    this.reindex(id);
  },

  /** Rewrites this capture's FTS row from whatever is currently stored. */
  reindex(id: string): void {
    const row = db
      .prepare(`SELECT transcript, title, summary FROM captures WHERE id = ?`)
      .get(id) as { transcript: string | null; title: string | null; summary: string | null } | undefined;
    if (!row) return;
    db.prepare(`DELETE FROM captures_fts WHERE id = ?`).run(id);
    db.prepare(
      `INSERT INTO captures_fts (id, transcript, title, summary) VALUES (?, ?, ?, ?)`,
    ).run(id, row.transcript ?? "", row.title ?? "", row.summary ?? "");
  },

  /**
   * Full-text search with a date window. Returns a snippet around each hit
   * rather than the whole transcript - a day of wear is far too much to hand
   * back to the model in one tool result.
   */
  search(opts: { query: string; from?: string; to?: string; limit?: number }): SearchHit[] {
    const match = toFtsQuery(opts.query);
    if (!match) return [];

    const clauses = ["f.captures_fts MATCH ?"];
    const params: unknown[] = [match];
    if (opts.from) {
      clauses.push("c.started_at >= ?");
      params.push(opts.from);
    }
    if (opts.to) {
      clauses.push("c.started_at <= ?");
      params.push(opts.to);
    }
    params.push(Math.min(opts.limit ?? 8, 25));

    try {
      return db
        .prepare(
          `SELECT c.id, c.started_at, c.title,
                  snippet(captures_fts, 1, '[', ']', ' ... ', 40) AS snippet
           FROM captures_fts f
           JOIN captures c ON c.id = f.id
           WHERE ${clauses.join(" AND ")}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...params) as SearchHit[];
    } catch {
      // A malformed FTS expression is a bad query, not a server fault.
      return [];
    }
  },

  /** Recent transcripts, oldest-first, for grounding chat answers. */
  recentTranscripts(limit = 20): { id: string; startedAt: string; title: string | null; transcript: string }[] {
    const rows = db
      .prepare(
        `SELECT id, started_at, title, transcript FROM captures
         WHERE transcript IS NOT NULL AND transcript != ''
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as { id: string; started_at: string; title: string | null; transcript: string }[];
    return rows
      .map((r) => ({ id: r.id, startedAt: r.started_at, title: r.title, transcript: r.transcript }))
      .reverse();
  },
};

export interface SearchHit {
  id: string;
  started_at: string;
  title: string | null;
  snippet: string;
}

/**
 * FTS5 treats bare punctuation as operators and throws on malformed input, so
 * every term is quoted and passed as a literal. Users type questions, not query
 * syntax.
 */
function toFtsQuery(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, 12)
    .map((t) => `"${t.replace(/"/g, "")}"`);
  return terms.length ? terms.join(" OR ") : null;
}

/**
 * Terms are OR-joined so that an imperfect transcript still matches, which means
 * a single common word left in the query matches every capture ever recorded.
 * Stripping function words aggressively is what keeps "where is my kid" from
 * returning the whole archive on the strength of "is".
 */
const STOPWORDS = new Set([
  // articles, conjunctions, prepositions
  "the", "and", "but", "for", "nor", "yet", "with", "about", "from", "into",
  "onto", "over", "under", "than", "then", "that", "this", "these", "those",
  "there", "here", "out", "off", "its", "any", "all", "some", "just", "also",
  // pronouns and possessives
  "you", "your", "yours", "our", "ours", "they", "them", "their", "his", "her",
  "hers", "him", "she", "its", "mine", "myself", "who", "whom", "whose",
  // question words - the user is asking, these are never in the answer
  "what", "when", "where", "why", "how", "which",
  // auxiliaries and common verbs
  "was", "were", "are", "been", "being", "have", "has", "had", "did", "does",
  "doing", "can", "could", "would", "should", "will", "shall", "may", "might",
  "must", "get", "got", "say", "said", "says", "tell", "told", "know", "knew",
  // short function words that survive the length filter
  "is", "am", "be", "do", "my", "me", "we", "us", "he", "it", "at", "in", "on",
  "of", "to", "or", "if", "so", "up", "as", "an", "by", "no", "not",
]);

export interface DeviceState {
  reportedAt: string;
  latitude: number | null;
  longitude: number | null;
  placeLabel: string | null;
  batteryPct: number | null;
  timezone: string | null;
}

export const deviceState = {
  set(s: Omit<DeviceState, "reportedAt">): void {
    db.prepare(
      `INSERT INTO device_state (id, reported_at, latitude, longitude, place_label, battery_pct, timezone)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         reported_at = excluded.reported_at,
         latitude    = excluded.latitude,
         longitude   = excluded.longitude,
         place_label = excluded.place_label,
         battery_pct = excluded.battery_pct,
         timezone    = excluded.timezone`,
    ).run(
      new Date().toISOString(),
      s.latitude, s.longitude, s.placeLabel, s.batteryPct, s.timezone,
    );
  },

  get(): DeviceState | null {
    const row = db.prepare(`SELECT * FROM device_state WHERE id = 1`).get() as
      | { reported_at: string; latitude: number | null; longitude: number | null;
          place_label: string | null; battery_pct: number | null; timezone: string | null }
      | undefined;
    if (!row) return null;
    return {
      reportedAt: row.reported_at,
      latitude: row.latitude,
      longitude: row.longitude,
      placeLabel: row.place_label,
      batteryPct: row.battery_pct,
      timezone: row.timezone,
    };
  },
};

export function audioPath(id: string): string {
  return path.join(config.dataDir, "audio", `${id}.pcm`);
}
