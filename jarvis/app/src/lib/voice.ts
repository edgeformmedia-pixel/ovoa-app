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
import { openEar, useLiveStream } from "./liveListen";
import { storage } from "./storage";
import { onlyStop, saidOverReply, TurnGate, type GateResult, type Turn } from "./turnGate";
import type { TwistProfile } from "./twist";

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
    // Mixable, like the live mic stream, so switching between them doesn't halt it.
    interruptionMode: "mixWithOthers" as const,
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

// ---------- Talking over the reply (recording fallback) ----------
// When live transcription isn't available, the microphone also hears the reply
// with no way to tell them apart by sound. While it plays we record short pieces
// and transcribe them: words that aren't in the reply mean the user is talking.

const BARGE_IN_CHUNK_MS = 1800;
const FOLLOW_UP_MS = 1500; // after an interruption, how long to wait for the rest of the sentence

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
const LIVE_RETRY_MS = 60_000;

/**
 * Hands-free, continuous listening: hear something, send it, read the reply
 * aloud, listen again, until `end` is called. `onUserSaid` sends the words to
 * the assistant and returns the reply to read aloud (or null to skip speaking).
 * With `interruptible`, the user can talk over the reply to cut it off. With
 * `background` (Always listen) it only answers when called by `name`.
 */
export function useConversation(
  token: string,
  onUserSaid: (text: string, addressed: boolean) => Promise<string | null>,
  { interruptible = false, background = false, name = "OVOA" } = {},
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
  // The previous listening loop, so a new one never shares the microphone with it.
  const running = useRef(Promise.resolve());
  const speaker = useRef(createSpeaker(token));
  const handler = useRef(onUserSaid);
  handler.current = onUserSaid;
  const bargeIn = useRef(interruptible);
  bargeIn.current = interruptible;
  const nameRef = useRef(name);
  nameRef.current = name;
  // Live transcription when this build has the PCM stream; recording + upload otherwise.
  const stream = useLiveStream();
  const liveFailures = useRef(0);
  // After switching to recording, try live transcription again after a while.
  const liveFailedAt = useRef(0);
  const [words, setWords] = useState("");
  // A twist or the clip's button: what's said until then counts as addressed.
  const summonedUntil = useRef(0);
  const gateRef = useRef<TurnGate | null>(null);

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

    /** Sends what they said; returns the reply to read out, if any. */
    const answer = async (text: string, addressed: boolean) => {
      setPhase("thinking");
      setError(null);
      setWords(text);
      devlog("voice", addressed ? "heard its name; asking the assistant" : "asking the assistant", text);
      const reply = await handler.current(text, addressed);
      if (!cancelled()) devlog("voice", reply ? "assistant replied" : "no reply to read out", reply ?? undefined);
      return reply;
    };

    /**
     * Listens over one live connection that stays open through replies: the
     * words go through the turn gate as they arrive, and a request is sent the
     * moment it's complete. Returns when cancelled; throws if the connection is lost.
     */
    const runLive = async (s: NonNullable<typeof stream>) => {
      const gate = new TurnGate(nameRef.current, background, bargeIn.current);
      gateRef.current = gate;
      if (Date.now() < summonedUntil.current) gate.summon(summonedUntil.current);
      const state = { down: null as Error | null, waiting: null as ((turn: Turn | null) => void) | null };
      const wake = (turn: Turn | null) => {
        const w = state.waiting;
        state.waiting = null;
        w?.(turn);
      };
      const handle = (r: GateResult) => {
        if (!r) return;
        if (r.kind === "ignored") devlog("voice", `ignored: ${r.why}`, r.text);
        else if (r.kind === "interrupt") {
          devlog("voice", r.stopOnly ? "told to stop" : "that was you: interrupting");
          speaker.current.stop();
        } else wake(r.turn);
      };
      const showWords = () => {
        if (phaseRef.current === "listening") setWords(gate.live());
      };
      const ear = await openEar(s, token, {
        onLevel: setLevel,
        onInterim: (text) => {
          gate.onInterim(text, Date.now());
          showWords();
        },
        onFinal: (text, sentenceEnd) => {
          handle(gate.onFinal(text, sentenceEnd, Date.now()));
          showWords();
        },
        onQuiet: () => handle(gate.onQuiet()),
        onDown: (err) => {
          state.down = err;
          wake(null);
        },
      });
      const timer = setInterval(() => {
        if (cancelled()) wake(null);
        else handle(gate.tick(Date.now()));
      }, 150);
      devlog(
        "voice",
        `listening live (${background ? `room mode: waiting for "${nameRef.current}"` : "every sentence"}${bargeIn.current ? ", talk-over on" : ""})`,
      );
      try {
        while (!cancelled() && !state.down) {
          setPhase("listening");
          const turn = await new Promise<Turn | null>((resolve) => {
            state.waiting = resolve;
            gate.listen(Date.now());
            setWords(gate.live());
          });
          if (!turn || cancelled()) break;
          gate.think();
          let reply: string | null;
          try {
            reply = await answer(turn.text, turn.addressed);
          } catch (err) {
            if (cancelled()) break;
            devlog("err", "couldn't get a reply", err instanceof Error ? err.message : String(err));
            setError(err instanceof Error ? err.message : "Couldn't reach the assistant");
            continue;
          }
          if (cancelled() || !reply) continue;
          setPhase("speaking");
          setWords("");
          gate.speak(reply);
          // The microphone keeps streaming while the reply plays.
          await speaker.current
            .speak(reply, { keepMic: true })
            .catch((err) => devlog("err", "couldn't read the reply out", err instanceof Error ? err.message : String(err)));
          gate.spoke(Date.now());
        }
      } finally {
        clearInterval(timer);
        if (gateRef.current === gate) gateRef.current = null;
        state.waiting = null;
        ear.close();
      }
      if (state.down) throw state.down;
    };

    // Words the user said over the last reply; the rest of their sentence follows.
    let carried: string | null = null;

    /** One sentence the old way: record until a pause, then upload it. "" if nobody spoke. */
    const hearRecorded = async (noSpeechMs: number) => {
      // In the background, iOS suspends the app the moment no audio is running, which
      // froze the reply request for 15 minutes once. Keep the stream going as a keep-alive.
      if (background && stream && !stream.isStreaming) {
        await stream.start().catch((err) => devlog("err", "background keep-alive mic failed", String(err)));
      }
      const uri = await recordUtterance(recorder, cancelled, setLevel, noSpeechMs);
      if (!uri || cancelled()) return "";
      setPhase("thinking");
      return transcribe(token, uri);
    };

    /** One turn without live transcription: hear, answer, speak. */
    const recordingTurn = async () => {
      setPhase("listening");
      setWords(carried ?? "");
      let text: string;
      if (carried !== null) {
        const rest = await hearRecorded(FOLLOW_UP_MS);
        if (cancelled()) return;
        text = `${carried} ${rest}`.trim();
        carried = null;
        if (onlyStop(text)) return; // they just wanted it to stop talking
      } else {
        text = await hearRecorded(NO_SPEECH_MS);
        if (cancelled()) return;
      }
      if (!text) return; // nobody spoke, or just noise
      const reply = await answer(text, Date.now() < summonedUntil.current);
      if (cancelled() || !reply) return;
      setPhase("speaking");
      setWords("");
      if (bargeIn.current) {
        carried = await speakInterruptible(token, recorder, speaker.current, reply, cancelled, setLevel);
      } else {
        await speaker.current.speak(reply);
      }
    };

    while (!cancelled()) {
      try {
        if (liveFailures.current >= 2 && Date.now() - liveFailedAt.current > LIVE_RETRY_MS) {
          devlog("voice", "trying live transcription again");
          liveFailures.current = 0;
        }
        if (stream && liveFailures.current < 2) {
          try {
            await runLive(stream);
            liveFailures.current = 0;
          } catch (err) {
            if (cancelled()) break;
            liveFailures.current++;
            liveFailedAt.current = Date.now();
            devlog(
              "err",
              liveFailures.current < 2 ? "live transcription failed; trying again" : "live transcription keeps failing; switching to recording",
              err instanceof Error ? err.message : String(err),
            );
            if (!background) stream.stop();
            await sleep(1000);
          }
          continue;
        }
        await recordingTurn();
      } catch (err) {
        // Usually a dropped connection: say so, wait a moment, and keep going.
        if (cancelled()) break;
        devlog("err", "voice loop error, retrying in 3 s", err instanceof Error ? err.message : String(err));
        setError(err instanceof Error ? err.message : "Voice stopped working");
        if (recorder.getStatus().isRecording) await recorder.stop().catch(() => {});
        await sleep(RETRY_MS);
      }
    }
    stream?.stop();
    if (background) {
      backgroundAudio = false;
      await setAudioModeAsync(audioMode(false)).catch(() => {});
    }
    finished();
    return true;
  }, [recorder, stream, token, background]);

  /** While speaking: cut the reply short and listen again. */
  const interrupt = useCallback(() => speaker.current.stop(), []);

  /**
   * A twist (or the clip's button) asked for attention: listen now, and treat the
   * next ~8 s of speech as addressed even without the name. Cuts off a reply.
   */
  const summon = useCallback(() => {
    const until = Date.now() + SUMMON_MS;
    summonedUntil.current = until;
    gateRef.current?.summon(until);
    devlog("voice", "summoned", `phase ${phaseRef.current}`);
    if (phaseRef.current === "speaking") speaker.current.stop();
    if (phaseRef.current === "off") return start();
    return Promise.resolve(true);
  }, [start]);

  return { phase, level, error, setError, words, start, end, interrupt, summon };
}

/** After a twist, how long speech counts as addressed without the name. */
const SUMMON_MS = 8000;

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

export type ListenMode = "wake" | "twist" | "both";
const LISTEN_MODE_KEY = "ovoa.listenMode";

/** How a turn starts: the name (wake), a wrist twist on the ES100 (twist), or either (both). */
export const listenModePref = {
  get: async (): Promise<ListenMode> => {
    const v = await storage.get(LISTEN_MODE_KEY).catch(() => null);
    return v === "twist" || v === "both" ? v : "wake";
  },
  set: (mode: ListenMode) => storage.set(LISTEN_MODE_KEY, mode),
};

const TWIST_PROFILE_KEY = "ovoa.twistProfile";

const twistProfileListeners = new Set<() => void>();

/** What calibration learned about this user's twist. `calibrating` pauses detection meanwhile. */
export const twistProfilePref = {
  calibrating: false,
  onChange: (l: () => void) => {
    twistProfileListeners.add(l);
    return () => {
      twistProfileListeners.delete(l);
    };
  },
  get: async (): Promise<TwistProfile | null> => {
    try {
      const raw = await storage.get(TWIST_PROFILE_KEY);
      return raw ? (JSON.parse(raw) as TwistProfile) : null;
    } catch {
      return null;
    }
  },
  set: async (profile: TwistProfile) => {
    await storage.set(TWIST_PROFILE_KEY, JSON.stringify(profile));
    twistProfileListeners.forEach((l) => l());
  },
};
