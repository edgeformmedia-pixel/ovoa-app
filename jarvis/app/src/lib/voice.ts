import {
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type AudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { fetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, ApiError } from "./api";
import { devlog } from "./devlog";
import { listenLive, useLiveStream } from "./liveListen";
import { storage } from "./storage";

// Talking with the assistant: record until the user stops speaking, transcribe
// on the server (Deepgram), then read the reply aloud a sentence or two at a time.

export const VOICES = [
  { id: "aura-2-thalia-en", label: "Thalia", note: "Clear, confident" },
  { id: "aura-2-andromeda-en", label: "Andromeda", note: "Casual, expressive" },
  { id: "aura-2-helena-en", label: "Helena", note: "Caring, friendly" },
  { id: "aura-2-luna-en", label: "Luna", note: "Soft, calm" },
  { id: "aura-2-apollo-en", label: "Apollo", note: "Confident, casual" },
  { id: "aura-2-arcas-en", label: "Arcas", note: "Smooth, natural" },
  { id: "aura-2-orion-en", label: "Orion", note: "Calm, polite" },
  { id: "aura-2-hermes-en", label: "Hermes", note: "Expressive, engaging" },
] as const;
export type VoiceId = (typeof VOICES)[number]["id"];

const VOICE_KEY = "ovoa.voice";

export const voicePref = {
  get: async (): Promise<VoiceId> => {
    const id = await storage.get(VOICE_KEY).catch(() => null);
    return VOICES.find((v) => v.id === id)?.id ?? VOICES[0].id;
  },
  set: (id: VoiceId) => storage.set(VOICE_KEY, id),
};

// Mono AAC is plenty for speech and keeps uploads small.
const RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
};

// End-of-speech detection, from the recorder's level meter (dBFS).
const TICK_MS = 100;
const SPEECH_START_MS = 200; // this much sound above the room's noise counts as talking
const END_SILENCE_MS = 900; // this much quiet after talking ends the turn
/**
 * Always-listening keeps the audio session alive in the background (the app
 * has the "audio" background mode), and never drops the mic while speaking,
 * because iOS won't let a backgrounded app turn it back on.
 */
let backgroundAudio = false;

function audioMode(allowsRecording: boolean) {
  return {
    allowsRecording: allowsRecording || backgroundAudio,
    playsInSilentMode: true,
    shouldPlayInBackground: backgroundAudio,
    allowsBackgroundRecording: backgroundAudio,
  };
}

const NO_SPEECH_MS = 20_000; // nobody spoke: throw the recording away and start a fresh one
const MAX_UTTERANCE_MS = 15_000;
const SPEECH_DB = 10; // talking is this far above the room's noise...
const QUIET_DB = 6; // ...and it's a pause again once below this
const NOISE_WINDOW = 40; // ticks (4 s) of history for estimating the room's noise
const CALIBRATE_MS = 500; // each recording measures the room this long before listening for speech

// The room's noise level, carried between recordings so each starts calibrated.
let roomNoise = -50;

/** The room's noise: a low percentile of recent levels, so pauses between words count. */
function noiseOf(history: number[]) {
  const sorted = [...history].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.15)];
}

async function authedFetch(
  token: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: any },
  logBody?: string,
) {
  devlog("req", `${init.method} ${path}`, logBody);
  const started = Date.now();
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  } catch (err) {
    devlog("err", `${init.method} ${path} failed after ${Date.now() - started} ms`, String(err));
    throw err;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    devlog("err", `${res.status} ${init.method} ${path} · ${Date.now() - started} ms`, body);
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  devlog("res", `${res.status} ${init.method} ${path} · ${Date.now() - started} ms`);
  return res;
}

/** Turns a recording into text. Deletes the recording afterwards. */
export async function transcribe(token: string, uri: string): Promise<string> {
  const file = new File(uri);
  try {
    const audio = new Uint8Array(await file.arrayBuffer());
    const res = await authedFetch(
      token,
      "/voice/transcribe",
      { method: "POST", headers: { "content-type": "audio/mp4" }, body: audio },
      `${Math.round(audio.byteLength / 1024)} KB of audio`,
    );
    const { text } = (await res.json()) as { text: string };
    devlog("voice", text ? `heard: "${text}"` : "heard nothing (noise)");
    return text;
  } finally {
    try {
      file.delete();
    } catch {}
  }
}

/** Sentences grouped into pieces, the first one short so playback starts quickly. */
function speechChunks(text: string) {
  const sentences = text.match(/[^.!?\n]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    const limit = chunks.length === 0 ? 120 : 500;
    if (current && current.length + s.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current} ${s}` : s;
  }
  if (current) chunks.push(current);
  // Skip pieces with nothing to pronounce (e.g. a lone "...").
  return chunks.filter((c) => /[\p{L}\p{N}]/u.test(c));
}

let clipCount = 0;

async function fetchClip(token: string, text: string, voice: VoiceId) {
  const res = await authedFetch(
    token,
    "/voice/speak",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }) },
    `${voice}: "${text}"`,
  );
  const file = new File(Paths.cache, `ovoa-speech-${Date.now()}-${clipCount++}.mp3`);
  file.write(new Uint8Array(await res.arrayBuffer()));
  return file;
}

/** Plays one file to the end, or until `stop` is called. */
function playFile(file: File, onStop: (stop: () => void) => void) {
  return new Promise<void>((resolve) => {
    const player = createAudioPlayer(file.uri);
    let done = false;
    let started = false;
    // If the clip never starts (bad file, audio session trouble), don't hang on "Speaking".
    const watchdog = setTimeout(() => {
      if (!started) {
        devlog("err", "reply audio never started playing; skipping it");
        finish();
      }
    }, 8000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      sub.remove();
      player.remove();
      try {
        file.delete();
      } catch {}
      resolve();
    };
    const sub = player.addListener("playbackStatusUpdate", (s) => {
      if (s.playing && !started) {
        started = true;
        devlog("voice", `playing reply audio (${s.duration.toFixed(1)}s)`);
      }
      // Some players never send didJustFinish; reaching the end counts too.
      if (s.didJustFinish || (started && !s.playing && s.duration > 0 && s.currentTime >= s.duration - 0.1)) finish();
    });
    onStop(() => {
      player.pause();
      finish();
    });
    player.play();
  });
}

/** Reads text aloud. `speak` resolves when it's done or `stop` is called. */
export function createSpeaker(token: string) {
  let stopCurrent: (() => void) | null = null;
  let generation = 0;

  const stop = () => {
    generation++;
    stopCurrent?.();
    stopCurrent = null;
  };

  /** `keepMic`: keep the microphone usable so the user can talk over the reply. */
  const speak = async (text: string, { keepMic = false } = {}) => {
    stop();
    const mine = generation;
    const voice = await voicePref.get();
    await setAudioModeAsync(audioMode(keepMic));
    const chunks = speechChunks(text);
    // Fetch the next piece while the current one plays.
    let next = chunks.length ? fetchClip(token, chunks[0], voice) : null;
    for (let i = 0; i < chunks.length && next; i++) {
      const file = await next;
      next = i + 1 < chunks.length ? fetchClip(token, chunks[i + 1], voice) : null;
      if (mine !== generation) {
        file.delete();
        break;
      }
      await playFile(file, (s) => (stopCurrent = s));
      if (mine !== generation) break;
    }
    // Clean up a clip fetched ahead that won't be played.
    next?.then((f) => f.delete()).catch(() => {});
  };

  return { speak, stop };
}

type Speaker = ReturnType<typeof createSpeaker>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function discard(uri: string | null) {
  try {
    if (uri) new File(uri).delete();
  } catch {}
}

/**
 * Records one utterance: waits for the user to start talking, then stops after
 * a short silence. Returns the file uri, or null if nobody spoke or it was cancelled.
 */
async function recordUtterance(
  recorder: AudioRecorder,
  cancelled: () => boolean,
  onLevel: (level: number) => void,
  noSpeechMs = NO_SPEECH_MS,
) {
  await setAudioModeAsync(audioMode(true));
  await recorder.prepareToRecordAsync(RECORDING);
  recorder.record();

  const started = Date.now();
  // Seed the history with the last known room noise so the first ticks are sensible.
  const history: number[] = Array(10).fill(roomNoise);
  let floor = roomNoise;
  let speechMs = 0;
  let silenceMs = 0;
  let heard = false;
  let peak = -160;
  let threshold = floor + SPEECH_DB;
  let meterMissing = false;

  while (true) {
    await sleep(TICK_MS);
    if (cancelled()) break;
    const metering = recorder.getStatus().metering;
    if (metering === undefined && !meterMissing) {
      meterMissing = true;
      devlog("err", "recorder isn't reporting mic levels (metering), so speech can't be detected");
    }
    const level = metering ?? -160;
    onLevel(level);
    peak = Math.max(peak, level);
    // Learn the room's noise until they start talking, then hold it steady.
    if (!heard && level > -160) {
      history.push(level);
      if (history.length > NOISE_WINDOW) history.shift();
      floor = noiseOf(history);
      threshold = Math.min(-15, Math.max(floor + SPEECH_DB, -50));
    }
    if (Date.now() - started < CALIBRATE_MS) continue;
    if (!heard) {
      // Waiting for them to start talking.
      if (level > threshold) {
        speechMs += TICK_MS;
        if (speechMs >= SPEECH_START_MS) {
          heard = true;
          devlog("voice", "speech started", `${Math.round(level)} dB, room ${Math.round(floor)} dB`);
        }
      } else speechMs = 0;
    } else if (level < Math.min(threshold, floor + QUIET_DB)) {
      silenceMs += TICK_MS; // a pause
    } else {
      silenceMs = 0;
    }
    const elapsed = Date.now() - started;
    if (heard && silenceMs >= END_SILENCE_MS) break;
    if (!heard && elapsed >= noSpeechMs) break;
    if (elapsed >= MAX_UTTERANCE_MS) break;
  }

  await recorder.stop();
  onLevel(-160);
  roomNoise = floor;
  const uri = recorder.uri;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const levels = `peak ${Math.round(peak)} dB, noise ${Math.round(floor)} dB, speech above ${Math.round(threshold)} dB`;
  if (cancelled()) {
    discard(uri);
    return null;
  }
  if (!heard) {
    devlog("voice", `no speech in ${seconds}s, listening again`, levels);
    discard(uri);
    return null;
  }
  if (!uri) {
    devlog("err", "recording finished but has no file");
    return null;
  }
  devlog("voice", `recorded ${seconds}s of speech`, levels);
  return uri;
}

// ---------- Talking over the reply ----------
// Expo Go can't turn on the iPhone's echo cancellation, so the microphone also
// hears the reply. While it plays we record short pieces and transcribe them:
// words that aren't in the reply mean the user is talking.

const BARGE_IN_CHUNK_MS = 1800;
const FOLLOW_UP_MS = 1500; // after an interruption, how long to wait for the rest of the sentence
const STOP_WORDS = new Set(["stop", "wait", "cancel", "quiet", "enough", "pause", "hold", "shut"]);
const FILLER = new Set(["ovoa", "ok", "okay", "please", "it", "that", "up", "on", "now", "hey", "no", "just", "right"]);

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

// How sure we need to be that it's the user and not the reply's echo (misheard
// echo often has a word or two that isn't in the reply).
const MIN_NEW_WORDS = 3;
const MIN_NEW_SHARE = 0.7;

/** What the user said over the reply, or "" if it was only the reply's own echo. */
function saidOverReply(heard: string, reply: string) {
  const said = wordsOf(heard);
  if (!said.length) return "";
  const replyWords = new Set(wordsOf(reply));
  const fresh = said.filter((w) => !replyWords.has(w));
  // "stop" / "okay stop" on its own, not a stop word inside a longer (probably echoed) phrase.
  if (onlyStop(heard) && !said.some((w) => STOP_WORDS.has(w) && replyWords.has(w))) return heard;
  return fresh.length >= MIN_NEW_WORDS && fresh.length / said.length >= MIN_NEW_SHARE ? heard : "";
}

/** "stop", "okay stop", "hold on": the user only wanted it to be quiet. */
function onlyStop(text: string) {
  const said = wordsOf(text);
  return said.some((w) => STOP_WORDS.has(w)) && said.every((w) => STOP_WORDS.has(w) || FILLER.has(w));
}

/**
 * Plays the reply while listening in short pieces. Returns what the user said
 * over it if they interrupted, or null if it played to the end.
 */
async function speakInterruptible(
  token: string,
  recorder: AudioRecorder,
  speaker: Speaker,
  reply: string,
  cancelled: () => boolean,
  onLevel: (level: number) => void,
) {
  const state = { done: false, said: null as string | null };
  const playing = speaker.speak(reply, { keepMic: true }).finally(() => (state.done = true));
  const checks: Promise<void>[] = [];

  while (!state.done && state.said === null && !cancelled()) {
    await recorder.prepareToRecordAsync(RECORDING);
    recorder.record();
    const started = Date.now();
    while (!state.done && state.said === null && !cancelled() && Date.now() - started < BARGE_IN_CHUNK_MS) {
      await sleep(TICK_MS);
      onLevel(recorder.getStatus().metering ?? -160);
    }
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) continue;
    if (cancelled()) {
      discard(uri);
      break;
    }
    // Check this piece while the next one records.
    checks.push(
      transcribe(token, uri)
        .then((heard) => {
          const said = saidOverReply(heard, reply);
          if (heard) devlog("voice", said ? "that was you: interrupting" : "that was the reply's own echo; ignoring");
          if (said && state.said === null) {
            state.said = said;
            speaker.stop();
          }
        })
        .catch(() => {}),
    );
  }
  onLevel(-160);
  await playing.catch(() => {});
  // The last piece may have caught the start of what they said next.
  await Promise.all(checks);
  return state.said;
}

export type VoicePhase = "off" | "listening" | "thinking" | "speaking";

const RETRY_MS = 3000;

/**
 * Hands-free, continuous listening: hear something, send it, read the reply
 * aloud, listen again, until `end` is called. `onUserSaid` sends the words to
 * the assistant and returns the reply to read aloud (or null to skip speaking).
 * With `interruptible`, the user can talk over the reply to cut it off.
 */
export function useConversation(
  token: string,
  onUserSaid: (text: string) => Promise<string | null>,
  { interruptible = false, background = false } = {},
) {
  const recorder = useAudioRecorder(RECORDING);
  const [phase, setPhaseState] = useState<VoicePhase>("off");
  const phaseRef = useRef<VoicePhase>("off");
  const setPhase = (p: VoicePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const [level, setLevel] = useState(-160);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(0);
  // The previous listening loop, so a new one never shares the recorder with it.
  const running = useRef(Promise.resolve());
  const speaker = useRef(createSpeaker(token));
  const handler = useRef(onUserSaid);
  handler.current = onUserSaid;
  const bargeIn = useRef(interruptible);
  bargeIn.current = interruptible;
  // Live transcription when this Expo Go has the PCM stream; recording + upload otherwise.
  const stream = useLiveStream();
  const liveFailures = useRef(0);
  const [words, setWords] = useState("");

  useEffect(() => {
    speaker.current = createSpeaker(token);
  }, [token]);

  const end = useCallback(() => {
    if (phaseRef.current !== "off") devlog("voice", "stopped listening");
    session.current++;
    speaker.current.stop();
    setPhase("off");
    setLevel(-160);
    setWords("");
  }, []);

  // Stop everything when the owner goes away.
  useEffect(() => end, [end]);

  const start = useCallback(async () => {
    setError(null);
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      devlog("err", "microphone permission denied");
      setError("Allow microphone access in Settings to talk to the assistant.");
      return false;
    }
    const mine = ++session.current;
    const cancelled = () => session.current !== mine;
    const previous = running.current;
    let finished = () => {};
    running.current = new Promise<void>((r) => (finished = r));
    await previous;
    backgroundAudio = background;
    if (background) {
      await setAudioModeAsync(audioMode(true)).catch((err) => devlog("err", "background audio mode failed", String(err)));
      devlog("voice", "background listening on");
    }

    /** One sentence from the user, or "" if nobody spoke. */
    const hear = async (noSpeechMs: number, before = "") => {
      if (stream && liveFailures.current < 2) {
        try {
          const text = await listenLive(stream, token, {
            cancelled,
            onWords: (w) => setWords(`${before} ${w}`.trim()),
            onLevel: setLevel,
            noSpeechMs,
            maxMs: MAX_UTTERANCE_MS * 2,
            keepRunning: background,
          });
          liveFailures.current = 0;
          return text;
        } catch (err) {
          liveFailures.current++;
          devlog(
            "err",
            liveFailures.current < 2 ? "live transcription failed; using recording for this turn" : "live transcription keeps failing; switching to recording",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const uri = await recordUtterance(recorder, cancelled, setLevel, noSpeechMs);
      if (!uri || cancelled()) return "";
      setPhase("thinking");
      return transcribe(token, uri);
    };

    // Words the user said over the last reply; the rest of their sentence follows.
    let carried: string | null = null;
    devlog(
      "voice",
      `started listening (${stream && liveFailures.current < 2 ? "live" : "recording"}${bargeIn.current ? ", talk-over on" : ""})`,
    );

    while (!cancelled()) {
      try {
        setPhase("listening");
        setWords(carried ?? "");
        let text: string;
        if (carried !== null) {
          const rest = await hear(FOLLOW_UP_MS, carried);
          if (cancelled()) break;
          text = `${carried} ${rest}`.trim();
          carried = null;
          if (onlyStop(text)) continue; // they just wanted it to stop talking
        } else {
          text = await hear(NO_SPEECH_MS);
          if (cancelled()) break;
        }
        if (!text) continue; // nobody spoke, or just noise
        setPhase("thinking");
        setError(null);
        setWords(text);
        devlog("voice", "asking the assistant", text);
        const reply = await handler.current(text);
        if (cancelled()) break;
        devlog("voice", reply ? "assistant replied" : "no reply to read out", reply ?? undefined);
        if (reply) {
          setPhase("speaking");
          setWords("");
          if (bargeIn.current) {
            carried = await speakInterruptible(token, recorder, speaker.current, reply, cancelled, setLevel);
          } else {
            await speaker.current.speak(reply);
          }
        }
      } catch (err) {
        // Usually a dropped connection: say so, wait a moment, and keep going.
        if (cancelled()) break;
        devlog("err", "voice loop error, retrying in 3 s", err instanceof Error ? err.message : String(err));
        setError(err instanceof Error ? err.message : "Voice stopped working");
        if (recorder.getStatus().isRecording) await recorder.stop().catch(() => {});
        await sleep(RETRY_MS);
      }
    }
    if (background) {
      stream?.stop();
      backgroundAudio = false;
      await setAudioModeAsync(audioMode(false)).catch(() => {});
    }
    finished();
    return true;
  }, [recorder, stream, token, background]);

  /** While speaking: cut the reply short and listen again. */
  const interrupt = useCallback(() => speaker.current.stop(), []);

  return { phase, level, error, setError, words, start, end, interrupt };
}

const ALWAYS_LISTEN_KEY = "ovoa.alwaysListen";

/** Danger zone "Always listen": listen on every screen and allow talking over replies. */
export const alwaysListenPref = {
  get: async () => (await storage.get(ALWAYS_LISTEN_KEY).catch(() => null)) === "1",
  set: (on: boolean) => storage.set(ALWAYS_LISTEN_KEY, on ? "1" : "0"),
};

const LISTENING_KEY = "ovoa.alwaysListening";

/** Whether the user left the Assistant tab's orb on, so it resumes when they come back. */
export const listeningPref = {
  get: async () => (await storage.get(LISTENING_KEY).catch(() => null)) === "1",
  set: (on: boolean) => storage.set(LISTENING_KEY, on ? "1" : "0"),
};
