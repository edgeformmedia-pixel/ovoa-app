import type { Env } from "./types";

// Settings for the server itself, changeable without a deploy.
//
// See migrations/0034_server_settings.sql. The whole table is a handful of
// rows, so it is read in one SELECT and kept for a minute per isolate: a turn
// costs no extra read, and a change made through /debug/engines or the Dev
// tools picker takes effect within a minute everywhere. Writing through this
// module clears the cache on the isolate that wrote, so the person who flipped
// the switch sees it on their very next turn.

/** How long one isolate trusts what it last read. */
const CACHE_MS = 60_000;

/**
 * The keys the server understands. Anything else is refused at the door, and
 * rows under keys retired since (workers_model and stt_clip_engine went with
 * Workers AI in v1; the old database's rows may have been copied across) are
 * never read.
 */
export const SETTING_KEYS = ["engine_order", "voice_engine", "tts_engine"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export type ServerSettings = Partial<Record<SettingKey, string>>;

let cached: { at: number; all: Map<string, string> } | null = null;

/** Everything in the table, cached. Never throws: a missing table reads as empty. */
async function all(env: Env): Promise<Map<string, string>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.all;
  const map = new Map<string, string>();
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM server_settings").all<{ key: string; value: string }>();
    for (const r of results) map.set(r.key, r.value);
  } catch (err) {
    console.error("ovoa.err server_settings read failed; using the vars", err);
    // Tried again next time rather than in a minute, in case it was transient.
    return map;
  }
  cached = { at: Date.now(), all: map };
  return map;
}

/**
 * The settings that apply to one person: the global ones, with any of their own
 * layered on top. A per-person row lets a developer try an engine without
 * changing what everyone else gets.
 */
export async function settingsFor(env: Env, userId?: string | null): Promise<ServerSettings> {
  const map = await all(env);
  const out: ServerSettings = {};
  for (const key of SETTING_KEYS) {
    const mine = userId ? map.get(`${key}:${userId}`) : undefined;
    const value = mine ?? map.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/** The global settings only, for showing what is set. */
export const globalSettings = (env: Env) => settingsFor(env, null);

/**
 * Sets, or with an empty value clears, one key. `userId` scopes it to one
 * person. Values are trimmed and capped; what they may say is checked by the
 * route that calls this (llm.ts knows the engine names, not this file).
 */
export async function setServerSetting(env: Env, key: SettingKey, value: string | null, userId?: string | null) {
  const full = userId ? `${key}:${userId}` : key;
  const clean = (value ?? "").trim().slice(0, 200);
  if (clean) {
    await env.DB.prepare(
      "INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind(full, clean, Date.now())
      .run();
  } else {
    await env.DB.prepare("DELETE FROM server_settings WHERE key = ?").bind(full).run();
  }
  cached = null;
}

/** Forget what was read, so a test or a write sees the table fresh. */
export function forgetServerSettings() {
  cached = null;
}
