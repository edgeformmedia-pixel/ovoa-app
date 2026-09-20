import { Hono } from "hono";
import { z } from "zod";
import type { Env, Vars } from "./types";

// Speech to text and text to speech through Deepgram. The key stays on the
// server; the app only ever talks to these routes.

const DEEPGRAM = "https://api.deepgram.com/v1";
const STT_MODEL = "nova-3";
// Helps Deepgram hear the assistant's name instead of "oboe" or "over".
const KEYTERMS = ["OVOA"];
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
// Deepgram's /speak takes at most 2000 characters per request.
const MAX_SPEAK_CHARS = 2000;

/** Voices the app can pick from (Deepgram Aura 2). */
export const VOICES = [
  "aura-2-thalia-en",
  "aura-2-andromeda-en",
  "aura-2-helena-en",
  "aura-2-luna-en",
  "aura-2-apollo-en",
  "aura-2-arcas-en",
  "aura-2-orion-en",
  "aura-2-hermes-en",
] as const;

export const voice = new Hono<{ Bindings: Env; Variables: Vars }>();

voice.post("/voice/transcribe", async (c) => {
  if (!c.env.DEEPGRAM_API_KEY) return c.json({ error: "Voice isn't set up on the server yet" }, 503);
  const audio = await c.req.arrayBuffer();
  if (!audio.byteLength) return c.json({ error: "No audio" }, 400);
  if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "Recording is too long" }, 413);

  const keyterms = KEYTERMS.map((k) => `&keyterm=${encodeURIComponent(k)}`).join("");
  const url = `${DEEPGRAM}/listen?model=${STT_MODEL}&smart_format=true&language=en${keyterms}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Token ${c.env.DEEPGRAM_API_KEY}`,
      "content-type": c.req.header("content-type") ?? "audio/mp4",
    },
    body: audio,
  });
  if (!res.ok) {
    console.error("deepgram listen", res.status, await res.text());
    return c.json({ error: "Couldn't transcribe that" }, 502);
  }
  const body = await res.json<{
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  }>();
  const text = body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  return c.json({ text });
});

/**
 * A short-lived Deepgram token so the app can stream the microphone straight
 * to Deepgram's live transcription. It only needs to be valid when the
 * connection opens; the real key never leaves the server.
 */
voice.post("/voice/token", async (c) => {
  if (!c.env.DEEPGRAM_API_KEY) return c.json({ error: "Voice isn't set up on the server yet" }, 503);
  const res = await fetch(`${DEEPGRAM}/auth/grant`, {
    method: "POST",
    headers: { authorization: `Token ${c.env.DEEPGRAM_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 30 }),
  });
  if (!res.ok) {
    console.error("deepgram grant", res.status, await res.text());
    return c.json({ error: "Couldn't start live listening" }, 502);
  }
  const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
  // The phone listens for the assistant's name, so make sure Deepgram knows the one this user picked.
  const custom = await c.env.DB.prepare("SELECT assistant_name FROM settings WHERE user_id = ?")
    .bind(c.var.userId)
    .first<{ assistant_name: string }>()
    .catch(() => null);
  const keyterms = [...new Set([...KEYTERMS, ...(custom?.assistant_name ? [custom.assistant_name] : [])])];
  return c.json({ token: access_token, expiresIn: expires_in, model: STT_MODEL, keyterms });
});

const speakSchema = z.object({
  text: z.string().trim().min(1).max(MAX_SPEAK_CHARS * 4),
  voice: z.enum(VOICES).optional(),
});

voice.post("/voice/speak", async (c) => {
  if (!c.env.DEEPGRAM_API_KEY) return c.json({ error: "Voice isn't set up on the server yet" }, 503);
  const parsed = speakSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid text" }, 400);

  const text = speakable(parsed.data.text);
  if (!text) return c.json({ error: "Nothing to say" }, 400);
  const model = parsed.data.voice ?? VOICES[0];

  const started = Date.now();
  const speakChunk = (chunk: string) =>
    fetch(`${DEEPGRAM}/speak?model=${model}&encoding=mp3`, {
      method: "POST",
      headers: { authorization: `Token ${c.env.DEEPGRAM_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ text: chunk }),
    });

  // Long replies go out in pieces; MP3 frames can simply be joined.
  const chunks = splitText(text, MAX_SPEAK_CHARS);
  const audioHeaders = { "content-type": "audio/mpeg", "cache-control": "no-store" };

  // A sentence is almost always one chunk: hand Deepgram's body straight to the
  // phone rather than holding the whole clip here first.
  if (chunks.length === 1) {
    const res = await speakChunk(chunks[0]);
    if (!res.ok || !res.body) {
      console.error("deepgram speak", res.status, await res.text());
      return c.json({ error: "Couldn't speak that" }, 502);
    }
    console.log(`speak: ${text.length} chars, streamed, ${Date.now() - started} ms to first byte`);
    return new Response(res.body, { headers: audioHeaders });
  }

  // Several chunks: ask for them at once instead of one after another.
  const results = await Promise.all(chunks.map(speakChunk));
  const parts: ArrayBuffer[] = [];
  for (const res of results) {
    if (!res.ok) {
      console.error("deepgram speak", res.status, await res.text());
      return c.json({ error: "Couldn't speak that" }, 502);
    }
    parts.push(await res.arrayBuffer());
  }
  console.log(`speak: ${text.length} chars, ${chunks.length} parts, ${Date.now() - started} ms`);
  return new Response(new Blob(parts, { type: "audio/mpeg" }), { headers: audioHeaders });
});

/** Strips markdown and links so the voice doesn't read out symbols. */
export function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
    // Say the name as a word ("oh-VOH-ah"), not letter by letter.
    .replace(/\bOVOA\b/g, "Ovoa")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Splits at sentence ends (or spaces) into pieces no longer than `max`. */
export function splitText(text: string, max: number) {
  const sentences = text.match(/[^.!?\n]+[.!?]*[\n]*|[\n]+/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (let s of sentences) {
    while (s.length > max) {
      const cut = s.lastIndexOf(" ", max) > 0 ? s.lastIndexOf(" ", max) : max;
      if (current) chunks.push(current.trim());
      current = "";
      chunks.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if (current.length + s.length > max) {
      chunks.push(current.trim());
      current = "";
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}
