// A ring on their finger: press, talk, and OVOA texts back.
//
// The first ring is the Pebble Index 01, which needs nothing of ours on it: its
// app (Index 01 Settings, Webhook) POSTs each recording here, per gesture, as
// multipart/form-data with `transcription` and/or `audio` (AAC in M4A, mono
// 16 kHz), `recordedAt` (ms) and `client: "ring"`. Headers are whatever the
// person typed in, so the key goes in `Authorization: Bearer <key>`. The
// contract is coredevices/mobileapp's INDEX_WEBHOOK_API.md, version 1.
//
// What was said goes into their Text OVOA thread as a voice note (texting.ts
// fromRing): the reply comes by iMessage, which is the ring's "got it" until a
// ring with a buzz of its own. The app retries only on its next recording, and
// only after a 5xx, so 200 means it's written down for an answer.
//
// The key is shown once (POST /ring/key) and kept only as its hash, like a
// session's. One key per account: a new one replaces the old.

import { Hono } from "hono";
import { randomHex, sha256 } from "./auth";
import { transcribeAudio } from "./llm";
import { allowed, tooMany } from "./limits";
import { say } from "./obs";
import { fromRing, sendblue, textingReady, type TextTurn } from "./texting";
import type { Env, Vars } from "./types";

export const RING_PATH = "/ring/pebble";
/** Far above anything said into a ring, and a bound on what a leaked key can send. */
const MAX_WORDS = 8_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Same as the texting webhook: the reply is written while the app waits, then after. */
const HOLD_MS = 25_000;

export type RingNote = { words: string | null; audio: Blob | null; recordedAt: number | null; test: boolean; trigger: string | null };

/** The key from `Authorization: Bearer <key>` (or X-Widget-Token, the app's older header). Pure. */
export function ringKeyOf(headers: { get(name: string): string | null }) {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "")?.[1];
  const key = bearer ?? headers.get("x-widget-token")?.trim() ?? "";
  return /^[0-9a-f]{64}$/i.test(key) ? key.toLowerCase() : null;
}

/** The webhook's form, as a note. Pure, but for reading the form. */
export function ringNoteOf(form: FormData, headers: { get(name: string): string | null }): RingNote {
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : null;
  };
  const words = (field("transcription") ?? "").replace(/\r\n?/g, "\n").trim();
  const audio = form.get("audio");
  const at = Number(field("recordedAt"));
  return {
    words: words || null,
    audio: audio && typeof audio !== "string" ? audio : null,
    recordedAt: Number.isFinite(at) && at > 0 ? Math.round(at) : null,
    test: headers.get("x-index-test") === "true" || field("test") === "true",
    trigger: headers.get("x-index-trigger"),
  };
}

/** The same recording, delivered again, gets the same key. */
export async function noteKey(userId: string, note: Pick<RingNote, "recordedAt" | "words">) {
  return (await sha256(`${userId}|${note.recordedAt ?? ""}|${note.words ?? ""}`)).slice(0, 32);
}

async function userForKey(db: D1Database, key: string) {
  const row = await db
    .prepare("UPDATE ring_keys SET last_used_at = ? WHERE key_hash = ? RETURNING user_id")
    .bind(Date.now(), await sha256(key))
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** POST /ring/pebble: the Pebble app's webhook. Public; the key is the sign-in. */
export function ringWebhook(turn: TextTurn) {
  const routes = new Hono<{ Bindings: Env; Variables: Vars }>();
  routes.post(RING_PATH, async (c) => {
    const env = c.env;
    const key = ringKeyOf(c.req.raw.headers);
    if (!key) return c.json({ error: "Missing ring key" }, 401);
    if (!(await allowed(env, "RL_AUTH", `ring:${key.slice(0, 16)}`))) return tooMany(c, "ring notes");
    const userId = await userForKey(env.DB, key);
    if (!userId) return c.json({ error: "Unknown ring key. Make a new one in OVOA's settings." }, 401);
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "Expected multipart/form-data" }, 400);
    const note = ringNoteOf(form, c.req.raw.headers);
    if (note.test) {
      say("ring", { outcome: "test", user: userId });
      return c.json({ ok: true, test: true });
    }
    if (!note.words && !note.audio) return c.json({ error: "Neither audio nor transcription" }, 422);
    if ((note.words?.length ?? 0) > MAX_WORDS || (note.audio?.size ?? 0) > MAX_AUDIO_BYTES) return c.json({ error: "Too long" }, 413);
    if (!textingReady(env)) return c.json({ error: "Texting isn't set up" }, 503);

    let words = note.words;
    if (!words && note.audio) {
      try {
        words = await transcribeAudio(env, { bytes: new Uint8Array(await note.audio.arrayBuffer()), usage: { userId, purpose: "ring" } });
      } catch (err) {
        say("ring", { outcome: "unheard", user: userId, why: err instanceof Error ? err.message.slice(0, 120) : "error" });
        return c.json({ ok: true, outcome: "nothing heard" });
      }
    }
    if (!words) return c.json({ ok: true, outcome: "nothing heard" });

    const started = Date.now();
    const got = await fromRing(env, c.executionCtx, userId, words, await noteKey(userId, { recordedAt: note.recordedAt, words }), {
      turn,
      sender: (line) => sendblue(env, line),
      requestId: c.var.requestId,
      deadline: started + 60_000,
    });
    if (!got) return c.json({ error: "Link your number to Text OVOA first (ovoa.ai/account)" }, 409);
    say("ring", { outcome: got.outcome, user: userId, trigger: note.trigger ?? undefined, ms: Date.now() - started });
    if (got.work) {
      c.executionCtx.waitUntil(got.work);
      await Promise.race([got.work, new Promise((r) => setTimeout(r, HOLD_MS))]);
    }
    return c.json({ ok: true, outcome: got.outcome });
  });
  return routes;
}

/**
 * The app's side, signed in: whether a ring key exists (GET /ring), a new one
 * with what to paste into the Pebble app (POST /ring/key), and none (DELETE /ring/key).
 */
export const ringRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

ringRoutes.get("/ring", async (c) => {
  const row = await c.env.DB.prepare("SELECT created_at, last_used_at FROM ring_keys WHERE user_id = ?")
    .bind(c.var.userId)
    .first<{ created_at: number; last_used_at: number | null }>();
  return c.json({ connected: !!row, createdAt: row?.created_at ?? null, lastUsedAt: row?.last_used_at ?? null });
});

ringRoutes.post("/ring/key", async (c) => {
  const key = randomHex(32);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO ring_keys (user_id, key_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at, last_used_at = NULL`,
  )
    .bind(c.var.userId, await sha256(key), now)
    .run();
  say("ring", { outcome: "key made", user: c.var.userId });
  const origin = new URL(c.req.url).origin;
  return c.json({
    url: `${origin}${RING_PATH}`,
    header: { name: "Authorization", value: `Bearer ${key}` },
    send: "Both",
    steps: [
      "Open the Pebble app, then Index 01 Settings, then Webhook.",
      "Pick Hold & talk.",
      "Paste the URL.",
      "Add a header: name Authorization, value as shown.",
      "What to send: Both. Tap Send test event, then Save.",
    ],
  });
});

ringRoutes.delete("/ring/key", async (c) => {
  await c.env.DB.prepare("DELETE FROM ring_keys WHERE user_id = ?").bind(c.var.userId).run();
  return c.json({ ok: true });
});
