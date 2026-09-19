import { AudioModule, type AudioStream } from "expo-audio";
import { useEffect, useState } from "react";
import { request } from "./api";
import { devlog } from "./devlog";

// Live transcription: the microphone streams straight to Deepgram, words come
// back while the user is still talking, and Deepgram says when they've finished
// (so there's no guessing from loudness). The app gets a 30-second token from
// our server to open the connection; the real key stays on the server.

const SAMPLE_RATE = 16000;
const DEEPGRAM_LISTEN = "wss://api.deepgram.com/v1/listen";
const ENDPOINTING_MS = 600; // this much silence after words ends the sentence
const UTTERANCE_END_MS = 1200; // backup: no new words for this long ends it too
// iOS silently stops the mic engine when the audio session changes (e.g. after
// a reply plays) while expo-audio still reports it as streaming, so start() is
// a no-op and Deepgram closes the socket for lack of audio (code 1001). If no
// audio arrives for this long, restart the stream.
const NO_AUDIO_RESTART_MS = 1500;
const KEEPALIVE_MS = 4000;

/** Stops and starts the stream, so a mic engine iOS quietly halted comes back. */
async function restart(stream: AudioStream) {
  stream.stop();
  await stream.start();
}

/** The native PCM stream, or null if this build of Expo Go doesn't have it. */
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

type ListenOptions = {
  cancelled: () => boolean;
  /** Everything heard so far in this turn, updated as words arrive. */
  onWords: (text: string) => void;
  onLevel: (level: number) => void;
  /** Give up (return "") if nobody says anything for this long. */
  noSpeechMs: number;
  maxMs: number;
  /**
   * Leave the microphone running afterwards. In the background iOS suspends the
   * app the moment audio stops, so always-listening never lets it stop.
   */
  keepRunning?: boolean;
};

/**
 * Listens until the user finishes a sentence and returns it, or "" if nobody
 * spoke (or it was cancelled). Throws if the live connection can't be made.
 */
export async function listenLive(stream: AudioStream, apiToken: string, opts: ListenOptions): Promise<string> {
  const tokenRequest = request<{ token: string; keyterms?: string[] }>("/voice/token", apiToken, { method: "POST" });
  // Audio captured before the connection is open; sent as soon as it is.
  const pending: ArrayBuffer[] = [];
  let ws: WebSocket | null = null;
  let chunks = 0;
  let lastAudioAt = Date.now();
  let restarts = 0;

  const sub = stream.addListener("audioStreamBuffer", (buffer) => {
    opts.onLevel(levelOf(buffer.data));
    chunks++;
    lastAudioAt = Date.now();
    if (ws?.readyState === WebSocket.OPEN) ws.send(buffer.data);
    else if (pending.length < 100) pending.push(buffer.data);
  });

  try {
    // Always a fresh engine: one left "running" from the last turn may be dead.
    await restart(stream);
    lastAudioAt = Date.now();
    const { token, keyterms = [] } = await tokenRequest;
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
    const socket = new WebSocket(`${DEEPGRAM_LISTEN}?${params}`, ["bearer", token]);
    socket.binaryType = "arraybuffer";
    ws = socket;

    return await new Promise<string>((resolve, reject) => {
      const started = Date.now();
      let finals = "";
      let interim = "";
      let done = false;
      const heard = () => `${finals} ${interim}`.trim();

      const finish = (text: string, why: string) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        if (text) devlog("voice", `sentence finished (${why})`, text);
        resolve(text);
      };

      socket.onopen = () => {
        devlog("res", `live transcription connected · ${Date.now() - started} ms`, `${stream.sampleRate} Hz`);
        pending.splice(0).forEach((b) => socket.send(b));
      };

      socket.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.type === "SpeechStarted") devlog("voice", "speech started");
        if (msg.type === "Results") {
          const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
          if (msg.is_final) {
            if (text) finals = `${finals} ${text}`.trim();
            interim = "";
          } else {
            interim = text;
          }
          opts.onWords(heard());
          if (msg.speech_final && finals) finish(finals, "pause");
        }
        if (msg.type === "UtteranceEnd" && heard()) finish(heard(), "no more words");
      };

      socket.onerror = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        reject(new Error("Couldn't connect to live transcription"));
      };

      socket.onclose = (event) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        if (heard()) resolve(heard());
        else reject(new Error(`Live transcription closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
      };

      let restarting = false;
      let lastKeepAlive = Date.now();
      const timer = setInterval(() => {
        const elapsed = Date.now() - started;
        const silentFor = Date.now() - lastAudioAt;
        // The mic went quiet (not silence, no buffers at all): bring it back.
        if (!restarting && silentFor > NO_AUDIO_RESTART_MS && restarts < 3) {
          restarting = true;
          restarts++;
          devlog("voice", `no audio from the mic for ${silentFor} ms; restarting it`, `restart ${restarts}`);
          restart(stream)
            .catch((err) => devlog("err", "mic restart failed", String(err)))
            .finally(() => {
              lastAudioAt = Date.now();
              restarting = false;
            });
        }
        // While there's no audio, tell Deepgram we're still here so it doesn't hang up.
        if (silentFor > KEEPALIVE_MS / 2 && Date.now() - lastKeepAlive > KEEPALIVE_MS && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "KeepAlive" }));
          lastKeepAlive = Date.now();
        }
        if (opts.cancelled()) finish("", "cancelled");
        else if (!heard() && elapsed >= opts.noSpeechMs) {
          devlog("voice", `no speech in ${Math.round(elapsed / 1000)}s, listening again`, `${chunks} audio chunks sent`);
          finish("", "no speech");
        } else if (elapsed >= opts.maxMs) finish(heard(), "too long");
      }, 200);
    });
  } finally {
    sub.remove();
    if (!opts.keepRunning) stream.stop();
    opts.onLevel(-160);
    if (ws) {
      const socket = ws;
      ws = null;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
      socket.close();
    }
  }
}
