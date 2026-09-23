import { useEffect, useState } from "react";
import * as NameEar from "../../modules/name-ear";
import { devlog, devlogRepeat, devlogSettled } from "./devlog";
import { EarWords } from "./earWords";
import { audioWhy, onScreen } from "./foreground";
import { listenLive, onDeviceSpeechBuilt } from "./onDeviceTranscribe";
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

/** The native ear's events, listened to once for the life of the app. */
function listenToEar() {
  if (listening || !NameEar.nameEarAvailable) return;
  listening = true;
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
  NameEar.addListener("onState", ({ state, reason, engine }) => {
    if (state === "error") devlog("err", "the phone's ear reported a problem", reason);
    else if (state === "downloading") devlog("voice", "the phone is fetching its speech model (first use)");
    else if (state === "listening") {
      lastEarLevelAt = Date.now();
      if (engine) devlog("voice", `the phone's ear is listening (${engine === "analyzer" ? "iOS 26 transcriber" : "on-device recogniser"})`);
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
/** A stop on its way to the native side: a start waits for it rather than finding a dying ear. */
let stopping: Promise<unknown> = Promise.resolve();
let restarting: Promise<void> | null = null;

/** Keeps the phone's ear running for `holder`, starting it if it isn't. Starting only works in the foreground. */
export async function holdEar(holder: string, name: string) {
  listenToEar();
  await stopping;
  holders.add(holder);
  try {
    if (NameEar.isRunning()) {
      // Running already (the standby, off screen perhaps): it carries on, with this name.
      await NameEar.start({ name });
    } else {
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
    }
    source = "ear";
    lastEarLevelAt = Date.now();
  } catch (err) {
    releaseEar(holder);
    throw err;
  }
}

/** `holder` is done with the ear. The last one out stops it. */
export function releaseEar(holder: string) {
  if (!holders.delete(holder) || holders.size) return;
  if (source === "ear") source = null;
  stopping = NameEar.stop().catch(() => {});
}

/** The ear went silent on screen: stop it and start it again. One restart at a time, for everyone. */
function restartEar(name: string) {
  restarting ??= NameEar.stop()
    .then(() => NameEar.start({ name }))
    .then(() => {
      lastEarLevelAt = Date.now();
      heard.reset();
    })
    .finally(() => {
      restarting = null;
    });
  return restarting;
}

// ---------- Listening for a conversation ----------

export type EarEvents = {
  onLevel: (level: number) => void;
  /** Words still being recognised (they may change). */
  onInterim: (text: string) => void;
  /** Words that won't change any more. `sentenceEnd`: the speaker paused after them. */
  onFinal: (text: string, sentenceEnd: boolean) => void;
  /** Nobody has said a new word for a moment. */
  onQuiet: () => void;
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
  let lastRestartAt = 0;
  /** When the ear went silent with the app off screen. 0 while it's on screen. */
  let offScreenAt = 0;
  /** Mentions of the name in the stretch so far, so a growing transcript wakes once per mention. */
  let namesHeard = 0;
  let lastWordsLength = 0;
  let apple: { stop: () => void } | null = null;
  let appleStartedAt = 0;
  let appleFailures = 0;

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

  /** The ear's heartbeat is its loudness report. Silent off screen is iOS; silent on screen, it's started again. */
  const watchEar = (now: number) => {
    const quiet = now - lastEarLevelAt > EAR_ALIVE_MS;
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
      lastRestartAt = 0;
    }
    const gap = restartFailures ? (RESTART_BACKOFF_MS[restartFailures - 1] ?? 30_000) : MIN_RESTART_GAP_MS;
    if (restarting || !quiet || now - lastRestartAt <= gap) return;
    lastRestartAt = now;
    devlogRepeat("ear restart attempt", "voice", `no sound from the phone's ear for ${now - lastEarLevelAt} ms; starting it again`);
    restartEar(name)
      .then(() => {
        restartFailures = 0;
        devlogSettled("ear restart");
      })
      .catch((err) => {
        // The app left the screen mid-restart: iOS was never going to allow it.
        if (!onScreen() || closed) return;
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
    apple?.stop();
    apple = null;
    if (kind === "apple" && source === "apple") source = null;
    if (kind === "ear") releaseEar(id);
    // The number worth reading afterwards: how often the name opened it. No words, ever.
    devlog("voice", `stopped listening on the phone${room ? ` · ${window.opens} waking${window.opens === 1 ? "" : "s"}` : ""}`);
  }

  const detach = heard.attach({ onInterim: events.onInterim, onFinal: events.onFinal, onQuiet: events.onQuiet });
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
