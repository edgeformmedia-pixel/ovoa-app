import { AudioModule, type AudioStream } from "expo-audio";
import { useEffect, useState } from "react";
import * as NameEar from "../../modules/name-ear";
import { API_URL, request } from "./api";
import { devlog, devlogRepeat, devlogSettled } from "./devlog";
import { audioWhy, onScreen } from "./foreground";
import { onSignOut } from "./signOut";
import { storage } from "./storage";
import { nameCount } from "./turnGate";
import { DAILY_STREAM_CAP_S, dayKey, meterAdd, meterOver, WakeWindow, type DailyMeter, type WakeReason } from "./wakeWindow";

// Live transcription: the microphone streams to Deepgram over a WebSocket, the
// words come back while people are still talking, and deciding which of them
// are meant for the assistant happens on the phone (turnGate.ts). The app gets
// a token from our server to open each connection; the real key stays there.
//
// Two ways to run it, and which one decides what the microphone costs:
//
//   With the phone's own ear (modules/name-ear, iOS): the microphone belongs to
//   the native module, which listens for the assistant's name on the phone
//   itself. Nothing is sent anywhere until the name is heard, the band's button
//   is pressed, or the assistant has just replied and is waiting for an answer.
//   Then the connection opens (with a token fetched ahead of time, so it costs
//   no round trip), the few seconds kept before the name go first so the
//   request arrives whole, and the connection closes again when the wake
//   window (wakeWindow.ts) runs out. On the heaviest day before this, 380
//   minutes were streamed for 62 minutes of requests.
//
//   The old way (no native ear: Expo Go, an older iPhone, no on-device
//   recognition): the connection stays open the whole time. It now switches
//   itself off after ten minutes with nothing said to the assistant, and stops
//   for the day after an hour of streaming.

const SAMPLE_RATE = 16000;
const DEEPGRAM_LISTEN = "wss://api.deepgram.com/v1/listen";
const ENDPOINTING_MS = 500; // this much silence after words marks the end of a sentence
const UTTERANCE_END_MS = 1000; // backup: no new words for this long ends it too
// iOS can stop the mic engine when the audio session changes while expo-audio
// still reports it as streaming. If no audio arrives for this long, restart it.
const NO_AUDIO_RESTART_MS = 1500;
const MIN_RESTART_GAP_MS = 3000;
/**
 * Restarting backs off instead of retrying on the same beat forever. Some
 * failures never come right by being asked again — a session iOS won't let us
 * interrupt stays that way until something else changes — and the flat 3-second
 * retry logged 4,922 identical failures in a row (device_logs, 2026-09-21),
 * holding the audio session and the radio that the reply's own audio needed.
 */
const RESTART_BACKOFF_MS = [3000, 6000, 12000, 30000];
/** After this many restarts in a row achieve nothing, stop and let the caller fall back. */
const MAX_RESTARTS = 5;
const KEEPALIVE_MS = 4000;
// A dropped connection is reopened; after this many failures in a row, give up
// (the conversation falls back to recording for a while).
const MAX_RECONNECTS = 3;
const RECONNECT_DELAYS_MS = [300, 1500, 4000];
/** Seconds of audio kept while (re)connecting; older audio is dropped first. */
const MAX_PENDING_S = 20;
/**
 * The app has been off screen with a halted mic this long: hand the ear back
 * rather than hold a Deepgram connection open for a microphone that iOS has
 * taken away. The caller reopens it when the app comes forward.
 */
const OFF_SCREEN_GIVE_UP_MS = 60_000;
/** No PCM buffer for this long means the engine isn't really running, whatever isStreaming says. */
const MIC_ALIVE_MS = 2000;
/** The native ear reports loudness five times a second; this long without one and it has stopped. */
const EAR_ALIVE_MS = 5000;
/** How much audio the native ear keeps ready, so a name said mid-sentence still brings the whole sentence. */
const PRE_ROLL_S = 4;
/** A token is fetched ahead of time and lasts this long (the server allows up to 600). */
const TOKEN_TTL_S = 600;
/** ...and is fetched again with this much left, so opening never waits on one. */
const TOKEN_REFRESH_S = 60;
const STREAM_METER_KEY = "ovoa.streamedToday";

// ---------- Counting what was sent ----------
//
// Deepgram bills the audio it receives, by the minute, and it was 70% of what
// OVOA cost to run on its heaviest day (380 minutes, of which the assistant was
// being addressed in 62). Nothing on the server sees that audio, so only this
// file can say how much went. It counts the bytes actually written to the
// socket (16-bit samples, so two bytes per sample per second of the sample
// rate) and reports the seconds to the server about once a minute, and when a
// connection closes. The count survives a failed report and is capped, so a
// phone that is offline all day cannot claim a week when it comes back.

/** How often the seconds go to the server. */
const REPORT_EVERY_MS = 60_000;
/** The most a single report may claim, matching the server's own clamp (api/src/index.ts). */
const MAX_UNREPORTED_S = 3600;

let unreported = { bytes: 0, connections: 0 };
let lastReportAt = 0;
let reporting = false;

const bytesPerSecond = (sampleRate: number) => sampleRate * 2;

/**
 * Sends what has been counted since the last report. A plain fetch rather than
 * request(): request() writes a log line per call, and one a minute all day is
 * a thousand rows nobody will read.
 */
async function reportStreamUsage(apiToken: string, sampleRate: number, force = false) {
  const now = Date.now();
  if (reporting || (!force && now - lastReportAt < REPORT_EVERY_MS)) return;
  const perSecond = bytesPerSecond(sampleRate);
  if (unreported.bytes < perSecond && !unreported.connections) return;
  const take = unreported;
  unreported = { bytes: 0, connections: 0 };
  reporting = true;
  lastReportAt = now;
  const seconds = Math.min(MAX_UNREPORTED_S, Math.round((take.bytes / perSecond) * 10) / 10);
  try {
    const res = await fetch(`${API_URL}/usage/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ seconds, connections: Math.min(100, take.connections) }),
    });
    if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`);
  } catch {
    // Offline, or the server was busy: keep the count for the next report, capped.
    unreported.bytes = Math.min(unreported.bytes + take.bytes, MAX_UNREPORTED_S * perSecond);
    unreported.connections = Math.min(unreported.connections + take.connections, 100);
  } finally {
    reporting = false;
  }
}

// ---------- The day's allowance (the old way only) ----------

let meter: DailyMeter | null = null;
let meterLoaded = false;

async function loadMeter() {
  if (meterLoaded) return;
  meterLoaded = true;
  try {
    const raw = await storage.get(STREAM_METER_KEY);
    if (raw) meter = JSON.parse(raw) as DailyMeter;
  } catch {
    meter = null;
  }
}

// Someone new on this phone gets the day's listening afresh: an hour used up by
// the last account (or a day of testing) otherwise stopped the new one's setup.
onSignOut("stream meter", async () => {
  meter = null;
  meterLoaded = true;
  await storage.remove(STREAM_METER_KEY);
});

/** Saving is a keychain write: every half minute is plenty, plus once when an ear closes. */
const METER_SAVE_MS = 30_000;
let meterSavedAt = 0;

/** Adds to today's streamed seconds and, now and then, saves them so the cap survives a relaunch. */
function noteStreamed(seconds: number, save = false) {
  const now = Date.now();
  meter = meterAdd(meter, seconds, now);
  if (!save && now - meterSavedAt < METER_SAVE_MS) return;
  meterSavedAt = now;
  storage.set(STREAM_METER_KEY, JSON.stringify(meter)).catch(() => {});
}

/** Seconds streamed today, for Dev tools. */
export const streamedToday = () => (meter && meter.day === dayKey(Date.now()) ? meter.seconds : 0);

// ---------- The microphone the old way ----------

/** Stops and starts the stream, so a mic engine iOS quietly halted comes back. */
async function restart(stream: AudioStream) {
  stopStream(stream);
  await stream.start();
}

/**
 * Stops the mic stream. Never throws: after sign-out the native object is
 * already released, and stopping it then threw an unhandled rejection.
 */
export function stopStream(stream: AudioStream | null | undefined) {
  try {
    stream?.stop();
  } catch {}
}

/**
 * When the last PCM buffer arrived. iOS halts the engine while expo-audio still
 * reports isStreaming (see the note at the top), so "is the microphone actually
 * running" can only be answered by audio having turned up recently.
 */
let lastBufferAt = 0;

/**
 * The microphone is really delivering audio, not merely flagged as started.
 *
 * Before the first buffer of a launch this falls back to isStreaming alone —
 * exactly what the old code trusted. Being stricter there would park the voice
 * loop before the listener had ever fired, which would take twist-from-standby
 * with it.
 */
export function micAlive(stream: AudioStream | null | undefined) {
  if (!stream?.isStreaming) return false;
  return lastBufferAt === 0 || Date.now() - lastBufferAt < MIC_ALIVE_MS;
}

/** When the native ear last reported loudness: its heartbeat. */
let lastEarLevelAt = 0;

/** The phone's own ear is running and delivering audio. */
export function earAlive() {
  return NameEar.isRunning() && Date.now() - lastEarLevelAt < EAR_ALIVE_MS;
}

/** True when this build can hear the name on the phone at all (the module is linked in). */
export const canHearName = NameEar.nameEarAvailable;

// ---------- Why an ear stopped ----------

/**
 * The ear gave up because iOS took the microphone away with the app off screen.
 * Live transcription is fine; the caller waits for the app rather than counting
 * this as a live-transcription failure and falling back to something that can't
 * work off screen either.
 */
function offScreenError() {
  return Object.assign(new Error("The microphone stopped while the app was off screen"), { offScreen: true });
}

/** True for the error above. */
export function wasOffScreen(err: unknown) {
  return err instanceof Error && (err as { offScreen?: boolean }).offScreen === true;
}

/** The phone can't hear its name (no on-device recognition, permission refused): listen the old way. */
function nameEarError(message: string) {
  return Object.assign(new Error(message), { nameEar: true });
}
export function wasNameEarFailure(err: unknown) {
  return err instanceof Error && (err as { nameEar?: boolean }).nameEar === true;
}

/** The old way stopped itself: ten minutes with nothing said to the assistant. */
function autoOffError() {
  return Object.assign(new Error("Listening stopped after ten minutes with nothing said to OVOA. Tap the orb to start again."), { autoOff: true });
}
export function wasAutoOff(err: unknown) {
  return err instanceof Error && (err as { autoOff?: boolean }).autoOff === true;
}

/** The old way has used its hour for today. */
function cappedError() {
  return Object.assign(new Error("Live listening has used its hour for today. It's back tomorrow."), { capped: true });
}
export function wasCapped(err: unknown) {
  return err instanceof Error && (err as { capped?: boolean }).capped === true;
}

/** The native PCM stream, or null if this build doesn't have it. */
export function useLiveStream(): AudioStream | null {
  const [stream] = useState(() => {
    try {
      const Ctor = (AudioModule as { AudioStream?: new (o: object) => AudioStream }).AudioStream;
      return Ctor ? new Ctor({ sampleRate: SAMPLE_RATE, channels: 1, encoding: "int16" }) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!stream) return;
    // One listener for the whole app, so anything can ask micAlive() whether the
    // engine is really running without having to open the ear to find out.
    const sub = stream.addListener("audioStreamBuffer", () => (lastBufferAt = Date.now()));
    return () => {
      sub.remove();
      stream.release();
    };
  }, [stream]);
  return stream;
}

/** Rough loudness of a 16-bit PCM buffer in dBFS, for the orb's halo. */
function levelOf(data: ArrayBuffer) {
  const samples = new Int16Array(data);
  if (!samples.length) return -160;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.ceil(samples.length / 4)) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -160;
}

// ---------- The token, fetched ahead ----------

/**
 * What the token is for. "wake" is hands-free listening for the name (the
 * phone's ear, or Always listen's room mode), which is part of Pro; the server
 * gates it on `?mode=wake` (api/src/plans.ts), so asking for it by its name is
 * what keeps a Base plan from getting it. "talk" is an ordinary spoken turn.
 */
export type EarMode = "wake" | "talk";

type CachedToken = { token: string; keyterms: string[]; expiresAt: number };
/** One per mode: a talk token must never be reused for wake listening. */
const cachedTokens: Record<EarMode, CachedToken | null> = { wake: null, talk: null };
const fetchingTokens: Record<EarMode, Promise<void> | null> = { wake: null, talk: null };
/** After a failed fetch, not before this: the server may be down, and a tick is 250 ms. */
let nextTokenTryAt = 0;

/** A token good for a while, from the server. Shared by every ear on this phone that listens the same way. */
async function fetchToken(apiToken: string, mode: EarMode) {
  fetchingTokens[mode] ??= (async () => {
    try {
      const { token, keyterms = [], expiresIn } = await request<{ token: string; keyterms?: string[]; expiresIn?: number }>(
        `/voice/token?ttl=${TOKEN_TTL_S}${mode === "wake" ? "&mode=wake" : ""}`,
        apiToken,
        { method: "POST" },
      );
      // A server from before the ttl existed answers with a 30-second token.
      cachedTokens[mode] = { token, keyterms, expiresAt: Date.now() + Math.max(10, expiresIn ?? 30) * 1000 };
    } finally {
      fetchingTokens[mode] = null;
    }
  })();
  await fetchingTokens[mode];
}

/** The cached token when it will still be valid at connect time; a fresh one otherwise. */
async function tokenFor(apiToken: string, mode: EarMode) {
  const cached = cachedTokens[mode];
  if (!cached || cached.expiresAt - Date.now() < 5_000) await fetchToken(apiToken, mode);
  return cachedTokens[mode]!;
}

/** Fetched in the background whenever the cached one is about to run out. Backs off after a failure. */
function refreshTokenSoon(apiToken: string, mode: EarMode) {
  if (fetchingTokens[mode] || Date.now() < nextTokenTryAt) return;
  const cached = cachedTokens[mode];
  if (!cached || cached.expiresAt - Date.now() < TOKEN_REFRESH_S * 1000) {
    fetchToken(apiToken, mode).catch((err) => {
      nextTokenTryAt = Date.now() + 15_000;
      devlog("warn", "couldn't fetch a live transcription token ahead of time", err instanceof Error ? err.message : String(err));
    });
  }
}

export type EarEvents = {
  onLevel: (level: number) => void;
  /** Words still being recognised (they may change). */
  onInterim: (text: string) => void;
  /** Words that won't change any more. `sentenceEnd`: the speaker paused after them. */
  onFinal: (text: string, sentenceEnd: boolean) => void;
  /** Nobody has said a new word for a moment. */
  onQuiet: () => void;
  /** The connection is gone for good (reconnecting kept failing). */
  onDown: (err: Error) => void;
  /** The phone's ear woke and the connection is opening: the name, the button, a follow-up. */
  onWake?: (reason: WakeReason) => void;
  /** The wake window ran out and the connection closed. */
  onSleep?: () => void;
};

export type Ear = {
  close: () => void;
  /** Something asked for attention: open the connection (with the pre-roll) or keep it open longer. */
  wake: (reason: WakeReason) => void;
  /** Whether audio is going out right now. */
  awake: () => boolean;
  /** Whether the phone's own ear is doing the listening. */
  native: boolean;
};

/**
 * Starts listening and keeps it going until `close`. With `wakeWord`, the
 * phone's own ear listens and the connection opens only inside a wake window;
 * without it, the connection stays open (the old way). Resolves once listening
 * has begun; throws if it can't.
 */
export async function openEar(
  stream: AudioStream | null,
  apiToken: string,
  events: EarEvents,
  {
    reuse = false,
    wakeWord = null,
    room = false,
  }: {
    /** Use the mic as it is if it's running: in the background iOS may not let it start again. */
    reuse?: boolean;
    /** Listen for this name on the phone, and stream only after it. */
    wakeWord?: { name: string } | null;
    /** Always listen: the connection stays open waiting for the name. Wake mode, like wakeWord. */
    room?: boolean;
  } = {},
): Promise<Ear> {
  const native = !!wakeWord;
  const mode: EarMode = native || room ? "wake" : "talk";
  if (!native && !stream) throw new Error("This build has no microphone stream");
  const pending: ArrayBuffer[] = [];
  let ws: WebSocket | null = null;
  let closed = false;
  let lastAudioAt = Date.now();
  let lastRestartAt = 0;
  let restarting = false;
  let lastKeepAlive = Date.now();
  let failures = 0;
  /** Restarts in a row that achieved nothing. Resets the moment one works. */
  let restartFailures = 0;
  /** When the mic went quiet with the app off screen. 0 while it's on screen. */
  let offScreenAt = 0;
  /** Audio written to the socket by this ear, for the log line when it closes. */
  let sentBytes = 0;
  /** ...and since the current window opened, for the line when it closes. */
  let windowBytes = 0;
  let meteredBytes = 0;
  const sampleRate = native ? SAMPLE_RATE : stream!.sampleRate || SAMPLE_RATE;
  const openedAt = Date.now();
  const window = new WakeWindow();
  const subs: { remove: () => void }[] = [];
  /** Whether the native ear has been told to hand audio over (it is told again on every waking). */
  let sending = false;
  /** How many times the name has been heard in the transcript so far, so a growing transcript wakes once per mention. */
  let namesHeard = 0;
  let lastWordsLength = 0;

  /** Counts audio the moment it goes out: the only honest measure of what Deepgram will bill. */
  const send = (socket: WebSocket, data: ArrayBuffer) => {
    socket.send(data);
    sentBytes += data.byteLength;
    windowBytes += data.byteLength;
    unreported.bytes += data.byteLength;
  };

  /** A buffer of microphone audio, from whichever ear: out it goes, or it waits for the socket. */
  const onBuffer = (data: ArrayBuffer) => {
    // A buffer the native ear handed over after the window closed (it takes a
    // moment to be told) must not wait for the next waking, ahead of its pre-roll.
    if (native && !sending) return;
    lastAudioAt = Date.now();
    if (ws?.readyState === WebSocket.OPEN) send(ws, data);
    else {
      pending.push(data);
      // Bounded by seconds of audio, not by count: the pre-roll is one big buffer
      // and must not be the first thing thrown away while the socket opens.
      let held = pending.reduce((n, b) => n + b.byteLength, 0);
      while (pending.length > 1 && held > MAX_PENDING_S * bytesPerSecond(sampleRate)) held -= pending.shift()!.byteLength;
    }
  };

  /** Opens one connection; resolves when it's open, rejects if it never opens. */
  const connect = async () => {
    const { token, keyterms } = await tokenFor(apiToken, mode);
    const params = new URLSearchParams({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: String(UTTERANCE_END_MS),
      vad_events: "true",
    });
    keyterms.forEach((k) => params.append("keyterm", k));
    const started = Date.now();
    const socket = new WebSocket(`${DEEPGRAM_LISTEN}?${params}`, ["bearer", token]);
    socket.binaryType = "arraybuffer";
    ws = socket;

    await new Promise<void>((resolve, reject) => {
      let open = false;
      socket.onopen = () => {
        open = true;
        // Only a connection that stays up counts as recovered, so one that keeps dropping gives up.
        setTimeout(() => {
          if (ws === socket) failures = 0;
        }, 10_000);
        // A latency line worth keeping: from asking to hearing words is this plus the first result.
        devlog("res", `live transcription connected · ${Date.now() - started} ms`, `${sampleRate} Hz${native ? ", from the phone's ear" : ""}`);
        unreported.connections++;
        pending.splice(0).forEach((b) => send(socket, b));
        resolve();
      };
      socket.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.type === "Results") {
          const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
          if (msg.is_final) {
            if (text) events.onFinal(text, !!msg.speech_final);
            else if (msg.speech_final) events.onQuiet();
            events.onInterim("");
          } else events.onInterim(text);
        }
        if (msg.type === "UtteranceEnd") events.onQuiet();
        // Deepgram's own count of the audio it processed, sent once as the
        // connection closes. It is the number on the bill; the byte count above
        // is our estimate of it, and the two should agree.
        if (msg.type === "Metadata" && typeof msg.duration === "number" && msg.duration > 0) {
          devlog("voice", `live transcription billed ${Math.round(msg.duration)} s of audio`, `we counted ${Math.round(sentBytes / bytesPerSecond(sampleRate))} s`);
        }
      };
      socket.onerror = () => {
        if (!open) reject(new Error("Couldn't connect to live transcription"));
      };
      socket.onclose = (event) => {
        // A socket that was already replaced (closed on purpose, or superseded)
        // has nothing to reconnect: doing so opened a second connection beside
        // the live one, and a third after that.
        const current = ws === socket;
        if (current) ws = null;
        if (!open) {
          reject(new Error(`Live transcription closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
          return;
        }
        if (closed || !current) return;
        // A window that has since closed doesn't need the connection back.
        if (native && !window.awake(Date.now())) return;
        devlog("voice", `live transcription dropped (${event.code}); reconnecting`, event.reason || undefined);
        reconnect();
      };
    });
  };

  const reconnect = async () => {
    while (!closed) {
      if (failures >= MAX_RECONNECTS) {
        const err = new Error("Live transcription keeps dropping");
        teardown();
        events.onDown(err);
        return;
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAYS_MS[failures] ?? 4000));
      if (closed) return;
      if (native && !window.awake(Date.now())) return;
      try {
        await connect();
        return;
      } catch (err) {
        failures++;
        devlog("err", `live transcription reconnect ${failures} failed`, err instanceof Error ? err.message : String(err));
      }
    }
  };

  /** Ends the current connection cleanly. Deepgram sends its last results and the Metadata after CloseStream. */
  const closeSocket = () => {
    const socket = ws;
    ws = null;
    pending.length = 0;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
      socket.close();
    }
  };

  /**
   * The wake window: opens the connection when it opens, with the pre-roll
   * first, and keeps it open while it is kept open. Nothing else opens one.
   */
  const wake = (reason: WakeReason) => {
    if (closed) return;
    const now = Date.now();
    const opened = window.wake(reason, now);
    if (!native || !opened) return;
    windowBytes = 0;
    pending.length = 0;
    devlog("voice", `woke (${reason}); opening live transcription`);
    events.onWake?.(reason);
    // The few seconds kept, then live audio, as onAudio events; they queue until the socket is open.
    sending = true;
    NameEar.setSending(true).catch(() => {});
    if (!ws) {
      connect().catch((err) => {
        devlog("err", "couldn't open live transcription after waking", err instanceof Error ? err.message : String(err));
        failures++;
        reconnect();
      });
    }
  };

  /** The window ran out: stop sending, and close the connection. */
  const sleep = () => {
    sending = false;
    NameEar.setSending(false).catch(() => {});
    if (ws) closeSocket();
    pending.length = 0;
    // The number the whole change is judged by: seconds streamed per waking. No words in it.
    devlog("voice", `back to listening on the phone · ${Math.round(windowBytes / bytesPerSecond(sampleRate))} s of audio sent this time`);
    events.onSleep?.();
    events.onInterim("");
  };

  const timer = setInterval(() => {
    const now = Date.now();
    // Audio that went out since the last look goes on the day's meter.
    if (sentBytes - meteredBytes >= bytesPerSecond(sampleRate)) {
      noteStreamed((sentBytes - meteredBytes) / bytesPerSecond(sampleRate));
      meteredBytes = sentBytes;
    }
    if (native) {
      if (sending && !window.awake(now)) sleep();
      if (window.awake(now)) refreshTokenSoon(apiToken, mode);
      else if (!cachedTokens[mode] || cachedTokens[mode]!.expiresAt - now < TOKEN_REFRESH_S * 1000) refreshTokenSoon(apiToken, mode);
      // The ear's heartbeat is its loudness report. Silence from it means the
      // engine stopped: off screen that is iOS, and only the app coming back
      // fixes it; on screen it is started again, backing off between tries.
      const quiet = now - lastEarLevelAt > EAR_ALIVE_MS;
      if (quiet && !onScreen()) {
        if (!offScreenAt) {
          offScreenAt = now;
          devlog("voice", "the phone's ear went quiet with the app off screen; waiting for it to come forward");
        } else if (now - offScreenAt > OFF_SCREEN_GIVE_UP_MS) {
          devlog("voice", `the app stayed off screen for ${Math.round((now - offScreenAt) / 1000)} s; closing the ear until it's back`);
          teardown();
          events.onDown(offScreenError());
          return;
        }
      } else {
        if (offScreenAt) {
          devlog("voice", `the app is back after ${Math.round((now - offScreenAt) / 1000)} s off screen`);
          offScreenAt = 0;
          restartFailures = 0;
          lastRestartAt = 0;
        }
        const gap = restartFailures ? (RESTART_BACKOFF_MS[restartFailures - 1] ?? 30_000) : MIN_RESTART_GAP_MS;
        if (!restarting && quiet && now - lastRestartAt > gap) {
          restarting = true;
          lastRestartAt = now;
          devlogRepeat("ear restart attempt", "voice", `no sound from the phone's ear for ${now - lastEarLevelAt} ms; starting it again`);
          NameEar.stop()
            .then(() => NameEar.start({ name: wakeWord!.name, preRollSeconds: PRE_ROLL_S }))
            .then(() => {
              restartFailures = 0;
              lastEarLevelAt = Date.now();
              devlogSettled("ear restart");
            })
            .catch((err) => {
              if (!onScreen()) return;
              restartFailures++;
              const where = audioWhy(err, { attempt: `${restartFailures}/${MAX_RESTARTS}` });
              if (restartFailures >= MAX_RESTARTS) {
                devlog("err", "the phone's ear wouldn't start again; giving up on it for now", where);
                teardown();
                events.onDown(new Error("The microphone wouldn't restart"));
              } else {
                devlogRepeat("ear restart", "err", "the phone's ear wouldn't start again", where);
              }
            })
            .finally(() => {
              restarting = false;
            });
        }
      }
    } else {
      const silentFor = now - lastAudioAt;
      const quiet = silentFor > NO_AUDIO_RESTART_MS;
      // No audio and the app is off screen: iOS has halted the engine and will not
      // let it start again until the app is back in front. expo-audio still says
      // isStreaming (see the note at the top), which is how the old build came to
      // ask every three seconds and log 7,150 "mic restart failed" in a row
      // (device_logs, 2026-09-21) — each one stopping a stream it couldn't restart,
      // so the app lost the background audio that keeps it running at all.
      if (quiet && !onScreen()) {
        if (!offScreenAt) {
          offScreenAt = now;
          devlog(
            "voice",
            "no audio and the app is off screen; waiting for it to come forward",
            `silent ${silentFor} ms, expo-audio says isStreaming ${stream!.isStreaming}`,
          );
        } else if (now - offScreenAt > OFF_SCREEN_GIVE_UP_MS) {
          devlog(
            "voice",
            `the app stayed off screen for ${Math.round((now - offScreenAt) / 1000)} s; closing live transcription until it's back`,
          );
          teardown();
          events.onDown(offScreenError());
          return;
        }
      } else {
        if (offScreenAt) {
          devlog("voice", `the app is back after ${Math.round((now - offScreenAt) / 1000)} s off screen`);
          offScreenAt = 0;
          // Refusals collected on the way out say nothing about the mic on the way in.
          restartFailures = 0;
          lastRestartAt = 0;
        }
        // The mic went quiet (not silence: no buffers at all). Bring it back, waiting
        // longer after each failure rather than asking again on the same beat.
        const gap = restartFailures ? (RESTART_BACKOFF_MS[restartFailures - 1] ?? 30_000) : MIN_RESTART_GAP_MS;
        if (!restarting && quiet && now - lastRestartAt > gap) {
          restarting = true;
          lastRestartAt = now;
          devlogRepeat("mic restart attempt", "voice", `no audio from the mic for ${silentFor} ms; restarting it`);
          restart(stream!)
            .then(() => {
              restartFailures = 0;
              devlogSettled("mic restart");
            })
            .catch((err) => {
              // The app left the screen mid-restart: iOS was never going to allow
              // it, and it says nothing about the microphone, so it doesn't spend
              // the budget. The branch above picks it up on the next tick.
              if (!onScreen()) {
                devlogRepeat("mic restart off screen", "voice", "the app left the screen while the mic was restarting", audioWhy(err));
                return;
              }
              restartFailures++;
              const where = audioWhy(err, { attempt: `${restartFailures}/${MAX_RESTARTS}`, silentFor: `${silentFor} ms` });
              // Some failures don't come right by being asked again. Hand back to the
              // caller, which falls back to record-then-upload, instead of spinning.
              if (restartFailures >= MAX_RESTARTS) {
                devlog("err", "mic restart failed; giving up on live transcription", where);
                teardown();
                events.onDown(new Error("The microphone wouldn't restart"));
              } else {
                devlogRepeat("mic restart", "err", "mic restart failed", where);
              }
            })
            .finally(() => {
              lastAudioAt = Date.now();
              restarting = false;
            });
        }
      }
      // The old way's two limits, both logged so they can be read from device_logs.
      if (window.stale(now, openedAt)) {
        devlog("voice", "listening stopped itself: ten minutes with nothing said to the assistant");
        teardown();
        events.onDown(autoOffError());
        return;
      }
      if (meterOver(meter, now)) {
        devlog("voice", `listening stopped itself: ${DAILY_STREAM_CAP_S / 60} minutes streamed today`);
        teardown();
        events.onDown(cappedError());
        return;
      }
    }
    // While there's no audio, tell Deepgram we're still here so it doesn't hang up.
    // This keeps running while parked off screen: dropping the connection there
    // would only add a reconnect loop to a microphone problem.
    if (now - lastAudioAt > KEEPALIVE_MS / 2 && now - lastKeepAlive > KEEPALIVE_MS && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "KeepAlive" }));
      lastKeepAlive = now;
    }
    // About once a minute, the seconds sent so far go to the usage table.
    void reportStreamUsage(apiToken, sampleRate);
  }, 250);

  function teardown() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    subs.forEach((s) => s.remove());
    events.onLevel(-160);
    closeSocket();
    if (native) NameEar.stop().catch(() => {});
    // The number the cost pass is judged by: seconds of audio this ear sent.
    // No words in it, ever.
    const seconds = Math.round(sentBytes / bytesPerSecond(sampleRate));
    if (sentBytes || native) {
      devlog("voice", `live transcription closed · ${seconds} s of audio sent${native ? ` over ${window.opens} waking${window.opens === 1 ? "" : "s"}` : ""}`);
    }
    noteStreamed((sentBytes - meteredBytes) / bytesPerSecond(sampleRate), true);
    void reportStreamUsage(apiToken, sampleRate, true);
  }

  try {
    await loadMeter();
    if (native) {
      // iOS won't open a microphone for an app that isn't on screen. Say so, so
      // the caller waits for the app instead of blaming the ear.
      if (!onScreen()) throw offScreenError();
      const can = await NameEar.availability();
      if (!can.available) throw nameEarError(can.reason ?? "This phone can't hear the name on its own.");
      subs.push(
        NameEar.addListener("onLevel", ({ dbfs }) => {
          lastEarLevelAt = Date.now();
          events.onLevel(dbfs);
        }),
        NameEar.addListener("onAudio", ({ data }) => onBuffer(data)),
        NameEar.addListener("onName", () => wake("name")),
        // The phone's own wider match, on the words the recogniser has so far. The
        // words are used for this and nothing else: never logged, never sent. The
        // transcript grows as the person talks, so only one more mention than
        // before counts; a shorter one is a new stretch and starts the count over.
        NameEar.addListener("onWord", ({ text }) => {
          if (text.length < lastWordsLength) namesHeard = 0;
          lastWordsLength = text.length;
          const heard = nameCount(text, wakeWord!.name);
          if (heard > namesHeard) wake("name");
          namesHeard = Math.max(namesHeard, heard);
          if (heard < namesHeard) namesHeard = heard;
        }),
        NameEar.addListener("onState", ({ state, reason, engine }) => {
          if (state === "error") devlog("err", "the phone's ear reported a problem", reason);
          else if (state === "downloading") devlog("voice", "the phone is fetching its speech model (first use)");
          else if (state === "listening") lastEarLevelAt = Date.now();
          if (state === "listening" && engine) devlog("voice", `the phone's ear is listening for "${wakeWord!.name}" (${engine === "analyzer" ? "iOS 26 transcriber" : "on-device recogniser"})`);
        }),
      );
      let started: { engine: string };
      try {
        started = await NameEar.start({ name: wakeWord!.name, preRollSeconds: PRE_ROLL_S });
      } catch (err) {
        throw nameEarError(err instanceof Error ? err.message : String(err));
      }
      lastEarLevelAt = Date.now();
      // The token now, so the first waking opens the connection without a round trip.
      refreshTokenSoon(apiToken, mode);
      void started;
    } else {
      if (meterOver(meter, Date.now())) throw cappedError();
      subs.push(
        stream!.addListener("audioStreamBuffer", (buffer) => {
          events.onLevel(levelOf(buffer.data));
          onBuffer(buffer.data);
        }),
      );
      // Otherwise a fresh engine: one left "running" earlier may be dead. A reused one that is
      // dead is restarted by the no-audio check above.
      // micAlive, not isStreaming: reusing a "streaming" engine iOS had already
      // halted is what left the ear listening to a microphone that was sending
      // nothing, waiting on the no-audio check to notice.
      if (!reuse || !micAlive(stream)) {
        if (!onScreen()) throw offScreenError();
        await restart(stream!);
      }
      lastAudioAt = Date.now();
      await connect();
      failures = 0;
    }
  } catch (err) {
    teardown();
    throw err;
  }
  return { close: teardown, wake, awake: () => (native ? window.awake(Date.now()) : true), native };
}
