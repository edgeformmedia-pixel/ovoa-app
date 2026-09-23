import { requireOptionalNativeModule } from "expo";
import { File, Paths } from "expo-file-system";
import type { ExpoSpeechRecognitionModule as SpeechModule, ExpoSpeechRecognitionOptions } from "expo-speech-recognition";
import { Alert, AppState, Platform } from "react-native";
import { devlog } from "./devlog";
import { isRunning as nameEarRunning } from "../../modules/name-ear";

// Recordings turned into words on the iPhone itself.
//
// Started for free notes: a free plan has no AI, so it has no server bill to
// hide transcription in (docs/paywall/SPEC.md §1). Since 2026-09-23 it is how
// every recording becomes words, on every plan: the band's notes, a band
// question to Talk (assistant.tsx bandAnswer), and the timeline's recordings
// (capture.ts). The server no longer transcribes anything (api voice.ts).
// Apple's speech recognition is free and, with requiresOnDeviceRecognition,
// runs on the phone, so the audio never leaves it and the server only ever
// receives the text. (A phone that can't recognise on its own uses Apple's
// servers instead, for recordings the person made on purpose: see
// ALLOW_APPLE_SERVERS. The audio never goes to OVOA's server on this path.)
//
// It also has the one live recogniser outside the phone's ear: listenLive,
// below, for a turn someone starts on a phone whose ear can't run.
//
// The library is expo-speech-recognition (jamsch), the maintained Expo module
// for SFSpeechRecognizer, with an SDK 57 release (57.x) and a config plugin for
// the two permission strings. Its file mode reads the file with AVAudioFile and
// feeds it to an SFSpeechAudioBufferRecognitionRequest; for files it never
// touches the audio session or the microphone, so it can't fight name-ear's
// engine (modules/name-ear), which owns both while the orb listens. (Its
// microphone mode, listenLive below, does touch them: it only runs where the
// ear can't.)
//
// Why there is no opus converter here: SFSpeechRecognizer can't read the
// Band's raw file at all. The ES100 stores bare opus packets back to back with
// no container (modules/ute-ble/ios/src/OpusWav.swift), which AVAudioFile can't
// open. But the ute-ble module already decodes every download on the phone to
// a 16 kHz PCM WAV next to it (Recording.wavName), with iOS's own opus decoder,
// and that WAV is exactly what AVAudioFile and the recogniser take. So the
// conversion exists, in Swift, one step earlier; this file only ever gets the WAV.
//
// Guarded like modules/ute-ble: on the web, in Expo Go, or with a build that
// predates the module, the native side is simply absent and every call here
// returns null, which the caller turns into "Couldn't transcribe on this phone".

type Speech = typeof SpeechModule;

/** requireOptional: null rather than a throw where the native module isn't built in (web, Expo Go). */
const native: Speech | null = Platform.OS === "ios" ? requireOptionalNativeModule<Speech>("ExpoSpeechRecognition") : null;

/** True when this build can recognise speech on the phone at all. */
export const onDeviceSpeechBuilt = native !== null;

export type OnDeviceTranscript = { text: string; onDevice: boolean };

/**
 * Apple stops a recognition request after about a minute (always through its
 * servers, and name-ear retires on-device tasks at 50 s for the same reason).
 * Longer WAVs are cut into pieces under that and recognised one after another.
 */
const PIECE_SECONDS = 55;
/** Each cut is moved back to the quietest moment in this stretch before it, so it falls between words. */
const CUT_SEARCH_SECONDS = 8;

/**
 * When the phone can't recognise on its own (an old iPhone, or a language it
 * has no local model for), use Apple's servers rather than no note at all.
 * The result says onDevice: false, and the log says so. Flip to false to make
 * "never leaves the phone" absolute. Only ever for something the person
 * started: a recording made on purpose, or a turn they began (listenLive).
 * Never for listening for the name or Always listen (decision 1, 2026-09-23),
 * which run on the phone's ear alone and simply don't run without one.
 */
const ALLOW_APPLE_SERVERS = true;

/** What the permission prompt, the consent screen and the privacy policy all say (decision 1). */
export const SPEECH_PROMISE =
  "Your voice is recognised on your iPhone, or by Apple's speech service on iPhones that can't do it themselves. It's never sent to OVOA or the AI companies.";

// ---------- Permission ----------

/** "Not now" was pressed this launch: don't ask again until the app restarts. */
let declinedThisLaunch = false;

/** Whether speech recognition is allowed right now. Never asks. */
export async function speechAllowed(): Promise<boolean> {
  if (!native) return false;
  try {
    return (await native.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/**
 * Speech recognition (and the microphone, which the library checks even for
 * files) allowed. Asks only when it has never been answered, and only after a
 * one-line reason. Returns whether it's allowed now. A "no" from iOS stays a
 * no until Settings. Off screen it can't ask (iOS shows no prompt there) and
 * says no, which is why the app asks in the foreground ahead of time: when
 * talking starts, and as soon as a band is paired (assistant.tsx), so a band
 * click from the wrist later doesn't find it unanswered.
 */
export async function ensureSpeechPermission(): Promise<boolean> {
  if (!native) return false;
  try {
    const now = await native.getPermissionsAsync();
    if (now.granted) return true;
    if (!now.canAskAgain || now.status === "denied" || declinedThisLaunch) return false;
    // A system prompt can't show from the background; the next recording in the foreground asks.
    if (AppState.currentState !== "active") return false;
    const go = await new Promise<boolean>((resolve) =>
      Alert.alert(
        "Let your iPhone hear you",
        SPEECH_PROMISE,
        [
          { text: "Not now", style: "cancel", onPress: () => resolve(false) },
          { text: "Continue", onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
    if (!go) {
      declinedThisLaunch = true;
      devlog("voice", "on-device transcription: permission deferred (Not now)");
      return false;
    }
    const answer = await native.requestPermissionsAsync();
    devlog("voice", `on-device transcription: permission ${answer.granted ? "granted" : answer.status}`);
    return answer.granted;
  } catch (err) {
    devlog("err", "on-device transcription: couldn't check permission", message(err));
    return false;
  }
}

// ---------- Language ----------

const norm = (id: string) => id.replace(/_/g, "-").toLowerCase();

/**
 * The phone's own language, as the recogniser names it: the exact variant if
 * it has one, else another variant of the same language, else null. OVOA's
 * notes are in whatever the person speaks, so no forced English here.
 */
async function pickLocale(speech: Speech): Promise<{ lang: string; exact: boolean } | null> {
  const phone = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  const { locales } = await speech.getSupportedLocales({});
  const want = norm(phone);
  const exact = locales.find((l) => norm(l) === want);
  if (exact) return { lang: exact, exact: true };
  const language = want.split("-")[0];
  const sibling = locales.find((l) => norm(l).split("-")[0] === language);
  return sibling ? { lang: sibling, exact: false } : null;
}

// ---------- WAV pieces ----------

type Wav = { rate: number; channels: number; bits: number; dataStart: number; dataBytes: number; bytes: Uint8Array };

/** The fmt and data chunks of a PCM WAV, wherever they sit. Null for anything else. */
function parseWav(bytes: Uint8Array): Wav | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let at = 12;
  let fmt: { rate: number; channels: number; bits: number; format: number } | null = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      fmt = { format: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    } else if (id === "data" && fmt) {
      if (fmt.format !== 1 || fmt.bits !== 16) return null;
      return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, dataStart: at + 8, dataBytes: Math.min(size, bytes.length - at - 8), bytes };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

function wavHeader(rate: number, channels: number, dataBytes: number) {
  const out = new Uint8Array(44);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, dataBytes, true);
  return out;
}

/**
 * Where to cut: the quietest tenth of a second in the few seconds before
 * `limit` (a frame index), so a word isn't split across two requests.
 */
function quietCut(wav: Wav, from: number, limit: number) {
  const frameBytes = wav.channels * 2;
  const view = new DataView(wav.bytes.buffer, wav.bytes.byteOffset, wav.bytes.byteLength);
  const window = Math.round(wav.rate / 10);
  const start = Math.max(from + window, limit - CUT_SEARCH_SECONDS * wav.rate);
  let best = limit;
  let bestEnergy = Infinity;
  for (let w = start; w + window <= limit; w += window) {
    let energy = 0;
    // Every eighth sample of the first channel is plenty to find a pause.
    for (let f = w; f < w + window; f += 8) {
      const s = view.getInt16(wav.dataStart + f * frameBytes, true);
      energy += s * s;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = w + Math.floor(window / 2);
    }
  }
  return best;
}

/** The WAV cut into pieces of at most PIECE_SECONDS, written to cache. Deleted by the caller. */
function splitWav(wav: Wav): File[] {
  const frameBytes = wav.channels * 2;
  const frames = Math.floor(wav.dataBytes / frameBytes);
  const most = PIECE_SECONDS * wav.rate;
  const pieces: File[] = [];
  const stamp = Date.now();
  for (let from = 0; from < frames; ) {
    const to = frames - from <= most ? frames : quietCut(wav, from, from + most);
    const body = wav.bytes.subarray(wav.dataStart + from * frameBytes, wav.dataStart + to * frameBytes);
    const out = new Uint8Array(44 + body.length);
    out.set(wavHeader(wav.rate, wav.channels, body.length), 0);
    out.set(body, 44);
    const file = new File(Paths.cache, `ondevice-${stamp}-${pieces.length}.wav`);
    if (file.exists) file.delete();
    file.write(out);
    pieces.push(file);
    from = to;
  }
  return pieces;
}

// ---------- One recognition request ----------

/** The library is one recogniser for the whole app: requests queue behind each other. */
let queue: Promise<unknown> = Promise.resolve();

type PieceResult = { text: string } | { error: string; message: string };

function recognise(speech: Speech, uri: string, lang: string, onDevice: boolean, timeoutMs: number): Promise<PieceResult> {
  return new Promise<PieceResult>((resolve) => {
    // iOS 18 and later report one "final" per stretch of speech rather than one
    // for the whole file (the library's workaround for Apple's change), and the
    // closing final can repeat the last stretch. So finals are collected, a
    // repeat is dropped, and an interim still pending at the end is kept.
    const finals: string[] = [];
    let pending = "";
    let failed: { error: string; message: string } | null = null;
    let done = false;
    const subs = [
      speech.addListener("result", (e) => {
        const text = (e.results[0]?.transcript ?? "").trim();
        if (!e.isFinal) {
          pending = text;
          return;
        }
        pending = "";
        if (!text) return;
        const last = finals[finals.length - 1];
        if (last === text) return;
        // Before iOS 18 a final holds everything so far; it replaces, not adds.
        if (last && text.startsWith(last)) finals[finals.length - 1] = text;
        else finals.push(text);
      }),
      speech.addListener("error", (e) => {
        failed = { error: e.error, message: e.message };
      }),
      speech.addListener("end", () => finish()),
    ];
    const timer = setTimeout(() => {
      failed = failed ?? { error: "timeout", message: `No answer from the recogniser in ${Math.round(timeoutMs / 1000)} s` };
      try {
        speech.abort();
      } catch {}
      // abort() answers with its own "end"; waiting for it keeps that stray
      // event out of the next queued request. The second timer is for when it never comes.
      setTimeout(finish, 1500);
    }, timeoutMs);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subs.forEach((s) => s.remove());
      if (pending) finals.push(pending);
      const text = finals.join(" ").replace(/\s+/g, " ").trim();
      // Silence is an answer ("no-speech"), not a failure; words beat a late error.
      if (text || !failed || failed.error === "no-speech") resolve({ text });
      else resolve(failed);
    }

    const options: ExpoSpeechRecognitionOptions = {
      lang,
      interimResults: true,
      continuous: false,
      requiresOnDeviceRecognition: onDevice,
      addsPunctuation: true,
      audioSource: { uri },
    };
    try {
      speech.start(options);
    } catch (err) {
      failed = { error: "start", message: message(err) };
      finish();
    }
  });
}

// ---------- The call ----------

/**
 * Turns a saved recording into text on this iPhone. `uri` is a file the phone
 * can open with AVAudioFile: the Band's decoded WAV (Recording.wavName, not the
 * raw opus), or an m4a / caf / wav from the app's own recorder.
 *
 * Resolves `{ text, onDevice }` (text "" means nothing was said), or null when
 * this phone can't: the web, Expo Go, speech recognition not allowed, a
 * language it doesn't have, or the recogniser failing. The caller then keeps
 * the audio and says "Couldn't transcribe on this phone". Never throws.
 */
export function transcribeOnDevice(uri: string): Promise<OnDeviceTranscript | null> {
  const run = queue.then(() => transcribeNow(uri));
  queue = run.catch(() => undefined);
  return run;
}

async function transcribeNow(uri: string): Promise<OnDeviceTranscript | null> {
  const speech = native;
  if (!speech) return null;
  const started = Date.now();
  const pieces: File[] = [];
  try {
    if (!(await ensureSpeechPermission())) {
      devlog("warn", "on-device transcription skipped: speech recognition not allowed");
      return null;
    }
    const locale = await pickLocale(speech);
    if (!locale) {
      devlog("warn", "on-device transcription skipped: no recogniser for this phone's language", Intl.DateTimeFormat().resolvedOptions().locale);
      return null;
    }
    // supportsOnDeviceRecognition() asks about the phone's own language, so it
    // only vouches for the exact variant; a stand-in variant is sent as off-device.
    const onDevice = locale.exact && speech.supportsOnDeviceRecognition();
    if (!onDevice && !ALLOW_APPLE_SERVERS) {
      devlog("warn", "on-device transcription skipped: this iPhone can't recognise on its own", locale.lang);
      return null;
    }

    const source = new File(uri);
    if (!source.exists) {
      devlog("warn", "on-device transcription skipped: the audio isn't there", uri);
      return null;
    }
    let files = [uri];
    let seconds: number | null = null;
    if (/\.wav$/i.test(source.name)) {
      const wav = parseWav(await source.bytes());
      if (wav) {
        seconds = wav.dataBytes / (wav.rate * wav.channels * 2);
        if (seconds > PIECE_SECONDS) {
          pieces.push(...splitWav(wav));
          files = pieces.map((p) => p.uri);
        }
      }
    }

    const texts: string[] = [];
    for (const [i, file] of files.entries()) {
      // A piece's audio is fed at many times real time; a generous ceiling still catches a hang.
      const timeoutMs = Math.max(30_000, (seconds === null ? 180 : Math.min(seconds, PIECE_SECONDS)) * 1000 * 2 + 15_000);
      const out = await recognise(speech, file, locale.lang, onDevice, timeoutMs);
      if ("error" in out) {
        devlog(
          "warn",
          `on-device transcription failed: ${out.error}`,
          `${out.message}\npiece ${i + 1} of ${files.length} · ${locale.lang} · onDevice ${onDevice} · ${Date.now() - started} ms · name-ear ${nameEarRunning() ? "running" : "off"}\n${source.name}`,
        );
        return null;
      }
      if (out.text) texts.push(out.text);
    }
    const text = texts.join(" ").trim();
    const ms = Date.now() - started;
    // A milestone (remoteLog.ts): uploaded from release builds, one row per note.
    devlog(
      "voice",
      `on-device transcript after ${ms} ms`,
      `${seconds === null ? "?" : seconds.toFixed(1)} s of audio · ${files.length} piece${files.length === 1 ? "" : "s"} · ${text.length} chars · ${locale.lang} · ${onDevice ? "on the phone" : "Apple's servers"}`,
      { collapse: false },
    );
    return { text, onDevice };
  } catch (err) {
    devlog("warn", "on-device transcription failed", `${message(err)}\n${uri}\n${Date.now() - started} ms`);
    return null;
  } finally {
    for (const p of pieces) {
      try {
        if (p.exists) p.delete();
      } catch {}
    }
  }
}

// ---------- Live, with the library's own microphone ----------

/** English, in the phone's own variety when it's set to one: what the assistant speaks, like the ear (NameEar.locale()). */
function englishLocale() {
  const phone = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  return norm(phone).startsWith("en") ? phone.replace(/_/g, "-") : "en-US";
}

/** The library's volume (-2 to 10) as the rough dBFS the orb's halo reads (about -60 to -12). */
const levelOf = (value: number) => (value <= -2 ? -160 : -60 + (value + 2) * 4);

/** How long to wait for the library to say it started (or why it couldn't). */
const LIVE_START_MS = 4000;

/**
 * Hears a turn someone started, with the library's own microphone, on a phone
 * whose ear (modules/name-ear) can't run there: one that can't recognise
 * speech on its own. Its words go where the ear's would (liveListen.ts).
 *
 * It may use Apple's servers, so it is only ever for a turn the person began
 * (the orb, a click, dictation, setup) and never for listening for the name or
 * Always listen (decision 1, 2026-09-23). Only in the foreground: iOS won't
 * open a microphone for an app that's off screen. Mixable, like the ear's
 * session, so a reply plays while it listens.
 *
 * Holds the recogniser while it runs: a file transcription waits until it
 * stops. Resolves once listening; rejects with a sentence when it can't.
 */
export async function listenLive(handlers: {
  onWord: (text: string, isFinal: boolean) => void;
  onLevel: (dbfs: number) => void;
  /** It stopped by itself (Apple's minute ran out, the session was taken, an error). Not called after stop(). */
  onEnd: (error: string | null) => void;
}): Promise<{ stop: () => void; onDevice: boolean }> {
  const speech = native;
  if (!speech) throw permanent("This build can't recognise speech on the phone.");
  if (!(await ensureSpeechPermission())) {
    throw permanent("Speech recognition isn't allowed for OVOA. Turn it on in Settings > OVOA to talk to it.");
  }
  // Behind any file being transcribed, then holding the recogniser until this stops.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const before = queue;
  queue = before.then(() => held, () => held);
  await before.catch(() => undefined);

  const lang = englishLocale();
  const onDevice = speech.supportsOnDeviceRecognition();
  if (!onDevice && !ALLOW_APPLE_SERVERS) {
    release();
    throw permanent("This iPhone can't recognise speech on its own.");
  }
  let stopped = false;
  let ended = false;
  /** Past the start: from here an end on its own is news for the caller. */
  let listening = false;
  let lastError: string | null = null;
  let started: ((ok: boolean) => void) | null = null;
  const subs = [
    speech.addListener("start", () => started?.(true)),
    speech.addListener("result", (e) => {
      if (stopped) return;
      handlers.onWord((e.results[0]?.transcript ?? "").trim(), e.isFinal);
    }),
    speech.addListener("volumechange", (e) => {
      if (!stopped) handlers.onLevel(levelOf(e.value));
    }),
    speech.addListener("error", (e) => {
      lastError = `${e.error}: ${e.message}`;
    }),
    speech.addListener("end", () => finish()),
  ];
  function finish() {
    if (ended) return;
    ended = true;
    subs.forEach((s) => s.remove());
    release();
    started?.(false);
    if (!stopped && listening) handlers.onEnd(lastError);
  }
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      speech.abort();
    } catch {}
    // abort() answers with its own "end"; this is for when it never comes.
    setTimeout(finish, 1500);
  };

  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => started?.(false), LIVE_START_MS);
    started = (yes) => {
      clearTimeout(timer);
      started = null;
      resolve(yes);
    };
    try {
      speech.start({
        lang,
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: onDevice,
        addsPunctuation: true,
        contextualStrings: ["OVOA"],
        iosTaskHint: "dictation",
        iosCategory: { category: "playAndRecord", categoryOptions: ["defaultToSpeaker", "allowBluetooth", "mixWithOthers"], mode: "default" },
        volumeChangeEventOptions: { enabled: true, intervalMillis: 200 },
      });
    } catch (err) {
      lastError = message(err);
      started?.(false);
    }
  });
  if (!ok || ended) {
    const why = lastError ?? "no answer from the recogniser";
    stop();
    throw new Error(`Couldn't start listening: ${why}`);
  }
  listening = true;
  devlog("voice", `listening with Apple's recogniser (${onDevice ? "on the phone" : "Apple's servers"})`, lang);
  return { stop, onDevice };
}

/** A refusal that asking again won't change: the caller stops listening and shows it (voice.ts). */
const permanent = (text: string) => Object.assign(new Error(text), { permanent: true });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
