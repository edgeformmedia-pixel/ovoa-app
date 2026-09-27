// Voice-note replies: when someone texts OVOA a voice memo, the reply also goes
// back as audio, the way a friend answers a voice note with one.
//
// Off unless TEXT_VOICE_REPLIES is "1" (and Deepgram is set up). The text reply
// is sent first and is unchanged; the audio follows it, and if speaking fails
// for any reason nothing else happens. Base and up, with AI consent and a day's
// allowance left (plans.ts blockedFor), and its characters are counted like any
// other voicing (voice.ts voiceText). The MP3 is kept in D1 behind a random
// token for an hour, only long enough for Sendblue to fetch it, then deleted.

import { Hono } from "hono";
import { base64url } from "./crypto";
import { blockedFor } from "./plans";
import type { Env } from "./types";
import { speakable, VOICES, voiceText } from "./voice";

export const voiceRepliesOn = (env: Env) => env.TEXT_VOICE_REPLIES === "1" && !!env.DEEPGRAM_API_KEY;

/** The part of a reply that's spoken: about 40 seconds. */
export const SPOKEN_MAX = 600;
const CLIP_MAX_BYTES = 1_000_000;
const CLIP_TTL_MS = 3_600_000;

/** Where a reply stops being spoken: at a sentence end before SPOKEN_MAX when there is one. Pure. */
export function spokenPart(reply: string): string {
  const text = speakable(reply).replace(/\s+/g, " ").trim();
  if (text.length <= SPOKEN_MAX) return text;
  const cut = text.slice(0, SPOKEN_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > SPOKEN_MAX / 2 ? cut.slice(0, end + 1) : cut;
}

/**
 * Speaks `reply` and texts it to `to` as audio. True when it went. Never throws.
 */
export async function sendVoiceReply(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  to: string,
  reply: string,
  send: (to: string, content: string, media?: string) => Promise<boolean>,
  now = Date.now(),
): Promise<boolean> {
  try {
    if (!voiceRepliesOn(env)) return false;
    if (await blockedFor(env, userId, "base")) return false;
    const text = spokenPart(reply);
    if (!text) return false;
    const mp3 = await voiceText(env, ctx, userId, "deepgram-aura-2", VOICES[0], text);
    if (!mp3.byteLength || mp3.byteLength > CLIP_MAX_BYTES) return false;
    const token = base64url(crypto.getRandomValues(new Uint8Array(24)));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM voice_clips WHERE expires_at < ?").bind(now),
      env.DB.prepare("INSERT INTO voice_clips (token, user_id, mp3, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(token, userId, mp3, now, now + CLIP_TTL_MS),
    ]);
    return await send(to, "", `${env.PUBLIC_URL}/texting/voice/${token}.mp3`);
  } catch (err) {
    console.error("voice reply failed", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Public, for Sendblue to fetch the audio by its token. */
export const voiceClipRoutes = new Hono<{ Bindings: Env }>();

voiceClipRoutes.get("/texting/voice/:file", async (c) => {
  const token = c.req.param("file").replace(/\.mp3$/, "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return c.body(null, 404);
  const row = await c.env.DB
    .prepare("SELECT mp3 FROM voice_clips WHERE token = ? AND expires_at > ?")
    .bind(token, Date.now())
    .first<{ mp3: ArrayBuffer | Uint8Array }>();
  if (!row) return c.body(null, 404);
  const bytes = row.mp3 instanceof Uint8Array ? row.mp3 : new Uint8Array(row.mp3);
  return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" } });
});
