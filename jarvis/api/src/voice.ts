import { Hono } from "hono";
import { z } from "zod";
import { say } from "./obs";
import type { Env, Vars } from "./types";
import { recordUsage, ttsRow } from "./usage";

// Text to speech: OVOA's voice. The key stays on the server; the app only ever
// talks to these routes.
//
// Speech to text isn't here any more (2026-09-23). The iPhone recognises what
// people say itself (app lib/liveListen.ts, lib/onDeviceTranscribe.ts), and
// only the words come to this server. Deepgram is OVOA's voice and nothing
// else: its listen and token endpoints are never called, which
// test/deepgram.test.ts checks. The two routes that used them answer 410 so
// builds from before tell their user to update.
//
// Every sentence voiced is written to the usage table (usage.ts) against the
// person it was for, in characters, which is how it is billed.
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
// Deepgram's /speak takes at most 2000 characters per request.
const MAX_SPEAK_CHARS = 2000;
/** How long a voiced sentence stays in the cache. */
const CACHE_SECONDS = 30 * 24 * 3600;

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

/**
 * Speech to text, gone. Builds from before 2026-09-23 still ask for a clip to
 * be transcribed or for a live-listening token, through the old address's
 * forwarder for a few weeks; they get a plain answer they can show. Old builds
 * show `error` as it is (they never read anything else), so the sentence is
 * there and the code rides along. Free in ROUTE_TIERS (plans.ts), so a free
 * account's old build sees this, not a 402.
 */
const GONE = { error: "Update OVOA from TestFlight", code: "gone" } as const;
voice.post("/voice/transcribe", (c) => c.json(GONE, 410));
voice.post("/voice/token", (c) => c.json(GONE, 410));

// ---------- Voicing ----------

/**
 * Where one piece's audio came from and where its time went, for the piece's
 * log line. The gap from a sentence being written to its audio reaching the
 * phone was 523-1421 ms (2026-09-23) with nothing to say whether that was
 * Deepgram thinking, Deepgram sending, or the cache: headersMs is Deepgram's
 * answer starting, bodyMs the MP3 arriving after it.
 */
export type VoicedPiece = { cache: "hit" | "miss" | "none"; headersMs?: number; bodyMs?: number; bytes: number };

/**
 * Voices one piece of text on one engine, as MP3, so the phone's player and the
 * cache never need to know which engine spoke. The phone's own voice is never
 * asked for here: it speaks on the phone.
 */
async function synthesize(env: Env, engine: TtsEngine, voice: VoiceId, text: string) {
  switch (engine) {
    case "deepgram-aura-2": {
      if (!env.DEEPGRAM_API_KEY) throw new Error("Voice isn't set up on the server yet");
      const asked = Date.now();
      const res = await fetch(`${DEEPGRAM}/speak?model=${voice}&encoding=mp3`, {
        method: "POST",
        headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const headersMs = Date.now() - asked;
      if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, headersMs, bodyMs: Date.now() - asked - headersMs };
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
  /** Told where the audio came from and how long Deepgram took (VoicedPiece). */
  onVoiced?: (piece: VoicedPiece) => void,
): Promise<Uint8Array> {
  const key = new Request(`https://tts.ovoa.internal/${engine}/${voice}/${await sha256(text)}`);
  let cache: Cache | null = null;
  try {
    cache = caches.default;
    const hit = await cache.match(key);
    if (hit) {
      ctx.waitUntil(recordUsage(env, [{ ...ttsRow(userId, engine, voice, text.length), engine: "cache", microUsd: 0 }]));
      const bytes = new Uint8Array(await hit.arrayBuffer());
      onVoiced?.({ cache: "hit", bytes: bytes.byteLength });
      return bytes;
    }
  } catch {
    // No cache here (an odd runtime): voice it every time, which is only what it always cost.
  }
  // Counted whether or not the engine answers: a failed request is still a request.
  ctx.waitUntil(recordUsage(env, [ttsRow(userId, engine, voice, text.length)]));
  const { bytes, headersMs, bodyMs } = await synthesize(env, engine, voice, text);
  onVoiced?.({ cache: cache ? "miss" : "none", headersMs, bodyMs, bytes: bytes.byteLength });
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
/**
 * A first sentence longer than this goes out in two pieces (app/src/lib/voice.ts
 * SPLIT_FIRST_OVER). 35, down from 60 (2026-09-23): the first piece is the one
 * the user waits on in silence, and Deepgram's time grows with its length, so
 * "Your dentist is tomorrow," goes on its own and the rest follows while it plays.
 */
const SPLIT_FIRST_OVER = 35;
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
  /** The request's id (obs.ts observe), so each piece's ovoa.tts line joins its ovoa.turn line. */
  rid?: string,
) {
  const opened = Date.now();
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

  /** One piece's story for its log line: queued, given a slot, voiced. */
  type Timing = { queued: number; began?: number; voiced?: VoicedPiece; ready?: number };

  const voiceOne = async (text: string, timing: Timing): Promise<Uint8Array> => {
    await slot();
    timing.began = Date.now();
    try {
      if (stopped) throw new Error("stopped");
      return await voiceText(env, ctx, userId, engine, voice, text, (piece) => (timing.voiced = piece));
    } finally {
      timing.ready = Date.now();
      release();
    }
  };

  const add = (raw: string) => {
    const text = speakable(raw).slice(0, MAX_SPEAK_CHARS);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const seq = pieces++;
    chars += text.length;
    const timing: Timing = { queued: Date.now() };
    // Started now; written out after every piece before it.
    const audio = voiceOne(text, timing).then(
      (bytes) => ({ bytes, error: null }),
      (err: unknown) => ({ bytes: null, error: err instanceof Error ? err.message : String(err) }),
    );
    written = written.then(async () => {
      const { bytes, error } = await audio;
      if (stopped) return;
      if (error) console.error(`speak: piece ${seq} couldn't be voiced; the phone will`, error);
      // Without the audio the phone still gets the words, and voices them itself.
      await write(bytes ? { type: "audio", seq, text, mp3: base64(bytes) } : { type: "audio", seq, text, error: error ?? "no audio" });
      // wait: for a slot (SPEAK_AHEAD). head and body: Deepgram (VoicedPiece). held:
      // voiced, then waiting on an earlier piece. sent: since the stream opened.
      const v = timing.voiced;
      say("tts", {
        rid,
        seq,
        chars: text.length,
        cache: v?.cache ?? "failed",
        wait: (timing.began ?? timing.queued) - timing.queued,
        head: v?.headersMs,
        body: v?.bodyMs,
        bytes: v?.bytes,
        held: timing.ready === undefined ? undefined : Date.now() - timing.ready,
        sent: Date.now() - opened,
      });
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
