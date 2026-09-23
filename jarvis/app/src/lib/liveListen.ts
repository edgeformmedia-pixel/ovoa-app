import { useEffect, useState } from "react";
import { AppState } from "react-native";
import * as NameEar from "../../modules/name-ear";
import { devlog, devlogRepeat, devlogSettled } from "./devlog";
import { EarWords } from "./earWords";
import { audioWhy, onScreen } from "./foreground";
import { listenLive, onDeviceSpeechBuilt } from "./onDeviceTranscribe";
import { storage } from "./storage";
import { nameCount } from "./turnGate";
import { WakeWindow, type WakeReason } from "./wakeWindow";

// Hearing what people say, on the phone.
//
// Since 2026-09-23 speech is recognised on the iPhone and only text leaves it
// (the v1 brief's Phase 3, decisions 1 and 13). Two recognisers, one shape:
//
//   The phone's ear (modules/name-ear): Apple's on-device recognition over a
//   microphone the native side owns. It is the only one allowed to listen for
//   the name, to run Always listen, or to stand by for a click from another
//   app: it never uses the network, and iOS keeps a microphone that is already
//   running alive off screen, though it won't open a new one there ('!int').
//
//   Apple's recogniser through expo-speech-recognition (onDeviceTranscribe.ts
//   listenLive): only on a phone where the ear can't run, only for a turn the
//   person started (the orb, a click, dictation, setup), and only on screen,
//   because it may use Apple's servers.
//
// Either way the words go through earWords.ts, which turns the recogniser's
// growing, self-correcting text into the interim / final / quiet events the
// turn gate reads (turnGate.ts); a finished request goes to /chat as text.
//
// Two ways to listen:
//   room: the words reach the gate only inside a wake window (wakeWindow.ts),
//     which opens a few words before the name, at a click, and for a moment
//     after a reply. Outside it, room talk isn't even looked at.
//   open: every word reaches the gate (tap-to-talk, dictation, setup, and a
//     click from the standby, from the click on).
//
// Until 2026-09-23 this file streamed the microphone to Deepgram's live
// transcription: all the time the old way, or inside the wake window from the
// ear. The stream, its tokens, the usage reports, the ten-minute auto-off and
// the hour-a-day meter went with it, and so did voice.ts's record-and-upload
// fallback. api/test/deepgram.test.ts checks nothing asks Deepgram to listen.

/** Restarting backs off instead of retrying on the same beat forever (device_logs, 2026-09-21: 4,922 identical failures). */
const MIN_RESTART_GAP_MS = 3000;
const RESTART_BACKOFF_MS = [3000, 6000, 12000, 30000];
/**
 * ...except when iOS said '!pri' (OSStatus 561017449, insufficient priority):
 * another audio session outranks ours for the moment, and it usually clears in
 * well under a second. The long backoff above left the ear deaf for up to 14.6 s
 * after one (device_logs, 2026-09-23). These don't count towards giving up.
 */
const PRIORITY_BACKOFF_MS = [500, 1000, 2000, 5000];
/** After this many restarts in a row achieve nothing, stop and let the caller back off. */
const MAX_RESTARTS = 5;
/**
 * The app has been off screen with a silent ear this long: hand it back rather
 * than wait on a microphone iOS has taken away. The caller reopens it when the
 * app comes forward.
 */
const OFF_SCREEN_GIVE_UP_MS = 60_000;
/** The native ear reports loudness five times a second; this long without one and it has stopped. */
const EAR_ALIVE_MS = 5000;
/**
 * A tap or a click: words that appeared this long before it still count. The
 * recogniser runs a moment behind the voice, and a click crosses Bluetooth.
 */
const EARLY_MS = 1000;
const TICK_MS = 150;
/** Apple's recogniser ends itself (about a minute through its servers); it is started again this soon. */
const APPLE_RESTART_MS = 300;
/** ...and an end sooner than this after starting counts as a failure, not the minute running out. */
const APPLE_QUICK_END_MS = 5000;

// ---------- What the phone heard ----------

/**
 * One for the whole app: the ear is one microphone, and a click from the
 * standby has to know what was said before anyone was listening, so its words
 * are followed from the moment it starts, not from when a conversation opens.
 */
const heard = new EarWords();
/** Which recogniser `heard` is following. */
let source: "ear" | "apple" | null = null;
/** When the native ear last reported loudness: its heartbeat. */
let lastEarLevelAt = 0;
/** The open ear's hooks, fed by the one set of native listeners below. */
let hooks: { word: (text: string) => void; name: () => void; level: (dbfs: number) => void } | null = null;
let listening = false;
/**
 * The ear said it stopped on its own (an interruption, iOS resetting its audio,
 * a microphone it couldn't pick up again): watchEar starts it again now rather
 * than after EAR_ALIVE_MS of silence.
 */
let stoppedUnasked = false;

/**
 * The ear has listened on this phone before, so its speech model is installed.
 * iOS 26 still reports "downloading" on every start (the model is asked for
 * each time, NameEarModule.swift Analyzer26.prepare), and every restart logged
 * "fetching its speech model (first use)" (device_logs, 2026-09-23).
 */
const MODEL_READY_KEY = "ovoa.earModelReady";
let modelReady = false;

/** The echo-cancel line last logged (logEcho), so it is written once and again only when it changes. */
let echoLogged = "";

/**
 * Whether this phone takes its own speaker out of the microphone, the native
 * fix for OVOA answering its own voice ("Give me a second. just fine", messages
 * 2026-09-23). Apple offers it only on some 2024 and later iPhones, and whether
 * iOS applies it to a session that is already active is unproven, so this is
 * how a device log shows it: on the first "listening", and again when it
 * changes (a headset turns it off). Builds before 2026-09-23 don't report it.
 */
function logEcho(e: NameEar.NameEarState) {
  if (e.echoCancelAvailable === undefined) return;
  const detail = {
    echoCancelAvailable: e.echoCancelAvailable,
    echoCancelled: e.echoCancelled,
    echoCancelReactivated: e.echoCancelReactivated,
    echoCancelError: e.echoCancelError,
    sessionSampleRate: e.sessionSampleRate,
  };
  const key = JSON.stringify(detail);
  if (key === echoLogged) return;
  echoLogged = key;
  const echo = !e.echoCancelAvailable ? "not on this phone" : e.echoCancelled ? "on" : "off";
  devlog("voice", `the phone's ear: echo cancelling ${echo}, audio session at ${e.sessionSampleRate} Hz`, detail, { collapse: false });
}

/** The native ear's events, listened to once for the life of the app. */
function listenToEar() {
  if (listening || !NameEar.nameEarAvailable) return;
  listening = true;
  storage
    .get(MODEL_READY_KEY)
    .then((v) => (modelReady ||= v === "1"))
    .catch(() => {});
  NameEar.addListener("onLevel", ({ dbfs }) => {
    lastEarLevelAt = Date.now();
    hooks?.level(dbfs);
  });
  // The words are for spotting the name and for handing a request on as text.
  // Never logged, never sent anywhere else.
  NameEar.addListener("onWord", ({ text, isFinal }) => {
    if (source !== "ear") return;
    heard.word(text, isFinal, Date.now());
    hooks?.word(text);
  });
  NameEar.addListener("onName", () => hooks?.name());
  NameEar.addListener("onState", (event) => {
    const { state, reason, cause, engine } = event;
    if (state === "error") devlog("err", "the phone's ear reported a problem", reason);
    else if (state === "downloading") {
      if (modelReady) devlog("voice", "the phone's ear asked iOS for its speech model again (installed before)", undefined, { level: "debug" });
      else devlog("voice", "the phone is fetching its speech model (first use)");
    } else if (state === "listening") {
      lastEarLevelAt = Date.now();
      stoppedUnasked = false;
      if (!modelReady) {
        modelReady = true;
        storage.set(MODEL_READY_KEY, "1").catch(() => {});
      }
      if (engine) devlog("voice", `the phone's ear is listening (${engine === "analyzer" ? "iOS 26 transcriber" : "on-device recogniser"})`);
      logEcho(event);
    } else if (state === "stopped" && cause) {
      // With a cause it stopped on its own; without one it's a stop() asked for here.
      if (!holders.size) return;
      stoppedUnasked = true;
      devlog("voice", `the phone's ear stopped on its own (${cause})`, reason);
    }
  });
}

/** The phone's own ear is running and delivering audio. */
export function earAlive() {
  return NameEar.isRunning() && Date.now() - lastEarLevelAt < EAR_ALIVE_MS;
}

/** True when this build can hear speech at all: the ear, or Apple's recogniser. Neither in Expo Go or on the web, where talking is typing. */
export const canListen = NameEar.nameEarAvailable || onDeviceSpeechBuilt;

/** True when this build has the phone's ear (the module is linked in). */
export const canHearName = NameEar.nameEarAvailable;

// ---------- Whether this phone can recognise on its own ----------

export type PhoneEar = { checked: boolean; available: boolean; reason?: string };
let known: PhoneEar | null = null;

/** Whether the ear can run on this phone at all (on-device recognition). Asked once. */
export async function phoneEar(): Promise<PhoneEar> {
  if (known) return known;
  try {
    const can = await NameEar.availability();
    known = { checked: true, available: can.available, reason: can.reason };
  } catch (err) {
    known = { checked: true, available: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return known;
}

/** The same, for a screen: Settings hides Always listen where it can't run. */
export function usePhoneEar(): PhoneEar {
  const [ear, setEar] = useState<PhoneEar>(known ?? { checked: false, available: false });
  useEffect(() => {
    let live = true;
    phoneEar().then((e) => live && setEar(e));
    return () => {
      live = false;
    };
  }, []);
  return ear;
}

// ---------- Why an ear stopped ----------

/**
 * iOS took the microphone away with the app off screen, or won't open one
 * there. Nothing is wrong with listening; the caller waits for the app.
 */
function offScreenError() {
  return Object.assign(new Error("The microphone stopped while the app was off screen"), { offScreen: true });
}
export function wasOffScreen(err: unknown) {
  return err instanceof Error && (err as { offScreen?: boolean }).offScreen === true;
}

/** The phone's ear can't run here (no on-device recognition, permission refused). */
function nameEarError(message: string) {
  return Object.assign(new Error(message), { nameEar: true });
}
export function wasNameEarFailure(err: unknown) {
  return err instanceof Error && (err as { nameEar?: boolean }).nameEar === true;
}

// ---------- Who is using the ear ----------
//
// Talk, dictation, setup and the click standby all use the one native ear. It
// starts with the first of them and stops with the last, so one finishing
// can't stop it under another (a late stop() used to be able to kill the next
// owner's ear).

const holders = new Set<string>();
/** What NameEarModule.swift says when it won't start on this phone at all, rather than not this moment. */
const EAR_REFUSED = /isn't allowed|can't recognise speech on its own|no speech recognition for|only recognise speech through/i;
/**
 * Every start and stop of the native ear, one after another. The Swift side
 * only says it's running once a start has finished (after its authorisation
 * and model hops), so a second start in that window would build a second ear
 * and orphan the first, microphone and all; and a stop has to land after the
 * start it follows, not before.
 */
let earOp: Promise<unknown> = Promise.resolve();
function queueEar<T>(op: () => Promise<T>): Promise<T> {
  const next = earOp.then(op);
  earOp = next.catch(() => {});
  return next;
}
/** A restart in flight: watchEar waits for it rather than asking for another. */
let restarting: Promise<void> | null = null;

/**
 * Someone is using the phone's ear, or it is running: the audio session has to
 * stay play-and-record. Switching it to playback under a running ear is what
 * iOS refused with '!pri' (OSStatus 561017449), leaving the ear deaf (voice.ts
 * applyAudioMode, device_logs 2026-09-23).
 */
export function earHeld() {
  return holders.size > 0 || NameEar.isRunning();
}

/** Called once the ear has stopped and nobody holds it: voice.ts puts the audio session back then. */
let earReleased: (() => void) | null = null;

/**
 * What to do once the last holder has let go and the ear has stopped. A
 * callback rather than an import, because voice.ts imports this file.
 */
export function onEarReleased(fn: () => void) {
  earReleased = fn;
}

/** '!pri': another audio session outranks ours right now (see PRIORITY_BACKOFF_MS). */
function wasOutranked(err: unknown) {
  return /561017449|!pri/i.test(err instanceof Error ? err.message : String(err));
}

/** Keeps the phone's ear running for `holder`, starting it if it isn't. Starting only works in the foreground. */
export async function holdEar(holder: string, name: string) {
  listenToEar();
  holders.add(holder);
  try {
    await queueEar(async () => {
      if (NameEar.isRunning()) {
        // Running already (the standby, off screen perhaps): it carries on, with this name.
        await NameEar.start({ name });
        return;
      }
      if (!onScreen()) throw offScreenError();
      const can = await NameEar.availability();
      if (!can.available) throw nameEarError(can.reason ?? "This iPhone can't recognise speech on its own.");
      try {
        await NameEar.start({ name });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        // Off screen, it waits for the app; refused for good (no permission, no
        // on-device recognition), the ear is given up for the session; anything
        // else (the microphone busy for a moment) is tried again, backing off.
        throw /off screen/i.test(why) || !onScreen() ? offScreenError() : EAR_REFUSED.test(why) ? nameEarError(why) : new Error(why);
      }
      heard.reset();
    });
    source = "ear";
    lastEarLevelAt = Date.now();
  } catch (err) {
    releaseEar(holder);
    throw err;
  }
}

/** `holder` is done with the ear. The last one out stops it, after any start or restart still on its way. */
export function releaseEar(holder: string) {
  if (!holders.delete(holder) || holders.size) return;
  if (source === "ear") source = null;
  queueEar(async () => {
    await NameEar.stop();
    // Only now, with the ear stopped, may the audio session change (see earHeld).
    if (!holders.size) earReleased?.();
  }).catch(() => {});
}

/**
 * The ear went silent or stopped on screen: start it again. One restart at a
 * time, for everyone. The light way where the build has it (NameEar.restartEngine:
 * a new engine and tap, the recogniser and its model kept), else stop and start,
 * which builds everything again. What was being said when it stopped is kept
 * (no heard.reset()): the restarted recogniser's first words start a new stretch
 * in earWords.ts, which hands the old one on first.
 */
function restartEar(name: string) {
  restarting ??= queueEar(async () => {
    // Everyone let go while this waited: it stays stopped.
    if (!holders.size) return;
    const started = () => {
      lastEarLevelAt = Date.now();
      // Only once it's back: a restart that failed leaves the next one due at the backoff.
      stoppedUnasked = false;
    };
    if (typeof NameEar.restartEngine === "function") {
      try {
        await NameEar.restartEngine();
        return started();
      } catch (err) {
        // Outranked, a full start would be refused the same way: that is for the backoff.
        if (wasOutranked(err)) throw err;
        devlog("voice", "the phone's ear couldn't restart lightly; starting it afresh", err instanceof Error ? err.message : String(err));
      }
    }
    await NameEar.stop();
    if (!holders.size) return;
    await NameEar.start({ name });
    started();
  }).finally(() => {
    restarting = null;
  });
  return restarting;
}

// ---------- Listening for a conversation ----------

export type EarEvents = {
  onLevel: (level: number) => void;
  /** Words still being recognised (they may change). */
  onInterim: (text: string) => void;
  /**
   * Words that won't change any more. `sentenceEnd`: the speaker paused after them.
   * `lastWordAt`: when they were last heard changing, a pause before this is called (earWords.ts).
   */
  onFinal: (text: string, sentenceEnd: boolean, lastWordAt: number) => void;
  /** Listening stopped and couldn't be brought back (off screen too long, restarts failing). */
  onDown: (err: Error) => void;
  /** Room mode: the window opened, and the ear's words go to the gate: the name, the button, a follow-up. */
  onWake?: (reason: WakeReason) => void;
  /** Room mode: the window ran out; back to listening for the name alone. */
  onSleep?: () => void;
};

export type Ear = {
  close: () => void;
  /** Something asked for attention: open the window (room mode) or keep it open longer. */
  wake: (reason: WakeReason) => void;
  /** Whether the words are going to the gate right now. */
  awake: () => boolean;
  /** Which recogniser is listening. */
  source: "ear" | "apple";
};

let opened = 0;

/**
 * Starts hearing for one conversation and keeps it up until `close`. `room`:
 * only what follows the name (or a click, or a reply) reaches the gate, and
 * only the phone's ear can do that. Otherwise every word does, from `since`
 * (when the person asked; words from just before it count too). `useEar`
 * false: the ear refused earlier, so Apple's recogniser hears this turn.
 * Resolves once listening; throws if it can't.
 */
export async function openEar(
  events: EarEvents,
  { room = false, name, since = Date.now(), useEar = true }: { room?: boolean; name: string; since?: number; useEar?: boolean },
): Promise<Ear> {
  const kind: Ear["source"] = useEar && NameEar.nameEarAvailable ? "ear" : "apple";
  // Listening for the name never goes to Apple's servers (decision 1).
  if (room && kind !== "ear") throw nameEarError("This iPhone can't listen for its name on its own.");
  const id = `conversation-${++opened}`;
  const window = new WakeWindow();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Restarts in a row that achieved nothing. Resets the moment one works. */
  let restartFailures = 0;
  /** Restarts in a row refused with '!pri'. Resets the moment one works. */
  let outranked = 0;
  let lastRestartAt = 0;
  /** When the ear went silent with the app off screen. 0 while it's on screen. */
  let offScreenAt = 0;
  /** Mentions of the name in the stretch so far, so a growing transcript wakes once per mention. */
  let namesHeard = 0;
  let lastWordsLength = 0;
  let apple: { stop: () => void } | null = null;
  let appleStartedAt = 0;
  let appleFailures = 0;
  /** Apple's recogniser stops when the app goes to the background (it has no heartbeat to watch). */
  let leaving: { remove: () => void } | null = null;

  const down = (err: Error) => {
    if (closed) return;
    teardown();
    events.onDown(err);
  };

  const wake = (reason: WakeReason) => {
    if (closed || !room) return;
    const now = Date.now();
    if (!window.wake(reason, now)) return;
    if (reason === "name") heard.openAtName(name, now);
    else if (reason === "summon") heard.open(now, now - EARLY_MS);
    else heard.open(now);
    events.onWake?.(reason);
  };

  const sleep = () => {
    heard.close();
    devlog("voice", "back to listening for the name on the phone");
    events.onSleep?.();
  };

  /** How long after the last restart the next may go. */
  const restartGap = () => {
    if (outranked) return PRIORITY_BACKOFF_MS[Math.min(outranked, PRIORITY_BACKOFF_MS.length) - 1];
    if (restartFailures) return RESTART_BACKOFF_MS[restartFailures - 1] ?? 30_000;
    // Stopped and said so: at once, bar a beat so an ear that keeps stopping can't spin.
    return stoppedUnasked ? PRIORITY_BACKOFF_MS[0] : MIN_RESTART_GAP_MS;
  };

  /**
   * The ear's heartbeat is its loudness report, and it says when iOS stops it.
   * Silent or stopped off screen is iOS; on screen, it's started again.
   */
  const watchEar = (now: number) => {
    const quiet = stoppedUnasked || now - lastEarLevelAt > EAR_ALIVE_MS;
    if (quiet && !onScreen()) {
      if (!offScreenAt) {
        offScreenAt = now;
        devlog("voice", "the phone's ear went quiet with the app off screen; waiting for it to come forward");
      } else if (now - offScreenAt > OFF_SCREEN_GIVE_UP_MS) {
        devlog("voice", `the app stayed off screen for ${Math.round((now - offScreenAt) / 1000)} s; closing the ear until it's back`);
        down(offScreenError());
      }
      return;
    }
    if (offScreenAt) {
      devlog("voice", `the app is back after ${Math.round((now - offScreenAt) / 1000)} s off screen`);
      offScreenAt = 0;
      // Refusals collected on the way out say nothing about the microphone on the way in.
      restartFailures = 0;
      outranked = 0;
      lastRestartAt = 0;
    }
    if (restarting || !quiet || now - lastRestartAt <= restartGap()) return;
    lastRestartAt = now;
    devlogRepeat(
      "ear restart attempt",
      "voice",
      stoppedUnasked ? "the phone's ear stopped; starting it again" : `no sound from the phone's ear for ${now - lastEarLevelAt} ms; starting it again`,
    );
    restartEar(name)
      .then(() => {
        restartFailures = 0;
        outranked = 0;
        devlogSettled("ear restart");
      })
      .catch((err) => {
        // The app left the screen mid-restart: iOS was never going to allow it.
        if (!onScreen() || closed) return;
        if (wasOutranked(err)) {
          outranked++;
          devlogRepeat("ear restart", "voice", `another audio session outranks the phone's ear; trying again in ${restartGap()} ms`, audioWhy(err));
          return;
        }
        restartFailures++;
        const where = audioWhy(err, { attempt: `${restartFailures}/${MAX_RESTARTS}` });
        if (restartFailures >= MAX_RESTARTS) {
          devlog("err", "the phone's ear wouldn't start again; giving up on it for now", where);
          down(new Error("The microphone wouldn't restart"));
        } else {
          devlogRepeat("ear restart", "err", "the phone's ear wouldn't start again", where);
        }
      });
  };

  /** Apple's recogniser, started (again). It ends itself now and then; while the turn is open it comes back. */
  const startApple = async () => {
    heard.reset();
    source = "apple";
    appleStartedAt = Date.now();
    apple = await listenLive({
      onWord: (text, isFinal) => {
        if (!closed && source === "apple") heard.word(text, isFinal, Date.now());
      },
      onLevel: (dbfs) => {
        if (!closed) events.onLevel(dbfs);
      },
      onEnd: (error) => {
        apple = null;
        if (closed) return;
        // Whatever was forming is as final as it will get.
        heard.word("", true, Date.now());
        if (!onScreen()) return down(offScreenError());
        appleFailures = Date.now() - appleStartedAt < APPLE_QUICK_END_MS ? appleFailures + 1 : 0;
        if (appleFailures >= MAX_RESTARTS) return down(new Error(error ?? "Apple's recogniser keeps stopping"));
        if (error) devlogRepeat("apple recogniser end", "warn", "Apple's recogniser stopped; starting it again", error);
        setTimeout(() => {
          if (closed) return;
          startApple().catch((err) => down(err instanceof Error ? err : new Error(String(err))));
        }, APPLE_RESTART_MS);
      },
    });
    if (closed) {
      apple.stop();
      apple = null;
    }
  };

  function teardown() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    detach();
    if (hooks === mine) hooks = null;
    events.onLevel(-160);
    leaving?.remove();
    leaving = null;
    apple?.stop();
    apple = null;
    if (kind === "apple" && source === "apple") source = null;
    if (kind === "ear") releaseEar(id);
    // The number worth reading afterwards: how often the name opened it. No words, ever.
    devlog("voice", `stopped listening on the phone${room ? ` · ${window.opens} waking${window.opens === 1 ? "" : "s"}` : ""}`);
  }

  const detach = heard.attach({ onInterim: events.onInterim, onFinal: events.onFinal });
  const mine = {
    // The phone's own wider match on the stretch so far (the same rule as the
    // server's). The transcript grows as the person talks, so only one more
    // mention than before counts; a shorter one is a new stretch and starts over.
    word: (text: string) => {
      if (!room || closed) return;
      if (text.length < lastWordsLength) namesHeard = 0;
      lastWordsLength = text.length;
      const count = nameCount(text, name);
      if (count > namesHeard) wake("name");
      namesHeard = count;
    },
    name: () => {
      if (room && !closed) wake("name");
    },
    level: (dbfs: number) => {
      if (!closed) events.onLevel(dbfs);
    },
  };

  try {
    if (kind === "ear") {
      hooks = mine;
      await holdEar(id, name);
    } else {
      if (!onScreen()) throw offScreenError();
      if (!onDeviceSpeechBuilt) throw new Error("This build can't hear speech on the phone.");
      // It may be using Apple's servers, for something the person started on
      // screen: it doesn't go on hearing once they've left the app. Only
      // "background": "inactive" is also a permission sheet or a pulled-down
      // notification with the app still in front.
      leaving = AppState.addEventListener("change", (state) => {
        if (state === "background") down(offScreenError());
      });
      await startApple();
    }
    if (closed) throw new Error("Listening was closed while it started");
    if (!room) heard.open(Date.now(), since - EARLY_MS);
  } catch (err) {
    teardown();
    throw err;
  }

  timer = setInterval(() => {
    const now = Date.now();
    heard.tick(now);
    if (room && heard.isOpen && !window.awake(now)) sleep();
    if (kind === "ear") watchEar(now);
  }, TICK_MS);

  return { close: teardown, wake, awake: () => !room || window.awake(Date.now()), source: kind };
}
