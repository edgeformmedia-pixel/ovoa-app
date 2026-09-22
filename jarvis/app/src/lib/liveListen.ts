import { AudioModule, type AudioStream } from "expo-audio";
import { useEffect, useState } from "react";
import { API_URL, request } from "./api";
import { devlog, devlogRepeat, devlogSettled } from "./devlog";
import { audioWhy, onScreen } from "./foreground";

// Live transcription: the microphone streams straight to Deepgram over one
// connection that stays open for as long as we're listening, through replies
// and all. Words come back while people are still talking; deciding which of
// them are meant for the assistant happens on the phone (turnGate.ts). The app
// gets a 30-second token from our server to open each connection; the real key
// stays on the server.

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
const MAX_PENDING_BUFFERS = 100; // ~10 s of audio kept while (re)connecting
/**
 * The app has been off screen with a halted mic this long: hand the ear back
 * rather than hold a Deepgram connection open for a microphone that iOS has
 * taken away. The caller reopens it when the app comes forward.
 */
const OFF_SCREEN_GIVE_UP_MS = 60_000;
/** No PCM buffer for this long means the engine isn't really running, whatever isStreaming says. */
const MIC_ALIVE_MS = 2000;

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
};

export type Ear = { close: () => void };

/**
 * Starts the microphone and keeps a live transcription connection open until
 * `close`. Resolves once the first connection is open; throws if it can't be.
 */
export async function openEar(
  stream: AudioStream,
  apiToken: string,
  events: EarEvents,
  /** Use the mic as it is if it's running: in the background iOS may not let it start again. */
  { reuse = false } = {},
): Promise<Ear> {
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
  const sampleRate = stream.sampleRate || SAMPLE_RATE;
  /** Counts audio the moment it goes out: the only honest measure of what Deepgram will bill. */
  const send = (socket: WebSocket, data: ArrayBuffer) => {
    socket.send(data);
    sentBytes += data.byteLength;
    unreported.bytes += data.byteLength;
  };

  const sub = stream.addListener("audioStreamBuffer", (buffer) => {
    events.onLevel(levelOf(buffer.data));
    lastAudioAt = Date.now();
    if (ws?.readyState === WebSocket.OPEN) send(ws, buffer.data);
    else {
      pending.push(buffer.data);
      if (pending.length > MAX_PENDING_BUFFERS) pending.shift();
    }
  });

  /** Opens one connection; resolves when it's open, rejects if it never opens. */
  const connect = async () => {
    const { token, keyterms = [] } = await request<{ token: string; keyterms?: string[] }>(
      "/voice/token",
      apiToken,
      { method: "POST" },
    );
    const params = new URLSearchParams({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: String(stream.sampleRate || SAMPLE_RATE),
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
        devlog("res", `live transcription connected · ${Date.now() - started} ms`, `${stream.sampleRate} Hz`);
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
        if (ws === socket) ws = null;
        if (!open) {
          reject(new Error(`Live transcription closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
          return;
        }
        if (closed) return;
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
      try {
        await connect();
        return;
      } catch (err) {
        failures++;
        devlog("err", `live transcription reconnect ${failures} failed`, err instanceof Error ? err.message : String(err));
      }
    }
  };

  const timer = setInterval(() => {
    const now = Date.now();
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
          `silent ${silentFor} ms, expo-audio says isStreaming ${stream.isStreaming}`,
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
        restart(stream)
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
    // While there's no audio, tell Deepgram we're still here so it doesn't hang up.
    // This keeps running while parked off screen: dropping the connection there
    // would only add a reconnect loop to a microphone problem.
    if (silentFor > KEEPALIVE_MS / 2 && now - lastKeepAlive > KEEPALIVE_MS && ws?.readyState === WebSocket.OPEN) {
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
    sub.remove();
    events.onLevel(-160);
    const socket = ws;
    ws = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
      socket.close();
    }
    // The number the cost pass is judged by: seconds of audio this ear sent.
    // No words in it, ever.
    const seconds = Math.round(sentBytes / bytesPerSecond(sampleRate));
    if (sentBytes) devlog("voice", `live transcription closed · ${seconds} s of audio sent`);
    void reportStreamUsage(apiToken, sampleRate, true);
  }

  try {
    // Otherwise a fresh engine: one left "running" earlier may be dead. A reused one that is
    // dead is restarted by the no-audio check above.
    // micAlive, not isStreaming: reusing a "streaming" engine iOS had already
    // halted is what left the ear listening to a microphone that was sending
    // nothing, waiting on the no-audio check to notice.
    if (!reuse || !micAlive(stream)) {
      // iOS won't open a microphone for an app that isn't on screen. Say so, so
      // the caller waits for the app instead of blaming live transcription.
      if (!onScreen()) throw offScreenError();
      await restart(stream);
    }
    lastAudioAt = Date.now();
    await connect();
    failures = 0;
  } catch (err) {
    teardown();
    throw err;
  }
  return { close: teardown };
}
