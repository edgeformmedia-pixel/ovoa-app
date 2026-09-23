import { Hono } from "hono";
import { z } from "zod";
import type { Env, Vars } from "./types";
import { recordUsage, sttClipRow, ttsRow } from "./usage";

// Speech to text and text to speech. The keys stay on the server; the app only
// ever talks to these routes.
//
// Every clip transcribed and every sentence voiced is written to the usage
// table (usage.ts) against the person it was for: seconds of audio for
// transcription, characters for speech, which is how each is billed.
//
// Text to speech comes from Deepgram's Aura-2 or from the phone itself
// (TTS_ENGINES), chosen by the TTS_ENGINE var or, without a deploy, by
// server_settings.tts_engine. The voice is the product: Aura-2 is the default.
// The three Workers AI voices (Aura-2 and Aura-1 through Workers AI, and
// MeloTTS) went with Workers AI in the v1 release; a copied setting that still
// names one falls back to the default rather than silencing anyone.
//
// Identical sentences in the same engine and voice are voiced once and kept in
// the Workers cache for a month. Fillers, confirmations and greetings repeat
// all day across everyone, and a cache hit is free.

const DEEPGRAM = "https://api.deepgram.com/v1";
const STT_MODEL = "nova-3";
// Helps Deepgram hear the assistant's name instead of "oboe" or "over".
const KEYTERMS = ["OVOA"];
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
// Deepgram's /speak takes at most 2000 characters per request.
const MAX_SPEAK_CHARS = 2000;
/** How long a voiced sentence stays in the cache. */
const CACHE_SECONDS = 30 * 24 * 3600;

/**
 * What transcribes a recorded clip (the band's button, the recorded fallback,
 * talking over a reply): Deepgram Nova-3, filed in the usage table under this
 * name (pricing.ts). Whisper on Workers AI was the cheaper choice until v1.
 */
const STT_CLIP_USAGE = "deepgram-nova-3-clip";

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

export type VoiceId = (typeof VOICES)[number];

/**
 * Where a reply's voice can come from, and what each costs (pricing.ts):
 *   deepgram-aura-2  Deepgram direct, the default          $0.030 / 1K chars
 *   device           the phone's own voices (expo-speech)  free, offline, lowest latency
 */
export const TTS_ENGINES = ["deepgram-aura-2", "device"] as const;
export type TtsEngine = (typeof TTS_ENGINES)[number];
export const DEFAULT_TTS_ENGINE: TtsEngine = "deepgram-aura-2";

export const isTtsEngine = (s: string): s is TtsEngine => (TTS_ENGINES as readonly string[]).includes(s);

/**
 * The engine to use: the runtime setting, else the var, else the default. An
 * unknown name (a Workers AI voice from before v1, in a copied row) is passed
 * over rather than silencing anyone.
 */
export function ttsEngineFrom(setting: string | undefined, envVar: string | undefined): TtsEngine {
  return [setting, envVar].map((v) => (v ?? "").trim()).find(isTtsEngine) ?? DEFAULT_TTS_ENGINE;
}

export const voice = new Hono<{ Bindings: Env; Variables: Vars }>();

/** A clip's words and how long it was, from whichever transcriber. */
type Transcribed = { text: string; seconds: number };

async function transcribeDeepgram(env: Env, audio: ArrayBuffer, contentType: string, names: string[]): Promise<Transcribed> {
  if (!env.DEEPGRAM_API_KEY) throw new Error("Voice isn't set up on the server yet");
  const keyterms = names.map((k) => `&keyterm=${encodeURIComponent(k)}`).join("");
  const url = `${DEEPGRAM}/listen?model=${STT_MODEL}&smart_format=true&language=en${keyterms}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, "content-type": contentType },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json<{
    metadata?: { duration?: number };
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  }>();
  return {
    text: body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "",
    // Deepgram says how long the audio was; that is what it bills, not the bytes.
    seconds: Number(body.metadata?.duration) || 0,
  };
}

voice.post("/voice/transcribe", async (c) => {
  const audio = await c.req.arrayBuffer();
  if (!audio.byteLength) return c.json({ error: "No audio" }, 400);
  if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "Recording is too long" }, 413);
  const contentType = c.req.header("content-type") ?? "audio/mp4";
  if (!c.env.DEEPGRAM_API_KEY) return c.json({ error: "Voice isn't set up on the server yet" }, 503);
  // The assistant's name, so the transcriber expects it.
  const custom = await c.env.DB.prepare("SELECT assistant_name FROM settings WHERE user_id = ?")
    .bind(c.var.userId)
    .first<{ assistant_name: string }>()
    .catch(() => null);
  const names = [...new Set([...KEYTERMS, ...(custom?.assistant_name ? [custom.assistant_name] : [])])];

  const started = Date.now();
  let got: Transcribed;
  try {
    got = await transcribeDeepgram(c.env, audio, contentType, names);
  } catch (err) {
    console.error("transcribe: deepgram failed", err);
    return c.json({ error: "Couldn't transcribe that" }, 502);
  }
  console.log(`transcribe: deepgram, ${Math.round(audio.byteLength / 1024)} KB, ${got.seconds.toFixed(1)} s of audio, ${Date.now() - started} ms`);
  c.executionCtx.waitUntil(recordUsage(c.env, [sttClipRow(c.var.userId, STT_CLIP_USAGE, got.seconds)]));
  return c.json({ text: got.text, engine: "deepgram", ms: Date.now() - started });
});

/**
 * A short-lived Deepgram token so the app can stream the microphone straight
 * to Deepgram's live transcription. It only needs to be valid when the
 * connection opens; the real key never leaves the server.
 */
voice.post("/voice/token", async (c) => {
  if (!c.env.DEEPGRAM_API_KEY) return c.json({ error: "Voice isn't set up on the server yet" }, 503);
  // The phone now fetches a token ahead of time and holds it until the name is
  // heard, so opening the connection costs no round trip (liveListen.ts). That
  // needs a token that lasts longer than the 30 s default; Deepgram allows up
  // to an hour, and ten minutes is plenty. The token only has to be valid at
  // the moment the connection opens.
  const ttl = Math.min(600, Math.max(30, Math.round(Number(c.req.query("ttl")) || 30)));
  const res = await fetch(`${DEEPGRAM}/auth/grant`, {
    method: "POST",
    headers: { authorization: `Token ${c.env.DEEPGRAM_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: ttl }),
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

// ---------- Voicing ----------

/**
 * Voices one piece of text on one engine, as MP3, so the phone's player and the
 * cache never need to know which engine spoke. The phone's own voice is never
 * asked for here: it speaks on the phone.
 */
async function synthesize(env: Env, engine: TtsEngine, voice: VoiceId, text: string): Promise<Uint8Array> {
  switch (engine) {
    case "deepgram-aura-2": {
      if (!env.DEEPGRAM_API_KEY) throw new Error("Voice isn't set up on the server yet");
      const res = await fetch(`${DEEPGRAM}/speak?model=${voice}&encoding=mp3`, {
        method: "POST",
        headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    case "device":
      throw new Error("The phone voices this itself");
  }
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Voices `text`, from the cache when the same sentence in the same voice was
 * voiced before. The cache key is a hash, so no words are in it. Records what
 * it spent: a cache hit is a row under "cache" with the characters and no cost,
 * so the saving is visible in the usage table rather than invisible.
 */
export async function voiceText(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string | null,
  engine: TtsEngine,
  voice: VoiceId,
  text: string,
): Promise<Uint8Array> {
  const key = new Request(`https://tts.ovoa.internal/${engine}/${voice}/${await sha256(text)}`);
  let cache: Cache | null = null;
  try {
    cache = caches.default;
    const hit = await cache.match(key);
    if (hit) {
      ctx.waitUntil(recordUsage(env, [{ ...ttsRow(userId, engine, voice, text.length), engine: "cache", microUsd: 0 }]));
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch {
    // No cache here (an odd runtime): voice it every time, which is only what it always cost.
  }
  // Counted whether or not the engine answers: a failed request is still a request.
  ctx.waitUntil(recordUsage(env, [ttsRow(userId, engine, voice, text.length)]));
  const bytes = await synthesize(env, engine, voice, text);
  if (cache && bytes.byteLength) {
    ctx.waitUntil(
      cache
        .put(key, new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": `public, max-age=${CACHE_SECONDS}` } }))
        .catch(() => {}),
    );
  }
  return bytes;
}

const speakSchema = z.object({
  text: z.string().trim().min(1).max(MAX_SPEAK_CHARS * 4),
  voice: z.enum(VOICES).optional(),
});

/**
 * One piece of text as MP3. With the device engine there is nothing to send:
 * a 204 with the engine in a header tells the phone to speak it itself.
 */
voice.post("/voice/speak", async (c) => {
  const parsed = speakSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid text" }, 400);

  const text = speakable(parsed.data.text);
  if (!text) return c.json({ error: "Nothing to say" }, 400);
  const voice = parsed.data.voice ?? VOICES[0];
  const engine = c.get("ttsEngine") ?? ttsEngineFrom(undefined, c.env.TTS_ENGINE);
  if (engine === "device") return new Response(null, { status: 204, headers: { "x-tts-engine": "device" } });
  if (engine === "deepgram-aura-2" && !c.env.DEEPGRAM_API_KEY) return c.json({ error: "Voice isn't set up on the server yet" }, 503);

  const started = Date.now();
  // Long replies go out in pieces; MP3 frames can simply be joined.
  const chunks = splitText(text, MAX_SPEAK_CHARS);
  try {
    const parts = await Promise.all(chunks.map((chunk) => voiceText(c.env, c.executionCtx, c.var.userId, engine, voice, chunk)));
    console.log(`speak: ${text.length} chars, ${chunks.length} part(s), ${engine}, ${Date.now() - started} ms`);
    // MP3 frames can simply be joined.
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.byteLength;
    }
    return new Response(joined, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-tts-engine": engine } });
  } catch (err) {
    console.error("speak failed", engine, err);
    return c.json({ error: "Couldn't speak that" }, 502);
  }
});

// ---------- Voicing a reply as it's written ----------
//
// The phone used to get each sentence of a spoken reply, then ask /voice/speak
// for its audio: a second round trip across the phone's network, and a second
// sign-in check, between the words existing and the voice starting. When the
// phone asks for it (`speak` on /chat), the server voices each piece the moment
// the model writes it and sends the audio down the same stream. One request per
// reply instead of one per sentence, too, which matters with many phones.

/** Voiced ahead of the one being written out, per reply. The phone's own FETCH_AHEAD. */
const SPEAK_AHEAD = 3;
/** A first sentence longer than this goes out in two pieces (app/src/lib/voice.ts SPLIT_FIRST_OVER). */
const SPLIT_FIRST_OVER = 60;
/** ...looking this far into it for a pause (FIRST_PIECE_MAX). */
const FIRST_PIECE_MAX = 120;
/** After the first piece, sentences shorter than this ride along with the next. */
const JOIN_UNDER = 40;

/** One line of the /chat stream carrying a voiced piece, or saying it couldn't be voiced. */
export type AudioLine = { type: "audio"; seq: number; text: string; mp3?: string; error?: string };

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Voices a reply sentence by sentence and hands each piece to `write`, in order.
 * The grouping is the phone's (createSpeaker's `say`), so a reply sounds the same
 * whichever end voiced it: a long first sentence split at its first pause so the
 * voice starts sooner, and very short sentences joined to the next so it doesn't
 * stop and start.
 */
export function speechStream(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string | null,
  engine: TtsEngine,
  voice: VoiceId,
  write: (line: AudioLine) => Promise<void>,
) {
  let pending = "";
  let pieces = 0;
  /** Characters handed to the voice so far: what this reply's speech is billed on. */
  let chars = 0;
  let stopped = false;
  let running = 0;
  const waiting: (() => void)[] = [];
  let written: Promise<void> = Promise.resolve();

  /** At most SPEAK_AHEAD requests to the voice at once per reply, started in order. */
  const slot = () =>
    running < SPEAK_AHEAD ? (running++, Promise.resolve()) : new Promise<void>((r) => waiting.push(() => (running++, r())));
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  const voiceOne = async (text: string): Promise<Uint8Array> => {
    await slot();
    try {
      if (stopped) throw new Error("stopped");
      return await voiceText(env, ctx, userId, engine, voice, text);
    } finally {
      release();
    }
  };

  const add = (raw: string) => {
    const text = speakable(raw).slice(0, MAX_SPEAK_CHARS);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const seq = pieces++;
    chars += text.length;
    // Started now; written out after every piece before it.
    const audio = voiceOne(text).then(
      (bytes) => ({ bytes, error: null }),
      (err: unknown) => ({ bytes: null, error: err instanceof Error ? err.message : String(err) }),
    );
    written = written.then(async () => {
      const { bytes, error } = await audio;
      if (stopped) return;
      if (error) console.error(`speak: piece ${seq} couldn't be voiced; the phone will`, error);
      // Without the audio the phone still gets the words, and voices them itself.
      await write(bytes ? { type: "audio", seq, text, mp3: base64(bytes) } : { type: "audio", seq, text, error: error ?? "no audio" });
    });
  };

  return {
    /** The next sentence of the reply. */
    say(sentence: string) {
      if (stopped) return;
      const text = pending ? `${pending} ${sentence}` : sentence;
      pending = "";
      if (pieces === 0 && text.length > SPLIT_FIRST_OVER) {
        const cut = text.slice(20, FIRST_PIECE_MAX).search(/[,;:—–]\s/);
        if (cut >= 0) {
          add(text.slice(0, 20 + cut + 1));
          add(text.slice(20 + cut + 1).trim());
          return;
        }
      }
      if (pieces > 0 && text.length < JOIN_UNDER) {
        pending = text;
        return;
      }
      add(text);
    },
    /** The reply is finished. Resolves once every piece has been written out. */
    end() {
      if (pending && !stopped) add(pending);
      pending = "";
      return written;
    },
    /** Nobody is listening any more: voice nothing else. */
    stop() {
      stopped = true;
      pending = "";
    },
    /** How many characters were voiced, and how many pieces, for the log line. */
    spent: () => ({ chars, pieces, engine, voice }),
  };
}

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
