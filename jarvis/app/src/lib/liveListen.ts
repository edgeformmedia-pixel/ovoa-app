import { AudioModule, type AudioStream } from "expo-audio";
import { useEffect, useState } from "react";
import { request } from "./api";
import { devlog } from "./devlog";

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
const KEEPALIVE_MS = 4000;
// A dropped connection is reopened; after this many failures in a row, give up
// (the conversation falls back to recording for a while).
const MAX_RECONNECTS = 3;
const RECONNECT_DELAYS_MS = [300, 1500, 4000];
const MAX_PENDING_BUFFERS = 100; // ~10 s of audio kept while (re)connecting

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
  useEffect(() => () => stream?.release(), [stream]);
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
export async function openEar(stream: AudioStream, apiToken: string, events: EarEvents): Promise<Ear> {
  const pending: ArrayBuffer[] = [];
  let ws: WebSocket | null = null;
  let closed = false;
  let lastAudioAt = Date.now();
  let lastRestartAt = 0;
  let restarting = false;
  let lastKeepAlive = Date.now();
  let failures = 0;

  const sub = stream.addListener("audioStreamBuffer", (buffer) => {
    events.onLevel(levelOf(buffer.data));
    lastAudioAt = Date.now();
    if (ws?.readyState === WebSocket.OPEN) ws.send(buffer.data);
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
        pending.splice(0).forEach((b) => socket.send(b));
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
    // The mic went quiet (not silence: no buffers at all). Bring it back.
    if (!restarting && silentFor > NO_AUDIO_RESTART_MS && now - lastRestartAt > MIN_RESTART_GAP_MS) {
      restarting = true;
      lastRestartAt = now;
      devlog("voice", `no audio from the mic for ${silentFor} ms; restarting it`);
      restart(stream)
        .catch((err) => devlog("err", "mic restart failed", String(err)))
        .finally(() => {
          lastAudioAt = Date.now();
          restarting = false;
        });
    }
    // While there's no audio, tell Deepgram we're still here so it doesn't hang up.
    if (silentFor > KEEPALIVE_MS / 2 && now - lastKeepAlive > KEEPALIVE_MS && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "KeepAlive" }));
      lastKeepAlive = now;
    }
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
  }

  try {
    // Always a fresh engine: one left "running" earlier may be dead.
    await restart(stream);
    lastAudioAt = Date.now();
    await connect();
    failures = 0;
  } catch (err) {
    teardown();
    throw err;
  }
  return { close: teardown };
}
