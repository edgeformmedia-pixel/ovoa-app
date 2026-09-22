import {
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type AudioRecorder,
  type AudioStatus,
  type RecordingOptions,
} from "expo-audio";
import { fetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { API_URL, ApiError, noteDeadSession, type ServerSpeech } from "./api";
import { devlog, devlogRepeat, devlogSettled, logFail } from "./devlog";
import { pickFiller } from "./fillers";
import { audioWhy, onScreen, whenOnScreen } from "./foreground";
import { flushHeard, keepHeard, keepsHeard } from "./heard";
import {
  canHearName,
  earAlive,
  micAlive,
  openEar,
  stopStream,
  useLiveStream,
  wasAutoOff,
  wasCapped,
  wasNameEarFailure,
  wasOffScreen,
  type Ear,
} from "./liveListen";
import { onSignOut } from "./signOut";
import { storage } from "./storage";
import { onlyStop, saidOverReply, TurnGate, type GateResult, type Turn } from "./turnGate";
import { readProfiles, type TwistProfile, type TwistProfiles } from "./twist";
import { endTurn, failTurn, mark as markTurn, markStopTalking, noteHeard, startTurn } from "./turnTimer";

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

/** One line voiced in the chosen voice, as a file (the caller keeps or deletes it). */
export async function renderSpeech(token: string, text: string) {
  return fetchClip(token, text, await voicePref.get());
}

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
    noteDeadSession(res.status, token, body.error);
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  devlog("res", `${res.status} ${init.method} ${path} · ${Date.now() - started} ms`);
  return res;
}

/**
 * Turns a recording into text. Deletes the recording afterwards, because a
 * voice turn's audio has no life past the words — pass `keep` for audio the
 * user saved and still owns.
 */
export async function transcribe(
  token: string,
  uri: string,
  contentType = "audio/mp4",
  { keep = false }: { keep?: boolean } = {},
): Promise<string> {
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
    markTurn("transcribe", `${Math.round(audio.byteLength / 1024)} KB uploaded`);
    if (text) noteHeard(text);
    return text;
  } finally {
    if (!keep) {
      try {
        file.delete();
      } catch {}
    }
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
  const asked = Date.now();
  const res = await authedFetch(
    token,
    "/voice/speak",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }) },
    `${voice}: "${text}"`,
  );
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

  /** `keepMic`: keep the microphone usable so the user can talk over the reply. */
  const open = ({ keepMic = false } = {}) => {
    stop();
    const mine = generation;
    const pieces: string[] = [];
    const clips: Promise<File | null>[] = [];
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
      if (mp3) {
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
    let fillerPlayed = false;
    const clip = (file: File) => {
      if (mine !== generation || pieces.length) return;
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
              await playFile(filler, (s) => (stopCurrent = s), firstWord);
            }
          }
          if (mine !== generation) break;
        }
        const file = await clips[i];
        if (mine !== generation) {
          file?.delete();
          break;
        }
        played = i + 1; // playFile deletes it
        if (file) {
          // Only the reply's first clip: the rest are voiced ahead and cost the user
          // nothing. i === 0 used to be the mark, but that is the cached filler on an
          // addressed turn, so the one number worth having was never recorded.
          if (i === (pieces[0] === "(filler)" ? 1 : 0)) markTurn("voice clip ready");
          await playFile(file, (s) => (stopCurrent = s), firstWord);
        }
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

    return { say, end, done, clip, voiced };
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
        onVoicing: (voicing) => {
          on = voicing;
          if (!voicing) devlog("voice", "the server isn't voicing this reply; voicing it here");
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
        .catch(logFail("voice: speaker.stop")),
    );
  }
  onLevel(-160);
  await playing.catch(logFail("voice: onLevel"));
  // The last piece may have caught the start of what they said next.
  await Promise.all(checks);
  return state.said;
}

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
/** How long to wait for the app to come forward before looking for a microphone again. */
const BACKGROUND_WAIT_MS = 5000;
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
    extra?: { speech?: ServerSpeech },
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
  /** The open ear, so a button press can wake it. */
  const earRef = useRef<Ear | null>(null);
  /**
   * Whether the phone's own ear (modules/name-ear) can be used this session. It
   * starts as "yes if the build has it" and turns false the first time the ear
   * refuses (no on-device recognition, permission denied), after which the old
   * way is used with its time limits.
   */
  const nameEarOk = useRef(canHearName);
  const standbyRef = useRef(standby);
  standbyRef.current = standby;
  /** Audio stays up in the background: Always listen, or the twist standby. */
  const keepsAudio = () => background || standbyRef.current;
  /**
   * Wake mode with nothing sent until the name: the phone's ear, when the
   * build has it and nothing else needs the microphone kept running between
   * turns (the twist standby and Always listen both do, and keep the old way).
   */
  const useNameEar = () => nameEarOk.current && !keepsAudio();

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
      options: { keepMic: boolean; onSpeaking?: (soFar: string) => void },
    ) => {
      // Everything from here on is the user waiting, the same as a band turn (turnTimer.ts).
      startTurn("phone");
      markStopTalking();
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
      { keepMic, onSpeaking }: { keepMic: boolean; onSpeaking?: (soFar: string) => void },
    ) => {
      setPhase("thinking");
      setError(null);
      setWords(text);
      const asked = Date.now();
      devlog("voice", addressed ? "heard its name; asking the assistant" : "asking the assistant", text);
      const reply = speaker.current.open({ keepMic });
      // Something heard straight away while the answer is worked out. Only when it
      // was said to the assistant: overheard speech mostly gets no answer at all.
      if (addressed) {
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
        const asking = handler.current(text, addressed, onSentence, abort.signal, { speech: await server.request() });
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
     * Listens over one live connection that stays open through replies: the
     * words go through the turn gate as they arrive, and a request is sent the
     * moment it's complete. Returns when cancelled; throws if the connection is lost.
     */
    const runLive = async (s: typeof stream) => {
      // With the phone's ear, the gate works the way it does in room mode: the
      // name (in the pre-roll) or a follow-up counts, and room talk is dropped.
      // Nothing streams until then anyway, so the drop is cheap; it is there for
      // the follow-up window, when the connection is open and the room may talk.
      const wakeWord = useNameEar() ? { name: nameRef.current } : null;
      const gate = new TurnGate(nameRef.current, background || !!wakeWord, bargeIn.current);
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
      // The phone's ear owns the microphone; the old stream must not be holding it.
      if (wakeWord) stopStream(s);
      const ear = await openEar(wakeWord ? null : s, token, {
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
        onWake: (why) => {
          if (why === "name") devlog("voice", "heard its name; streaming what's said now");
        },
        onSleep: () => setWords(""),
      }, { reuse: keepsAudio(), wakeWord });
      earRef.current = ear;
      const timer = setInterval(() => {
        if (cancelled()) wake(null);
        else handle(gate.tick(Date.now()));
      }, 150);
      devlog(
        "voice",
        `listening live (${ear.native ? `on the phone until "${nameRef.current}" is said` : background ? `room mode: waiting for "${nameRef.current}"` : "every sentence"}${bargeIn.current ? ", talk-over on" : ""})`,
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
          try {
            // The microphone keeps streaming while the reply plays; the gate hears
            // the reply so far, to tell its echo from the user talking over it.
            spoke = await answerAloud(turn.text, turn.addressed, {
              keepMic: true,
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
          }
          if (cancelled() || !spoke) continue;
          gate.spoke(Date.now());
          // An answer without the name still counts for a moment; the connection stays open for it.
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

    // Words the user said over the last reply; the rest of their sentence follows.
    let carried: string | null = null;

    /** One sentence the old way: record until a pause, then upload it. "" if nobody spoke. */
    const hearRecorded = async (noSpeechMs: number) => {
      // In the background, iOS suspends the app the moment no audio is running, which
      // froze the reply request for 15 minutes once. Keep the stream going as a keep-alive.
      // Only from the foreground: starting it while the app is away is refused every
      // time ('!int'), and the failures were the keep-alive's whole output.
      // Stopped first, because expo-audio's start() is a no-op while it still
      // thinks the engine is running (AudioStream.swift: `guard !isStreaming`),
      // which is the very state a halted engine leaves it in.
      if (keepsAudio() && stream && onScreen() && !micAlive(stream)) {
        stopStream(stream);
        await stream
          .start()
          .then(() => devlogSettled("keep-alive mic"))
          .catch((err) => devlogRepeat("keep-alive mic", "err", "background keep-alive mic failed", audioWhy(err)));
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

    let loopFailures = 0;
    while (!cancelled()) {
      try {
        // iOS will not open a microphone for an app that isn't on screen. Background
        // audio keeps a session that is *already* running alive; it does not let a
        // stopped one start again, and every attempt comes back as
        // AVAudioSessionErrorCodeCannotInterruptOthers ('!int', OSStatus 560557684).
        // Asking anyway, every three seconds, filled the log with 7,150 identical
        // failures and left no working microphone at all (device_logs, 2026-09-21).
        //
        // The test is micAlive, not isStreaming: a twist has to be able to start a
        // turn from the background, so a mic that really is running carries on —
        // but the flag stays true for an engine iOS halted (liveListen.ts), and
        // trusting it is what let the loop through to be refused over and over.
        if (!onScreen() && !micAlive(stream) && !earAlive()) {
          // Say so: parking used to leave the phase on "listening", so the Lock
          // Screen, the Dynamic Island and the clip's light all claimed the app
          // was listening while it was waiting for the user to open it.
          setPhase("waiting");
          await whenOnScreen(BACKGROUND_WAIT_MS);
          continue;
        }
        if (liveFailures.current >= 2 && Date.now() - liveFailedAt.current > LIVE_RETRY_MS) {
          devlog("voice", "trying live transcription again");
          liveFailures.current = 0;
        }
        if ((stream || useNameEar()) && liveFailures.current < 2) {
          try {
            await runLive(stream);
            liveFailures.current = 0;
          } catch (err) {
            if (cancelled()) break;
            // iOS took the microphone because the app went off screen. Live
            // transcription is fine; wait for the app rather than spending a
            // failure and falling back to recording, which can't work there either.
            if (wasOffScreen(err)) {
              await whenOnScreen(BACKGROUND_WAIT_MS);
              continue;
            }
            // The phone can't hear its name (an older iPhone, no on-device
            // recognition, permission refused): the old way, with its limits.
            if (wasNameEarFailure(err)) {
              nameEarOk.current = false;
              devlog("voice", "can't hear the name on the phone; listening the old way, with a time limit", err instanceof Error ? err.message : String(err));
              continue;
            }
            // The old way stopped itself: ten quiet minutes, or the hour for the
            // day. Say so on screen and stop, rather than starting again.
            if (wasAutoOff(err) || wasCapped(err)) {
              setError(err instanceof Error ? err.message : String(err));
              setPhase("off");
              break;
            }
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
        loopFailures = 0;
      } catch (err) {
        // Usually a dropped connection: say so, wait a moment, and keep going.
        // Backing off rather than retrying on a fixed beat: when the microphone is
        // refused outright, asking again in three seconds only asks again forever.
        if (cancelled()) break;
        loopFailures++;
        const wait = Math.min(RETRY_MS * 2 ** (loopFailures - 1), MAX_RETRY_MS);
        devlog("err", `voice loop error, retrying in ${Math.round(wait / 1000)} s`, audioWhy(err, { attempt: loopFailures }));
        setError(err instanceof Error ? err.message : "Voice stopped working");
        if (recorder.getStatus().isRecording) await recorder.stop().catch(logFail("voice: recorder.stop"));
        await sleep(wait);
      }
    }
    // The twist standby keeps the microphone (and the app) running for the next twist.
    if (!standbyRef.current) {
      stopStream(stream);
      if (backgroundAudio) {
        backgroundAudio = false;
        await applyAudioMode(false).catch(logFail("voice: applyAudioMode"));
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
    const sub = stream.addListener("audioStreamBuffer", () => (lastAudioAt = Date.now()));
    const hold = async (why: string) => {
      if (stopped || phaseRef.current !== "off") return;
      if (stream.isStreaming && Date.now() - lastAudioAt < STANDBY_SILENT_MS) return;
      // Off screen there is nothing to do but wait: iOS only opens a microphone
      // for an app that's in front, and this stops the stream before starting it,
      // so asking anyway killed a standby mic that was still running and then
      // couldn't get it back — and with it the background audio that keeps the app
      // alive for the next twist (device_logs, 2026-09-21). The AppState listener
      // below calls this again the moment the app returns.
      if (!onScreen()) return;
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted || stopped || phaseRef.current !== "off") return;
      backgroundAudio = true;
      try {
        await applyAudioMode(true);
        if (stream.isStreaming) stopStream(stream);
        await stream.start();
        lastAudioAt = Date.now();
        devlog("voice", `twist standby: microphone on (${why}); nothing is sent until a twist`);
        devlogSettled("twist standby mic");
      } catch (err) {
        devlogRepeat("twist standby mic", "err", "twist standby: couldn't turn the microphone on", audioWhy(err, { why }));
      }
    };
    hold("twist mode").catch(logFail("voice: hold"));
    const timer = setInterval(() => hold("it had stopped").catch(logFail("voice: hold")), STANDBY_CHECK_MS);
    const appState = AppState.addEventListener("change", (s) => {
      if (s === "active") hold("app opened").catch(logFail("voice: hold"));
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
          applyAudioMode(false).catch(logFail("voice: applyAudioMode"));
        }
      }
    };
  }, [standby, stream, background]);

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
    const until = Date.now() + SUMMON_MS;
    summonedUntil.current = until;
    gateRef.current?.summon(until);
    // The button is as good as the name: the phone's ear starts streaming now.
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

  return { phase, currentPhase, level, error, setError, words, start, end, interrupt, summon, finishNow };
}

/** Twist standby: how often the mic is checked, and how long without audio means iOS stopped it. */
const STANDBY_CHECK_MS = 5000;
const STANDBY_SILENT_MS = 3000;

/** After a twist, how long speech counts as addressed without the name. */
const SUMMON_MS = 8000;

const ALWAYS_LISTEN_KEY = "ovoa.alwaysListen";

/** Danger zone "Always listen": listen on every screen and allow talking over replies. */
const alwaysListenListeners = new Set<(on: boolean) => void>();

// Listening to the room is consent the next account on this phone never gave.
onSignOut("always listen", () => alwaysListenPref.set(false));

/**
 * Always listen. Since 2026-09-20 it's only reachable from Dev tools: ambient
 * listening was ruled out for the product on legal grounds, and the switch
 * stays for development. Dev tools sits outside the assistant, so the provider
 * hears about a change through onChange rather than by rendering the switch.
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
