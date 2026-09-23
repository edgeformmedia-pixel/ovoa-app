import { createAudioPlayer, requestRecordingPermissionsAsync, setAudioModeAsync, type AudioStatus } from "expo-audio";
import { fetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { API_URL, ApiError, errorText, lockedOnPhone, noteDeadSession, notePlanNeeded, type ServerSpeech } from "./api";
import { devlog, devlogRepeat, devlogSettled, logFail } from "./devlog";
import { pickFiller } from "./fillers";
import { audioWhy, onScreen, whenOnScreen } from "./foreground";
import { flushHeard, keepHeard, keepsHeard } from "./heard";
import { canHearName, canListen, earAlive, holdEar, openEar, releaseEar, wasNameEarFailure, wasOffScreen, type Ear } from "./liveListen";
import { ensureSpeechPermission } from "./onDeviceTranscribe";
import { onSignOut } from "./signOut";
import { storage } from "./storage";
import { TurnGate, type GateResult, type Turn } from "./turnGate";
import { readProfiles, type TwistProfile, type TwistProfiles } from "./twist";
import { endTurn, failTurn, mark as markTurn, markStopTalking, noteHeard, startTurn } from "./turnTimer";

// Talking with the assistant: the phone hears what's said (liveListen.ts: the
// words are recognised on the iPhone, and only they leave it), the words go to
// the assistant, and the reply is read aloud a sentence or two at a time.

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

/**
 * The chosen voice, kept in memory once known: a read that fails (the keychain
 * locked, say) must never fall back to the default mid-conversation.
 */
let knownVoice: VoiceId | null = null;
const voiceListeners = new Set<(id: VoiceId) => void>();

export const voicePref = {
  get: async (): Promise<VoiceId> => {
    const id = await storage.get(VOICE_KEY).catch(() => null);
    const found = VOICES.find((v) => v.id === id)?.id;
    if (found) knownVoice = found;
    return found ?? knownVoice ?? VOICES[0].id;
  },
  set: (id: VoiceId) => {
    knownVoice = id;
    voiceListeners.forEach((l) => l(id));
    return storage.set(VOICE_KEY, id);
  },
  onChange: (listener: (id: VoiceId) => void) => {
    voiceListeners.add(listener);
    return () => void voiceListeners.delete(listener);
  },
};

// ---------- Which engine speaks ----------
//
// The server chooses (voice.ts TTS_ENGINES) and tells the phone through /me
// and on every voiced reply. Only "device" changes anything here: then the
// phone speaks with its own voices and never asks the server for audio.

/** A line the phone will speak itself, in place of an audio file. */
export type DeviceUtterance = { device: true; text: string };
/** Something the speaker can play: a clip on disk, or words for the phone's own voice. */
export type Spoken = File | DeviceUtterance;
export const isDeviceUtterance = (s: Spoken | null | undefined): s is DeviceUtterance => !!s && (s as DeviceUtterance).device === true;

let ttsEngine = "deepgram-aura-2";
const ttsEngineListeners = new Set<(engine: string) => void>();

/** The engine the server said it uses for this person. */
export function setTtsEngine(engine: string | undefined) {
  if (!engine || engine === ttsEngine) return;
  ttsEngine = engine;
  ttsEngineListeners.forEach((l) => l(engine));
}
export const currentTtsEngine = () => ttsEngine;
export const usesDeviceVoice = () => ttsEngine === "device";
export function onTtsEngineChange(listener: (engine: string) => void) {
  ttsEngineListeners.add(listener);
  return () => void ttsEngineListeners.delete(listener);
}

/**
 * The phone's own voice that sounds most like the chosen one. iOS doesn't say
 * which of its voices are which, so this goes by name: the chosen Aura voice's
 * character (a woman's or a man's voice) picks a list, and the first installed
 * voice on it wins, the enhanced version when there is one. Nothing on the
 * list means the system's default voice.
 */
const DEVICE_VOICES: Record<VoiceId, string[]> = {
  "aura-2-thalia-en": ["Ava", "Samantha", "Zoe", "Allison", "Karen", "Nicky"],
  "aura-2-andromeda-en": ["Zoe", "Nicky", "Ava", "Samantha", "Tessa"],
  "aura-2-helena-en": ["Samantha", "Allison", "Ava", "Moira", "Karen"],
  "aura-2-luna-en": ["Allison", "Ava", "Samantha", "Moira", "Zoe"],
  "aura-2-apollo-en": ["Evan", "Nathan", "Tom", "Alex", "Daniel"],
  "aura-2-arcas-en": ["Nathan", "Evan", "Alex", "Daniel", "Aaron"],
  "aura-2-orion-en": ["Tom", "Daniel", "Alex", "Nathan", "Evan"],
  "aura-2-hermes-en": ["Alex", "Evan", "Aaron", "Nathan", "Daniel"],
};
let deviceVoices: Speech.Voice[] | null = null;

async function deviceVoiceFor(voice: VoiceId): Promise<string | undefined> {
  deviceVoices ??= await Speech.getAvailableVoicesAsync().catch(() => []);
  const english = deviceVoices.filter((v) => v.language.toLowerCase().startsWith("en"));
  for (const name of DEVICE_VOICES[voice]) {
    const named = english.filter((v) => v.name.split(" ")[0] === name);
    if (!named.length) continue;
    return (named.find((v) => v.quality === Speech.VoiceQuality.Enhanced) ?? named[0]).identifier;
  }
  return undefined;
}

/**
 * Speaks one piece with the phone's own voice. Resolves when it has been said,
 * or cut off through `onStop`. Free, offline, and about as fast as a voice can start.
 */
export async function speakOnDevice(text: string, onStop?: (stop: () => void) => void, onStart?: () => void) {
  // The stop is handed over before the voice is looked up: a stop that came
  // during that lookup used to be missed, and the line was said anyway (the
  // tour, with Next pressed quickly, talked over its own next card).
  let stopped = false;
  let stopNow = () => {
    stopped = true;
  };
  onStop?.(() => stopNow());
  const voice = await deviceVoiceFor(await voicePref.get()).catch(() => undefined);
  if (stopped) return;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    stopNow = () => {
      Speech.stop();
      finish();
    };
    try {
      Speech.speak(text, { voice, onStart, onDone: finish, onStopped: finish, onError: (err) => {
        devlog("err", "the phone's voice couldn't speak", err instanceof Error ? err.message : String(err));
        finish();
      } });
    } catch (err) {
      devlog("err", "the phone's voice couldn't start", err instanceof Error ? err.message : String(err));
      finish();
    }
  });
}

/** One line voiced in the chosen voice: a file the caller keeps or deletes, or words for the phone's own voice. */
export async function renderSpeech(token: string, text: string): Promise<Spoken> {
  return fetchClip(token, text, await voicePref.get());
}

/**
 * Always listen and the click standby keep the audio session alive in the
 * background (the app has the "audio" background mode), and never drop the mic
 * while speaking, because iOS won't let a backgrounded app turn it back on.
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

/**
 * Something needs the app kept running with the screen off: an alarm armed for
 * tonight, or one going off (nag.ts). Audio is the one background mode iOS lets
 * run indefinitely, so while this is held, playback is allowed in the background.
 */
let awakeHolds = 0;
export async function holdAwake(on: boolean) {
  awakeHolds = Math.max(0, awakeHolds + (on ? 1 : -1));
  await applyAudioMode(false).catch(logFail("voice: applyAudioMode"));
}

function audioMode(allowsRecording: boolean) {
  return {
    allowsRecording: allowsRecording || backgroundAudio,
    playsInSilentMode: true,
    shouldPlayInBackground: backgroundAudio || awakeHolds > 0,
    allowsBackgroundRecording: backgroundAudio,
    // Mixable, like the phone's ear, so switching between them doesn't halt it.
    interruptionMode: "mixWithOthers" as const,
  };
}

async function authedFetch(
  token: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: any },
  logBody?: string,
) {
  // OVOA's voice is Base's: a phone known to be free doesn't ask (api.ts lockedOnPhone).
  const locked = lockedOnPhone(init.method, path);
  if (locked) throw locked;
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
    devlog(body.error === "needs_plan" ? "log" : "err", `${res.status} ${init.method} ${path} · ${Date.now() - started} ms`, body);
    noteDeadSession(res.status, token, body.error);
    throw new ApiError(errorText(body, res.status), res.status, {}, notePlanNeeded(body));
  }
  devlog("res", `${res.status} ${init.method} ${path} · ${Date.now() - started} ms`);
  return res;
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

async function fetchClip(token: string, text: string, voice: VoiceId): Promise<Spoken> {
  // The phone's own voice: nothing to fetch.
  if (usesDeviceVoice()) return { device: true, text };
  const asked = Date.now();
  const res = await authedFetch(
    token,
    "/voice/speak",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }) },
    `${voice}: ${text.length} chars`,
  );
  // The server switched to the phone's voice since /me was read: it sends no
  // audio and says so. From here on nothing is asked of it.
  if (res.status === 204 || res.headers.get("x-tts-engine") === "device") {
    setTtsEngine("device");
    return { device: true, text };
  }
  // expo/fetch resolves on the headers, so this is time to first byte; the whole clip
  // is buffered before a note of it plays, and that second leg is the wait the user
  // actually hears. Timed apart because they have different causes and different fixes.
  const firstByte = Date.now() - asked;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const whole = Date.now() - asked;
  const file = new File(Paths.cache, `ovoa-speech-${Date.now()}-${clipCount++}.mp3`);
  file.write(bytes);
  devlog(
    "voice",
    `voiced ${text.length} chars in ${whole} ms`,
    `${firstByte} ms to first byte · ${whole - firstByte} ms for the rest · ` +
      `${Math.round(bytes.byteLength / 1024)} KB · ${Date.now() - asked} ms to disk`,
  );
  return file;
}

/** Audio the server voiced (base64 mp3), written where fetchClip writes its own. */
function saveClip(mp3: string) {
  const file = new File(Paths.cache, `ovoa-speech-${Date.now()}-${clipCount++}.mp3`);
  file.write(mp3, { encoding: "base64" });
  return file;
}

/**
 * A clip already on disk either starts quickly or never does. This used to be 8 s,
 * and 11 of 19 addressed turns spent all 8 in silence on a cached filler that should
 * have played instantly (device_logs, 2026-09-21). Three seconds rather than one and
 * a half: giving up too early costs a real sentence of the reply, and the new line
 * below carries the player's status, so one build of data says whether it can go lower.
 */
const CLIP_START_MS = 3000;
/**
 * Status updates every 250 ms rather than the 500 ms default. Not lower: this path
 * shares the audio session with a live microphone, and the extra callbacks buy
 * measurement precision, not a faster first word.
 */
const STATUS_MS = 250;
/**
 * A clip that started and then stopped making progress for this long has been
 * paused by something outside the app and is not coming back on its own.
 * Generous, because a long sentence between status updates is normal and cutting
 * a reply short is worse than waiting.
 */
const CLIP_STALL_MS = 4000;

/** Plays whichever kind of piece this is: a clip from disk, or words for the phone's own voice. */
function playPiece(piece: Spoken, onStop: (stop: () => void) => void, onStart?: () => void) {
  return isDeviceUtterance(piece) ? speakOnDevice(piece.text, onStop, onStart) : playFile(piece, onStop, onStart);
}

/** Throws away a piece that won't be played. Only a file has anything to throw away. */
function discardPiece(piece: Spoken | null) {
  if (!piece || isDeviceUtterance(piece)) return;
  try {
    piece.delete();
  } catch {}
}

/** Plays one file to the end, or until `stop` is called. */
function playFile(file: File, onStop: (stop: () => void) => void, onStart?: () => void) {
  return new Promise<void>((resolve) => {
    const uri = file.uri;
    // Everything here is written to disk before it arrives, so no bytes means whoever
    // wrote it didn't finish. Say so rather than waiting on a player that can't start.
    let bytes = -1;
    try {
      bytes = file.size;
    } catch {}
    if (bytes <= 0) {
      devlog("err", "a clip has no audio in it; skipping it", `${bytes} bytes · ${uri}`);
      try {
        file.delete();
      } catch {}
      resolve();
      return;
    }
    // keepAudioSessionActive: otherwise expo-audio turns the session off when the clip ends,
    // which stopped the live mic stream after every reply ("no audio from the mic").
    const player = createAudioPlayer(uri, { keepAudioSessionActive: true, updateInterval: STATUS_MS });
    const asked = Date.now();
    let done = false;
    let started = false;
    let last: AudioStatus | null = null;
    // If the clip never starts, don't hang on "Speaking" — and say what the player was
    // doing. The old line said only that it hadn't started, which took a database query
    // to get to the bottom of.
    const watchdog = setTimeout(() => {
      if (!started) {
        devlog(
          "err",
          `a clip never started playing after ${Date.now() - asked} ms; skipping it`,
          `${bytes} bytes · ${uri}\n    ${last ? status(last) : "no status update ever arrived"}`,
        );
        finish();
      }
    }, CLIP_START_MS);
    /**
     * And a second watchdog for a clip that started and then stopped part-way.
     * iOS pauses every player when a route goes away — unplug the earbuds mid-reply
     * and expo-audio's handleAudioSessionRouteChange pauses this one with nothing
     * to resume it. Neither didJustFinish nor the end-of-clip test below can ever
     * be true after that, so the promise would never settle and the whole voice
     * loop would sit in `await playFile` for good.
     */
    let progressAt = Date.now();
    let farthest = -1;
    const stalled = setInterval(() => {
      if (done || !started) return;
      const at = last?.currentTime ?? 0;
      if (at > farthest) {
        farthest = at;
        progressAt = Date.now();
        return;
      }
      if (Date.now() - progressAt < CLIP_STALL_MS) return;
      devlog(
        "err",
        `a clip stopped ${farthest.toFixed(1)} s in and never resumed; moving on`,
        `${last ? status(last) : "no status"}\n    ${bytes} bytes · ${uri}`,
      );
      finish();
    }, STATUS_MS * 2);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      clearInterval(stalled);
      sub.remove();
      // remove() does not stop playback, and a clip abandoned by a watchdog is
      // still making a noise the next one would talk over.
      try {
        player.pause();
      } catch {}
      player.remove();
      try {
        file.delete();
      } catch {}
      resolve();
    };
    const sub = player.addListener("playbackStatusUpdate", (s) => {
      last = s;
      // The player reports its own failures here and nowhere else; without reading it,
      // a broken clip looked exactly like a slow one.
      if (s.error && !done) {
        devlog("err", "the player couldn't play a clip", `${s.error}\n    ${bytes} bytes · ${uri}`);
        finish();
        return;
      }
      if (s.playing && !started) {
        started = true;
        devlog(
          "voice",
          `playing a clip: ${s.duration.toFixed(1)} s of audio, ${Date.now() - asked} ms to start`,
          `${Math.round(bytes / 1024)} KB`,
        );
        onStart?.();
      }
      // Some players never send didJustFinish; reaching the end counts too.
      if (s.didJustFinish || (started && !s.playing && s.duration > 0 && s.currentTime >= s.duration - 0.1)) finish();
    });
    onStop(() => {
      player.pause();
      finish();
    });
    // play() throws outright when the audio session won't activate; one of those went
    // up as a fatal JS error rather than a skipped clip (device_logs, 2026-09-18).
    try {
      player.play();
    } catch (err) {
      devlog("err", "the player refused to start a clip", audioWhy(err, { bytes }));
      finish();
    }
  });
}

/** The parts of a player's status that explain why nothing is coming out of it. */
function status(s: AudioStatus) {
  return (
    `loaded ${s.isLoaded}, buffering ${s.isBuffering}, playing ${s.playing}, ${s.duration.toFixed(1)} s, ` +
    `${s.playbackState}/${s.timeControlStatus}, waiting: ${s.reasonForWaitingToPlay || "-"}, error ${s.error ?? "none"}`
  );
}

/** How many clips are voiced ahead of the one playing. */
const FETCH_AHEAD = 3;
/** A first sentence longer than this is split at a pause so the voice starts sooner. */
const SPLIT_FIRST_OVER = 60;
/** ...looking this far into it for one. Past here, the piece is long enough anyway. */
const FIRST_PIECE_MAX = 120;
/**
 * The first clip is a network round trip, and it has taken as long as 10.8 s with
 * the answer already written and nothing coming out of the phone (device_logs,
 * 2026-09-21). If it hasn't arrived this soon, a cached filler covers it — by then
 * a reply is certainly on its way, so this can never talk over a turn that stays
 * silent.
 */
const FILLER_IF_SLOW_MS = 400;
const SLOW = Symbol("slow");

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

  /**
   * `keepMic`: keep the microphone usable so the user can talk over the reply.
   * `filler` false: never cover a slow start with "Let me look into that" — for
   * lines that are read out (the tour, setup's questions), not worked out.
   */
  const open = ({ keepMic = false, filler = true } = {}) => {
    stop();
    const mine = generation;
    const pieces: string[] = [];
    const clips: Promise<Spoken | null>[] = [];
    let ended = false;
    let pending = ""; // short sentences wait to be joined with the next one
    /** Pieces of the reply itself. A cached filler is queued in front of them and isn't one. */
    let replyPieces = 0;
    /** How far playback has got: the fetch window runs FETCH_AHEAD past it. */
    let played = 0;
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
      replyPieces++;
      if (replyPieces === 1) markTurn("reply clip requested");
      // Voice it now, not when the loop next comes round. The loop only pumped this
      // queue between clips, so on a turn opening with a cached filler the first real
      // sentence wasn't even requested until the filler finished — 6.7 s after the
      // server had the words (device_logs, 2026-09-21).
      fetchUpTo(played + FETCH_AHEAD);
      wake();
    };

    /** Adds the next sentence of the reply. */
    const say = (sentence: string) => {
      if (mine !== generation) return;
      const text = pending ? `${pending} ${sentence}` : sentence;
      pending = "";
      // Both rules below count the reply's own pieces, not everything queued: a cached
      // filler sits in front of them, and while that counted, neither rule ever fired on
      // an addressed turn. "Got it—sticking with DeepSeek." waited for the next sentence
      // and went out as one 5.6 s clip (device_logs, 2026-09-21).
      //
      // A long first sentence takes seconds to voice (110 characters: 2.5 s): start with
      // the part before its first comma or dash, and voice the rest meanwhile.
      if (replyPieces === 0 && text.length > SPLIT_FIRST_OVER) {
        const cut = text.slice(20, FIRST_PIECE_MAX).search(/[,;:—–]\s/);
        if (cut >= 0) {
          addPiece(text.slice(0, 20 + cut + 1));
          addPiece(text.slice(20 + cut + 1).trim());
          return;
        }
      }
      // The first piece is spoken as soon as it arrives; after that, very short sentences
      // ("Sure.") ride along with the next one so the voice doesn't stop and start.
      if (replyPieces > 0 && text.length < 40) {
        pending = text;
        return;
      }
      addPiece(text);
    };

    const end = () => {
      // The generation guard every other entry point has: without it a short
      // sentence held in `pending` was still voiced and played after the user
      // had talked over the reply and stopped it.
      if (pending && mine === generation) addPiece(pending);
      pending = "";
      ended = true;
      wake();
    };

    /**
     * A piece the server has already voiced (mp3 as base64, see ServerSpeech in
     * api.ts), queued straight after what's there. The server has already done
     * the grouping `say` does. Null audio, or audio that can't be saved, is
     * voiced here instead, the old way, so the words are never lost.
     */
    const voiced = (text: string, mp3: string | null) => {
      if (mine !== generation || !/[\p{L}\p{N}]/u.test(text)) return;
      // Anything `say` queued but hasn't asked for yet goes first, keeping the two lists in step.
      fetchUpTo(pieces.length - 1);
      let file: File | null = null;
      if (mp3 && !usesDeviceVoice()) {
        try {
          file = saveClip(mp3);
        } catch (err) {
          devlog("err", "couldn't save a voiced piece; voicing it here", err instanceof Error ? err.message : String(err));
        }
      }
      pieces.push(text);
      replyPieces++;
      if (replyPieces === 1) markTurn("reply clip requested");
      clips.push(
        file
          ? Promise.resolve(file)
          : voice
              .then((v) => fetchClip(token, text, v))
              .catch((err) => {
                devlog("err", "couldn't voice part of the reply", err instanceof Error ? err.message : String(err));
                return null;
              }),
      );
      wake();
    };

    /**
     * Plays a clip already on the phone, ahead of everything else ("One second
     * while I get that"): no network, so it starts at once. First thing only.
     */
    let fillerPlayed = !filler;
    const clip = (file: Spoken) => {
      if (!filler || mine !== generation || pieces.length) return;
      pieces.push("(filler)");
      clips.push(Promise.resolve(file));
      fillerPlayed = true;
      wake();
    };

    // The turn's timer wants the moment the user first hears something, not every clip.
    let spoken = false;
    const firstWord = () => {
      if (spoken) return;
      spoken = true;
      markTurn("first word out loud");
    };
    const done = (async () => {
      await ready;
      // Switching the audio session can contend with the live microphone, so it
      // gets its own mark rather than hiding inside the wait for the first word.
      markTurn("audio session ready");
      for (let i = 0; mine === generation; i++) {
        played = i;
        while (i >= pieces.length && !ended && mine === generation) {
          await new Promise<void>((r) => (wakeCurrent = r));
        }
        if (i >= pieces.length || mine !== generation) break;
        fetchUpTo(i + FETCH_AHEAD);
        // Nothing has been said yet and the first clip is taking its time: say
        // something cached rather than leave the phone silent (see FILLER_IF_SLOW_MS).
        if (i === 0 && !fillerPlayed) {
          const soon = await Promise.race([clips[0], sleep(FILLER_IF_SLOW_MS).then(() => SLOW)]);
          if (soon === SLOW && mine === generation) {
            const filler = pickFiller();
            if (filler) {
              fillerPlayed = true;
              markTurn("filler while the voice is fetched");
              await playPiece(filler, (s) => (stopCurrent = s), firstWord);
            }
          }
          if (mine !== generation) break;
        }
        const file = await clips[i];
        if (mine !== generation) {
          discardPiece(file);
          break;
        }
        played = i + 1; // playFile deletes it
        if (file) {
          // Only the reply's first clip: the rest are voiced ahead and cost the user
          // nothing. i === 0 used to be the mark, but that is the cached filler on an
          // addressed turn, so the one number worth having was never recorded.
          if (i === (pieces[0] === "(filler)" ? 1 : 0)) markTurn("voice clip ready");
          await playPiece(file, (s) => (stopCurrent = s), firstWord);
        }
        fetchUpTo(i + 1 + FETCH_AHEAD);
      }
      // Clean up clips voiced ahead that won't be played.
      clips.slice(played).forEach((c) => c.then(discardPiece));
    })();

    return { say, end, done, clip, voiced };
  };

  /**
   * Reads a whole text that is already known. No filler by default: a filler
   * covers thinking, and a text read out (the tour, a question, a voice sample)
   * has none. The one caller that wants one (a reply read under the microphone)
   * says so.
   */
  const speak = async (text: string, { keepMic = false, filler = false } = {}) => {
    const reply = open({ keepMic, filler });
    speechChunks(text).forEach(reply.say);
    reply.end();
    await reply.done;
  };

  return { open, speak, stop };
}

type Speaker = ReturnType<typeof createSpeaker>;
type Reply = ReturnType<Speaker["open"]>;

/**
 * Spoken turns ask the server to voice the reply in the same stream (ServerSpeech
 * in api.ts). False goes back to this phone asking /voice/speak per sentence.
 */
const SERVER_VOICE = true;
/**
 * With the server voicing, the audio usually lands 300-600 ms after its words: no
 * phone round trip in between. So the cached filler waits longer than
 * FILLER_IF_SLOW_MS before covering a slow one — a filler that starts first holds
 * the real answer back by its own length.
 */
const SERVER_FILLER_AFTER_MS = 1000;

/**
 * One reply's side of ServerSpeech: whether the server said it is voicing this
 * reply, handing each voiced piece to the speaker, and a cached filler if the
 * first piece is slow to come.
 */
export function serverSpeech(reply: Reply, cancelled: () => boolean = () => false) {
  let on = false;
  let heard = false;
  let slow: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    if (slow) clearTimeout(slow);
    slow = null;
  };
  return {
    /** The server said it's voicing this reply: don't voice the sentences here too. */
    on: () => on,
    /** The first words are in; their audio should be right behind them. */
    firstSentence() {
      if (!on || heard || slow) return;
      slow = setTimeout(() => {
        slow = null;
        if (heard || cancelled()) return;
        const filler = pickFiller();
        if (!filler) return;
        markTurn("filler while the server voices");
        reply.clip(filler);
      }, SERVER_FILLER_AFTER_MS);
    },
    /** What to send with the request, or undefined to voice everything here. */
    async request(): Promise<ServerSpeech | undefined> {
      if (!SERVER_VOICE) return undefined;
      return {
        voice: await voicePref.get(),
        onVoicing: (voicing, engine) => {
          on = voicing;
          // The server names the engine it uses; "device" means this phone speaks.
          setTtsEngine(engine);
          if (!voicing) devlog("voice", usesDeviceVoice() ? "voicing this reply with the phone's own voice" : "the server isn't voicing this reply; voicing it here");
        },
        onVoiced: (text, mp3) => {
          if (cancelled()) return;
          heard = true;
          settle();
          reply.voiced(text, mp3);
        },
      };
    },
    /** The request is over, however it ended. */
    done: settle,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "waiting": on, but parked — iOS will not open a microphone for an app that
 * isn't on screen, so the loop is holding until it comes forward. Its own phase
 * because saying "Listening" while nothing is listening is a lie the Lock
 * Screen, the Dynamic Island and the clip's light all repeated.
 */
export type VoicePhase = "off" | "waiting" | "listening" | "thinking" | "speaking";

const RETRY_MS = 3000;
/** The voice loop backs off to this between failures rather than asking every 3 s forever. */
const MAX_RETRY_MS = 60_000;
/** After this many failures in a row, listening stops and says why, rather than trying all day. */
const MAX_LISTEN_FAILURES = 6;
/** How long to wait for the app to come forward before looking for a microphone again. */
const BACKGROUND_WAIT_MS = 5000;
const INTERRUPTED = Symbol("interrupted");

/** A failure that trying again won't fix (Speech Recognition refused): listening stops at once and says why. */
const isPermanent = (err: unknown) => err instanceof Error && (err as { permanent?: boolean }).permanent === true;

/**
 * Hands-free, continuous listening: hear something, send it, read the reply
 * aloud, listen again, until `end` is called. `onUserSaid` sends the words to
 * the assistant and returns the reply to read aloud (or null to skip speaking).
 * With `interruptible`, the user can talk over the reply to cut it off. With
 * `background` (Always listen) it only answers when called by `name`. With
 * `standby` (the click standby) the phone's ear keeps running between turns,
 * its words going nowhere, so a click can start a turn while the app is in the
 * background. `wake` false (a plan without the hands-free wake word, which
 * comes with Base) listens in open mode: every sentence is for the assistant,
 * as it is for dictation and setup. `fillers` false: no "Let me look into
 * that" while it thinks (setup, where the reply is a scripted question).
 * `answers`: each turn answers a question (setup), so a one-word answer isn't
 * taken for the question's echo (turnGate.ts).
 *
 * The phone hears it all (liveListen.ts): its own ear, or on a phone without
 * one, Apple's recogniser for a turn the person started. Only the words leave
 * the phone. Where neither exists (Expo Go, the web) it says so and stays off:
 * talking there is typing.
 */
export function useConversation(
  token: string,
  onUserSaid: (
    text: string,
    addressed: boolean,
    onSentence?: (sentence: string) => void,
    signal?: AbortSignal,
    extra?: { speech?: ServerSpeech; room?: boolean },
  ) => Promise<string | null>,
  { interruptible = false, background = false, standby = false, name = "OVOA", wake = true, fillers = true, answers = false } = {},
) {
  const [phase, setPhaseState] = useState<VoicePhase>("off");
  const phaseRef = useRef<VoicePhase>("off");
  const setPhase = (p: VoicePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const [level, setLevel] = useState(-160);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when listening stopped itself (it can't run on this phone, or it kept
   * failing) rather than being ended. The orb's owner watches it, so the orb
   * doesn't stay lit over a microphone that is off.
   */
  const [stoppedBy, setStoppedBy] = useState<string | null>(null);
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
  const [words, setWords] = useState("");
  // A twist or the clip's button: what's said until then counts as addressed.
  const summonedUntil = useRef(0);
  /** When the person last asked to be heard (a tap, a click): a running ear's earlier words aren't theirs. */
  const askedAt = useRef(0);
  const gateRef = useRef<TurnGate | null>(null);
  /** The open ear, so a button press can wake it. */
  const earRef = useRef<Ear | null>(null);
  /**
   * Whether the phone's own ear (modules/name-ear) can be used this session. It
   * starts as "yes if the build has it" and turns false the first time the ear
   * refuses (no on-device recognition, permission refused). After that a turn
   * the person starts is heard by Apple's recogniser, and listening for the
   * name doesn't run at all.
   */
  const nameEarOk = useRef(canHearName);
  const standbyRef = useRef(standby);
  standbyRef.current = standby;
  /** Audio stays up in the background: Always listen, or the click standby. */
  const keepsAudio = () => background || standbyRef.current;
  /**
   * Room mode, answering only after the name: the wake word or Always listen,
   * on the phone's ear. Always listen has run on the ear since 2026-09-23: it
   * owns the microphone natively and stays open through every turn, so it keeps
   * running in the background, and it can run day and night because room talk
   * never leaves the phone. Without the ear neither runs (decision 1: listening
   * for the name never goes to Apple's servers). A click from the standby is an
   * open turn: the click, not the name, is what started it.
   */
  const wakeRef = useRef(wake);
  wakeRef.current = wake;
  const listensForName = () => (wakeRef.current || background) && nameEarOk.current && !standbyRef.current;

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

  /**
   * Listens until `end`. Resolves true when it was ended, false when it
   * couldn't start or stopped itself (the error says why), so the caller can
   * put its switch back.
   */
  const start = useCallback(async () => {
    setError(null);
    setStoppedBy(null);
    // The session is taken before the permission prompt, not after: an end()
    // that lands while it's up (the tour holding Talk's microphone, the screen
    // left) has to stop this start too. Taken after, the loop started anyway
    // and Talk listened through the whole tour.
    const mine = ++session.current;
    const cancelled = () => session.current !== mine;
    // A click sets this itself, a moment earlier; a tap is now.
    if (Date.now() - askedAt.current > 2000) askedAt.current = Date.now();
    // Expo Go and the web have neither the ear nor Apple's recogniser: typing only.
    if (!canListen) {
      devlog("voice", "no speech recognition in this build; voice input is off");
      setError("Talking to OVOA needs the OVOA app from TestFlight. Here, type instead.");
      return false;
    }
    const { granted } = await requestRecordingPermissionsAsync();
    if (cancelled()) return true;
    if (!granted) {
      devlog("err", "microphone permission denied");
      setError("Allow microphone access in Settings to talk to the assistant.");
      return false;
    }
    // Speech Recognition too, asked here in the foreground with its reason,
    // before anything needs it where iOS can't show a prompt. The answer isn't
    // needed here: whichever recogniser runs says for itself if it can't.
    await ensureSpeechPermission();
    if (cancelled()) return true;
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
      options: { keepMic: boolean; room?: boolean; heardAt?: number; onSpeaking?: (soFar: string) => void },
    ) => {
      // Everything from here on is the user waiting, the same as a band turn (turnTimer.ts).
      startTurn("phone");
      markStopTalking();
      noteHeard(text);
      // The words were recognised on the phone as they were said; what the user
      // felt of it is the gate's wait for them to be done.
      markTurn("recognised on phone", options.heardAt ? `sent ${Date.now() - options.heardAt} ms after the last word` : undefined);
      try {
        return await answerOneTurn(text, addressed, options);
      } catch (err) {
        failTurn(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        endTurn();
      }
    };

    const answerOneTurn = async (
      text: string,
      addressed: boolean,
      { keepMic, room = false, onSpeaking }: { keepMic: boolean; room?: boolean; onSpeaking?: (soFar: string) => void },
    ) => {
      setPhase("thinking");
      setError(null);
      setWords(text);
      const asked = Date.now();
      devlog("voice", `${addressed ? "heard its name; asking the assistant" : "asking the assistant"} (${text.length} chars)`);
      const reply = speaker.current.open({ keepMic, filler: fillers });
      // Something heard straight away while the answer is worked out. Only when it
      // was said to the assistant: overheard speech mostly gets no answer at all.
      if (addressed && fillers) {
        const filler = pickFiller();
        if (filler) reply.clip(filler);
      }
      let soFar = "";
      const server = serverSpeech(reply, cancelled);
      const onSentence = (sentence: string) => {
        if (cancelled()) return;
        if (!soFar) {
          devlog("voice", `speaking ${Date.now() - asked} ms after the question`);
          setPhase("speaking");
          setWords("");
          server.firstSentence();
        }
        soFar = soFar ? `${soFar} ${sentence}` : sentence;
        onSpeaking?.(soFar);
        // The words still arrive for the screen and for telling the reply's echo from
        // the user; the audio arrives separately when the server is voicing it.
        if (!server.on()) reply.say(sentence);
      };
      // Before end() the speech only finishes if it's stopped: the user talked over it.
      // Then stop waiting for the rest of the reply and drop the request.
      const abort = new AbortController();
      const interrupted = reply.done.then((): typeof INTERRUPTED => INTERRUPTED);
      let full: string | null;
      try {
        // `room`: the gate guessed this was for the assistant (a follow-up without
        // the name), so the server gets to disagree before anything is answered.
        const asking = handler.current(text, addressed, onSentence, abort.signal, { speech: await server.request(), room });
        asking.catch(logFail("voice: handler.current")); // dropped after an interruption: its failure is expected
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
      } finally {
        server.done();
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
     * Listens through one ear that stays open through replies: the words go
     * through the turn gate as they arrive, and a request is sent the moment
     * it's complete. Returns when cancelled; throws if listening is lost.
     */
    const runLive = async () => {
      // With the phone's ear listening for the name, the gate works in room
      // mode: the name (with the few words before it), a click or a follow-up
      // counts, and room talk is dropped. The ear's words only reach the gate
      // inside the wake window anyway; the drop is there for the follow-up
      // window, when the room may talk too.
      const room = listensForName();
      const gate = new TurnGate(nameRef.current, room, bargeIn.current, answers);
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
        if (r.kind === "ignored") {
          // Only why, never what: room talk stays on the phone. devlog collapses
          // repeats, so the count is still there ("× 40 more").
          devlog("voice", `ignored: ${r.why}`);
          // Kept only by a development account that turned capture-everything on;
          // for everyone else it isn't even sent.
          if (keepsHeard()) keepHeard(token, r.text);
        } else if (r.kind === "interrupt") {
          devlog("voice", r.stopOnly ? "told to stop" : "that was you: interrupting");
          speaker.current.stop();
        } else {
          earRef.current?.wake("turn");
          wake(r.turn);
        }
      };
      const showWords = () => {
        if (phaseRef.current === "listening") setWords(gate.live());
      };
      const ear = await openEar(
        {
          onLevel: setLevel,
          onInterim: (text) => {
            gate.onInterim(text, Date.now());
            // Words still arriving: the request isn't over, so the window isn't either.
            if (text) earRef.current?.wake("speech");
            showWords();
          },
          onFinal: (text, sentenceEnd) => {
            if (text) earRef.current?.wake("speech");
            handle(gate.onFinal(text, sentenceEnd, Date.now()));
            showWords();
          },
          onQuiet: () => handle(gate.onQuiet()),
          onDown: (err) => {
            state.down = err;
            wake(null);
          },
          onWake: (why) => {
            if (why !== "name") return;
            devlog("voice", "heard its name; listening to the request");
            // The phone heard the name, so what follows is the request: the same as a button press.
            const until = Date.now() + SUMMON_MS;
            summonedUntil.current = until;
            gate.summon(until);
          },
          onSleep: () => setWords(""),
        },
        { room, name: nameRef.current, since: askedAt.current, useEar: nameEarOk.current },
      );
      earRef.current = ear;
      // A button press that started this listening: the window opens for it now.
      if (Date.now() < summonedUntil.current) ear.wake("summon");
      // While a reply is being worked out or read aloud, the window is kept
      // open moment by moment: a slow first sentence or a long read-aloud would
      // otherwise outlast it, and a "stop" in its tail would be missed.
      let answering = false;
      const timer = setInterval(() => {
        if (cancelled()) wake(null);
        else {
          if (answering) ear.wake("busy");
          handle(gate.tick(Date.now()));
        }
      }, 150);
      devlog(
        "voice",
        `listening live (${room ? `on the phone until "${nameRef.current}" is said` : "every sentence"}, ${ear.source === "ear" ? "the phone's ear" : "Apple's recogniser"}${bargeIn.current ? ", talk-over on" : ""})`,
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
          ear.wake("turn");
          let spoke: boolean;
          answering = true;
          try {
            // The ear keeps hearing while the reply plays; the gate hears the
            // reply so far, to tell its echo from the user talking over it.
            spoke = await answerAloud(turn.text, turn.addressed, {
              keepMic: true,
              room,
              heardAt: turn.heardAt,
              onSpeaking: (soFar) => {
                gate.speak(soFar);
                ear.wake("reply");
              },
            });
          } catch (err) {
            if (cancelled()) break;
            devlog("err", "couldn't get a reply", err instanceof Error ? err.message : String(err));
            setError(err instanceof Error ? err.message : "Couldn't reach the assistant");
            continue;
          } finally {
            answering = false;
          }
          if (cancelled() || !spoke) continue;
          gate.spoke(Date.now());
          // An answer without the name still counts for a moment; the window stays open for it.
          ear.wake("follow-up");
        }
      } finally {
        clearInterval(timer);
        if (gateRef.current === gate) gateRef.current = null;
        if (earRef.current === ear) earRef.current = null;
        state.waiting = null;
        ear.close();
      }
      if (state.down) throw state.down;
    };

    let failures = 0;
    let stoppedItself = false;
    while (!cancelled()) {
      // iOS will not open a microphone for an app that isn't on screen. Background
      // audio keeps a session that is *already* running alive; it does not let a
      // stopped one start again, and every attempt comes back as
      // AVAudioSessionErrorCodeCannotInterruptOthers ('!int', OSStatus 560557684).
      // Asking anyway, every three seconds, filled the log with 7,150 identical
      // failures and left no working microphone at all (device_logs, 2026-09-21).
      // A running ear (Always listen, the click standby) carries on off screen.
      if (!onScreen() && !earAlive()) {
        // Say so: parking used to leave the phase on "listening", so the Lock
        // Screen, the Dynamic Island and the clip's light all claimed the app
        // was listening while it was waiting for the user to open it.
        setPhase("waiting");
        await whenOnScreen(BACKGROUND_WAIT_MS);
        continue;
      }
      try {
        await runLive();
        failures = 0;
      } catch (err) {
        if (cancelled()) break;
        // iOS took the microphone because the app went off screen: wait for it.
        if (wasOffScreen(err)) {
          await whenOnScreen(BACKGROUND_WAIT_MS);
          continue;
        }
        const why = err instanceof Error ? err.message : String(err);
        // The phone's ear can't run here: a turn the person starts can use
        // Apple's recogniser instead. Listening for the name only ever runs on
        // the ear (decision 1), so Always listen stops instead.
        if (wasNameEarFailure(err) && nameEarOk.current && !background) {
          nameEarOk.current = false;
          devlog("voice", "the phone's ear can't run here; turns you start use Apple's recogniser", why);
          continue;
        }
        failures++;
        const stopWith = wasNameEarFailure(err)
          ? background
            ? `Always listen needs an iPhone that recognises speech on its own. ${why}`
            : why
          : isPermanent(err) || failures >= MAX_LISTEN_FAILURES
            ? why
            : null;
        if (stopWith) {
          if (wasNameEarFailure(err)) nameEarOk.current = false;
          devlog("err", "listening stopped itself", stopWith);
          setError(stopWith);
          setWords("");
          setPhase("off");
          // The orb has to follow: the assistant provider turns it off when it sees this.
          setStoppedBy(stopWith);
          stoppedItself = true;
          break;
        }
        // Backing off rather than retrying on a fixed beat: when the microphone
        // is refused outright, asking again in three seconds only asks again forever.
        const wait = Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
        devlog("err", `listening failed, trying again in ${Math.round(wait / 1000)} s`, audioWhy(err, { attempt: failures }));
        setError(why);
        setPhase("waiting");
        await sleep(wait);
      }
    }
    // The click standby keeps the ear (and the app) running for the next click.
    if (!standbyRef.current && backgroundAudio) {
      backgroundAudio = false;
      await applyAudioMode(false).catch(logFail("voice: applyAudioMode"));
    }
    finished();
    return !stoppedItself;
  }, [token, background]);

  // The click standby (decision 13): iOS won't let a backgrounded app open a
  // microphone, and suspends one with no audio running. So with the phone's
  // microphone picked and a band paired, the phone's ear runs between turns
  // (its words go nowhere: nothing reaches the gate, nothing leaves the phone)
  // and a click in another app starts a turn from the words it hears. It can
  // only be started in the foreground; if iOS stops it (a phone call, another
  // app's audio) it's started again, and failing that, the next time the app
  // is opened. No new microphone is ever opened off screen.
  useEffect(() => {
    if (!standby || !canHearName) return;
    let stopped = false;
    let holding = false;
    /** A check is under way (the timer and the app coming forward can overlap). */
    let checking = false;
    const hold = async (why: string) => {
      if (stopped || checking || phaseRef.current !== "off") return;
      if (holding && earAlive()) return;
      checking = true;
      try {
        await holdNow(why);
      } finally {
        checking = false;
      }
    };
    const holdNow = async (why: string) => {
      // Off screen there is nothing to do but wait: iOS only opens a microphone
      // for an app that's in front. The AppState listener below calls this
      // again the moment the app returns.
      if (!onScreen()) return;
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted || stopped || phaseRef.current !== "off") return;
      backgroundAudio = true;
      try {
        await applyAudioMode(true);
        // Held but silent: iOS stopped it. Let go, and start it afresh.
        if (holding) releaseEar("standby");
        holding = false;
        await holdEar("standby", nameRef.current);
        // Standby was turned off while the ear started: hand it straight back.
        if (stopped) return releaseEar("standby");
        holding = true;
        devlog("voice", `click standby: the phone's ear is on (${why}); nothing leaves the phone until a click`);
        devlogSettled("click standby ear");
      } catch (err) {
        if (wasNameEarFailure(err)) {
          // This phone can't recognise on its own: a click works with the app open, not from other apps.
          stopped = true;
          devlog("voice", "click standby: the phone's ear can't run here; clicks work while OVOA is open", err instanceof Error ? err.message : String(err));
          return;
        }
        devlogRepeat("click standby ear", "err", "click standby: couldn't start the phone's ear", audioWhy(err, { why }));
      }
    };
    hold("click mode").catch(logFail("voice: hold"));
    const timer = setInterval(() => hold("it had stopped").catch(logFail("voice: hold")), STANDBY_CHECK_MS);
    const appState = AppState.addEventListener("change", (s) => {
      if (s === "active") hold("app opened").catch(logFail("voice: hold"));
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      appState.remove();
      // A turn in progress holds the ear itself, so letting go here never stops it mid-turn.
      if (holding) {
        releaseEar("standby");
        devlog("voice", "click standby: off");
      }
      if (phaseRef.current === "off" && !background) {
        backgroundAudio = false;
        applyAudioMode(false).catch(logFail("voice: applyAudioMode"));
      }
    };
  }, [standby, background]);

  // Overheard lines wait a few seconds before being sent; send what's waiting when
  // the app goes away, rather than losing it if iOS suspends us.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") void flushHeard(token);
    });
    return () => sub.remove();
  }, [token]);

  /** While speaking: cut the reply short and listen again. */
  const interrupt = useCallback(() => speaker.current.stop(), []);

  /**
   * A twist (or the clip's button) asked for attention: listen now, and treat the
   * next ~8 s of speech as addressed even without the name. Cuts off a reply.
   */
  const summon = useCallback(() => {
    const now = Date.now();
    const until = now + SUMMON_MS;
    summonedUntil.current = until;
    askedAt.current = now;
    gateRef.current?.summon(until);
    // The button is as good as the name: the ear's words go to the gate from now.
    earRef.current?.wake("summon");
    devlog("voice", "summoned", `phase ${phaseRef.current}`);
    if (phaseRef.current === "speaking") speaker.current.stop();
    if (phaseRef.current === "off") return start();
    return Promise.resolve(true);
  }, [start]);

  /** A second click while listening: send what's been said now. False when nothing has been said yet. */
  const finishNow = useCallback(() => gateRef.current?.done() ?? false, []);

  /** The phase right now (the state can be a render behind). */
  const currentPhase = useCallback(() => phaseRef.current, []);

  return { phase, currentPhase, level, error, setError, words, start, end, interrupt, summon, finishNow, stoppedBy };
}

/** The click standby: how often the ear is checked. */
const STANDBY_CHECK_MS = 5000;

/** After a twist, how long speech counts as addressed without the name. */
const SUMMON_MS = 8000;

const ALWAYS_LISTEN_KEY = "ovoa.alwaysListen";

/** Danger zone "Always listen": listen on every screen and allow talking over replies. */
const alwaysListenListeners = new Set<(on: boolean) => void>();

// Listening to the room is consent the next account on this phone never gave.
onSignOut("always listen", () => alwaysListenPref.set(false));

/**
 * Always listen, in Settings → Danger zone (Base). Since 2026-09-23 it runs on
 * the phone's own ear, so nothing leaves the phone until the name is heard:
 * that is what keeps it on the right side of the 2026-09-20 ruling against
 * ambient capture. Dev tools has a switch too, and sits outside the assistant,
 * so the provider hears about a change through onChange.
 */
export const alwaysListenPref = {
  get: async () => (await storage.get(ALWAYS_LISTEN_KEY).catch(() => null)) === "1",
  set: async (on: boolean) => {
    await storage.set(ALWAYS_LISTEN_KEY, on ? "1" : "0");
    alwaysListenListeners.forEach((l) => l(on));
  },
  onChange: (listener: (on: boolean) => void) => {
    alwaysListenListeners.add(listener);
    return () => void alwaysListenListeners.delete(listener);
  },
};

const LISTENING_KEY = "ovoa.alwaysListening";

/** Whether the user left the Assistant tab's orb on, so it resumes when they come back. */
export const listeningPref = {
  get: async () => (await storage.get(LISTENING_KEY).catch(() => null)) === "1",
  set: (on: boolean) => storage.set(LISTENING_KEY, on ? "1" : "0"),
};

// Someone new on this phone starts with Talk's microphone off, not the last person's switch.
onSignOut("talk orb", () => storage.remove(LISTENING_KEY));

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
