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
import { AppState } from "react-native";
import { API_URL, ApiError } from "./api";
import { devlog } from "./devlog";
import { openEar, stopStream, useLiveStream } from "./liveListen";
import { storage } from "./storage";
import { onlyStop, saidOverReply, TurnGate, type GateResult, type Turn } from "./turnGate";
import { readProfiles, type TwistProfile, type TwistProfiles } from "./twist";

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

let appliedMode = "";

/** Applies an audio mode, skipping it when nothing would change (every change can stall the mic). */
async function applyAudioMode(allowsRecording: boolean) {
  const mode = audioMode(allowsRecording);
  const key = JSON.stringify(mode);
  if (key === appliedMode) return;
  await setAudioModeAsync(mode);
  appliedMode = key;
}

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
export async function transcribe(token: string, uri: string, contentType = "audio/mp4"): Promise<string> {
  const file = new File(uri);
  try {
    const audio = new Uint8Array(await file.arrayBuffer());
    const res = await authedFetch(
      token,
      "/voice/transcribe",
      { method: "POST", headers: { "content-type": contentType }, body: audio },
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
    const limit = chunks.length === 0 ? 120 : 260;
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
    // keepAudioSessionActive: otherwise expo-audio turns the session off when the clip ends,
    // which stopped the live mic stream after every reply ("no audio from the mic").
    const player = createAudioPlayer(file.uri, { keepAudioSessionActive: true });
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

/** How many clips are voiced ahead of the one playing. */
const FETCH_AHEAD = 3;
/** A first sentence longer than this is split at a comma so the voice starts sooner. */
const FIRST_PIECE_MAX = 70;

/**
 * Reads text aloud. `open` starts a reply that arrives a sentence at a time
 * (each piece is voiced as soon as it's known, a few ahead of the one playing);
 * `speak` reads a whole text. Both finish when done or when `stop` is called.
 */
export function createSpeaker(token: string) {
  let stopCurrent: (() => void) | null = null;
  let wakeCurrent: (() => void) | null = null;
  let generation = 0;

  const stop = () => {
    generation++;
    stopCurrent?.();
    stopCurrent = null;
    wakeCurrent?.();
  };

  /** `keepMic`: keep the microphone usable so the user can talk over the reply. */
  const open = ({ keepMic = false } = {}) => {
    stop();
    const mine = generation;
    const pieces: string[] = [];
    const clips: Promise<File | null>[] = [];
    let ended = false;
    let pending = ""; // short sentences wait to be joined with the next one
    const voice = voicePref.get();
    const ready = applyAudioMode(keepMic).catch((err) => devlog("err", "audio mode failed", String(err)));
    const wake = () => wakeCurrent?.();

    const fetchUpTo = (index: number) => {
      for (let i = clips.length; i < pieces.length && i <= index; i++) {
        clips.push(
          voice
            .then((v) => fetchClip(token, pieces[i], v))
            .catch((err) => {
              devlog("err", "couldn't voice part of the reply", err instanceof Error ? err.message : String(err));
              return null;
            }),
        );
      }
    };
    const addPiece = (text: string) => {
      if (!/[\p{L}\p{N}]/u.test(text)) return; // nothing to pronounce (e.g. a lone "...")
      pieces.push(text);
      // The first piece goes out at once; later ones queue a few ahead of playback.
      if (pieces.length === 1) fetchUpTo(0);
      wake();
    };

    /** Adds the next sentence of the reply. */
    const say = (sentence: string) => {
      if (mine !== generation) return;
      const text = pending ? `${pending} ${sentence}` : sentence;
      pending = "";
      // A long first sentence takes seconds to voice (110 characters: 2.5 s): start with
      // the part before its first comma or dash, and voice the rest meanwhile.
      if (pieces.length === 0 && text.length > FIRST_PIECE_MAX) {
        const cut = text.slice(20, FIRST_PIECE_MAX).search(/[,;:—–]\s/);
        if (cut >= 0) {
          addPiece(text.slice(0, 20 + cut + 1));
          addPiece(text.slice(20 + cut + 1).trim());
          return;
        }
      }
      // The first piece is spoken as soon as it arrives; after that, very short sentences
      // ("Sure.") ride along with the next one so the voice doesn't stop and start.
      if (pieces.length > 0 && text.length < 40) {
        pending = text;
        return;
      }
      addPiece(text);
    };

    const end = () => {
      if (pending) addPiece(pending);
      pending = "";
      ended = true;
      wake();
    };

    let played = 0;
    const done = (async () => {
      await ready;
      for (let i = 0; mine === generation; i++) {
        played = i;
        while (i >= pieces.length && !ended && mine === generation) {
          await new Promise<void>((r) => (wakeCurrent = r));
        }
        if (i >= pieces.length || mine !== generation) break;
        fetchUpTo(i + FETCH_AHEAD);
        const file = await clips[i];
        if (mine !== generation) {
          file?.delete();
          break;
        }
        played = i + 1; // playFile deletes it
        if (file) await playFile(file, (s) => (stopCurrent = s));
        fetchUpTo(i + 1 + FETCH_AHEAD);
      }
      // Clean up clips voiced ahead that won't be played.
      clips.slice(played).forEach((c) =>
        c.then((f) => {
          try {
            f?.delete();
          } catch {}
        }),
      );
    })();

    return { say, end, done };
  };

  const speak = async (text: string, { keepMic = false } = {}) => {
    const reply = open({ keepMic });
    speechChunks(text).forEach(reply.say);
    reply.end();
    await reply.done;
  };

  return { open, speak, stop };
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
  await applyAudioMode(true);
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
const INTERRUPTED = Symbol("interrupted");
const LIVE_RETRY_MS = 60_000;

/**
 * Hands-free, continuous listening: hear something, send it, read the reply
 * aloud, listen again, until `end` is called. `onUserSaid` sends the words to
 * the assistant and returns the reply to read aloud (or null to skip speaking).
 * With `interruptible`, the user can talk over the reply to cut it off. With
 * `background` (Always listen) it only answers when called by `name`. With
 * `standby` (twist mode) the microphone runs between turns, nothing sent, so a
 * twist can start a turn while the app is in the background.
 */
export function useConversation(
  token: string,
  onUserSaid: (
    text: string,
    addressed: boolean,
    onSentence?: (sentence: string) => void,
    signal?: AbortSignal,
  ) => Promise<string | null>,
  { interruptible = false, background = false, standby = false, name = "OVOA" } = {},
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
  const standbyRef = useRef(standby);
  standbyRef.current = standby;
  /** Audio stays up in the background: Always listen, or the twist standby. */
  const keepsAudio = () => background || standbyRef.current;

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
    backgroundAudio = keepsAudio();
    if (backgroundAudio) {
      await applyAudioMode(true).catch((err) => devlog("err", "background audio mode failed", String(err)));
      if (background) devlog("voice", "background listening on");
    }

    /**
     * Sends what they said and reads the reply aloud while it's still being
     * written: the first sentence plays as soon as the server has it. `onSpeaking`
     * gets the reply so far each time a sentence is added. Resolves once the reply
     * has been spoken (or cut off); false if there was nothing to say.
     */
    const answerAloud = async (
      text: string,
      addressed: boolean,
      { keepMic, onSpeaking }: { keepMic: boolean; onSpeaking?: (soFar: string) => void },
    ) => {
      setPhase("thinking");
      setError(null);
      setWords(text);
      const asked = Date.now();
      devlog("voice", addressed ? "heard its name; asking the assistant" : "asking the assistant", text);
      const reply = speaker.current.open({ keepMic });
      let soFar = "";
      const onSentence = (sentence: string) => {
        if (cancelled()) return;
        if (!soFar) {
          devlog("voice", `speaking ${Date.now() - asked} ms after the question`);
          setPhase("speaking");
          setWords("");
        }
        soFar = soFar ? `${soFar} ${sentence}` : sentence;
        onSpeaking?.(soFar);
        reply.say(sentence);
      };
      // Before end() the speech only finishes if it's stopped: the user talked over it.
      // Then stop waiting for the rest of the reply and drop the request.
      const abort = new AbortController();
      const interrupted = reply.done.then((): typeof INTERRUPTED => INTERRUPTED);
      let full: string | null;
      try {
        const asking = handler.current(text, addressed, onSentence, abort.signal);
        asking.catch(() => {}); // dropped after an interruption: its failure is expected
        const result = await Promise.race([asking, interrupted]);
        if (result === INTERRUPTED) {
          abort.abort();
          return true;
        }
        full = result;
      } catch (err) {
        reply.end();
        speaker.current.stop();
        throw err;
      }
      if (cancelled()) {
        speaker.current.stop();
        return false;
      }
      devlog("voice", full ? "assistant replied" : "no reply to read out", full ?? undefined);
      // Nothing was streamed (an older server): read the whole reply now.
      if (full && !soFar) {
        setPhase("speaking");
        setWords("");
        onSpeaking?.(full);
        speechChunks(full).forEach(reply.say);
      }
      reply.end();
      if (!full && !soFar) return false;
      await reply.done.catch((err) => devlog("err", "couldn't read the reply out", err instanceof Error ? err.message : String(err)));
      return true;
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
      }, { reuse: keepsAudio() });
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
          let spoke: boolean;
          try {
            // The microphone keeps streaming while the reply plays; the gate hears
            // the reply so far, to tell its echo from the user talking over it.
            spoke = await answerAloud(turn.text, turn.addressed, { keepMic: true, onSpeaking: (soFar) => gate.speak(soFar) });
          } catch (err) {
            if (cancelled()) break;
            devlog("err", "couldn't get a reply", err instanceof Error ? err.message : String(err));
            setError(err instanceof Error ? err.message : "Couldn't reach the assistant");
            continue;
          }
          if (cancelled() || !spoke) continue;
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
      if (keepsAudio() && stream && !stream.isStreaming) {
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
      const addressed = Date.now() < summonedUntil.current;
      if (!bargeIn.current) {
        await answerAloud(text, addressed, { keepMic: false });
        return;
      }
      // Talking over the reply without live transcription needs the whole reply first.
      setPhase("thinking");
      setWords(text);
      devlog("voice", "asking the assistant", text);
      const reply = await handler.current(text, addressed);
      if (cancelled() || !reply) return;
      setPhase("speaking");
      setWords("");
      carried = await speakInterruptible(token, recorder, speaker.current, reply, cancelled, setLevel);
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
            if (!keepsAudio()) stopStream(stream);
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
    // The twist standby keeps the microphone (and the app) running for the next twist.
    if (!standbyRef.current) {
      stopStream(stream);
      if (backgroundAudio) {
        backgroundAudio = false;
        await applyAudioMode(false).catch(() => {});
      }
    }
    finished();
    return true;
  }, [recorder, stream, token, background]);

  // Twist standby: iOS won't let a backgrounded app start the microphone, and suspends one with
  // no audio running. So in twist mode the mic stream runs between turns (its audio goes
  // nowhere) and a twist in another app can start a turn. It can only be started in the
  // foreground; if iOS stops it (a phone call, another app's audio) it's started again, and
  // failing that, the next time the app is opened.
  useEffect(() => {
    if (!standby || !stream) return;
    let stopped = false;
    let lastAudioAt = Date.now();
    let failedOnce = false;
    const sub = stream.addListener("audioStreamBuffer", () => (lastAudioAt = Date.now()));
    const hold = async (why: string) => {
      if (stopped || phaseRef.current !== "off") return;
      if (stream.isStreaming && Date.now() - lastAudioAt < STANDBY_SILENT_MS) return;
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted || stopped || phaseRef.current !== "off") return;
      backgroundAudio = true;
      try {
        await applyAudioMode(true);
        if (stream.isStreaming) stopStream(stream);
        await stream.start();
        lastAudioAt = Date.now();
        failedOnce = false;
        devlog("voice", `twist standby: microphone on (${why}); nothing is sent until a twist`);
      } catch (err) {
        if (failedOnce) return;
        failedOnce = true;
        devlog("err", `twist standby: couldn't turn the microphone on (${why}, app ${AppState.currentState})`, err instanceof Error ? err.message : String(err));
      }
    };
    hold("twist mode").catch(() => {});
    const timer = setInterval(() => hold("it had stopped").catch(() => {}), STANDBY_CHECK_MS);
    const appState = AppState.addEventListener("change", (s) => {
      if (s === "active") hold("app opened").catch(() => {});
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      appState.remove();
      sub.remove();
      // A turn in progress keeps the mic; its loop stops it at the end now that standby is off.
      if (phaseRef.current === "off") {
        stopStream(stream);
        devlog("voice", "twist standby: microphone off");
        if (!background) {
          backgroundAudio = false;
          applyAudioMode(false).catch(() => {});
        }
      }
    };
  }, [standby, stream, background]);

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

  /** A second click while listening: send what's been said now. False when nothing has been said yet. */
  const finishNow = useCallback(() => gateRef.current?.done() ?? false, []);

  /** The phase right now (the state can be a render behind). */
  const currentPhase = useCallback(() => phaseRef.current, []);

  return { phase, currentPhase, level, error, setError, words, start, end, interrupt, summon, finishNow };
}

/** Twist standby: how often the mic is checked, and how long without audio means iOS stopped it. */
const STANDBY_CHECK_MS = 5000;
const STANDBY_SILENT_MS = 3000;

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

// One profile per kind of motion sensor (gyroscope, accelerometer). The key changed with the
// format: a profile saved under the old "ovoa.twistProfile" was for the game stream, which the
// ES100 doesn't have.
const TWIST_PROFILES_KEY = "ovoa.twistProfiles";

const twistProfileListeners = new Set<() => void>();

/**
 * What calibration learned about this user's twist, per kind of sensor. `calibrating` pauses
 * detection while calibration (or the twist test in Dev tools) runs.
 */
export const twistProfilePref = {
  calibrating: false,
  onChange: (l: () => void) => {
    twistProfileListeners.add(l);
    return () => {
      twistProfileListeners.delete(l);
    };
  },
  get: async (): Promise<TwistProfiles> => {
    try {
      const raw = await storage.get(TWIST_PROFILES_KEY);
      return raw ? readProfiles(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  },
  /** Saves a profile, keeping the one for the other kind of sensor. */
  set: async (profile: TwistProfile) => {
    const saved = await twistProfilePref.get();
    const next: TwistProfiles = profile.kind === "spin" ? { ...saved, spin: profile } : { ...saved, tilt: profile };
    await storage.set(TWIST_PROFILES_KEY, JSON.stringify(next));
    twistProfileListeners.forEach((l) => l());
  },
};
