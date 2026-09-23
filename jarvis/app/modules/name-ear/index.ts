import { requireOptionalNativeModule } from "expo";
import type { EventSubscription } from "expo-modules-core";

// The phone's own ear: Apple's on-device speech recognition over a microphone
// the native side owns. See ios/src/NameEarModule.swift for what it does and
// why. This file is the JavaScript side: typed calls, and null-safe when the
// native module isn't in the build (Expo Go, the web, Android), so everything
// degrades to typing rather than crashing.
//
// Since 2026-09-23 the ear is how the app hears speech at all (lib/liveListen.ts):
// its words are the turn's words, and nothing but words ever comes out of it.
// The native side can still hand audio over (setSending / onAudio, for the old
// Deepgram stream); this file doesn't expose that, so nothing in the app can
// ask for it. Several parts of the app use the one ear; liveListen.ts decides
// when it starts and stops (holdEar / releaseEar), so one owner stopping it
// can't pull it out from under another.

/** Which recogniser the phone is using. */
export type NameEarEngine = "analyzer" | "sfspeech" | "none";

/** What start() and restartEngine() resolve with, and what each "listening" carries. */
export type NameEarDescription = {
  engine: NameEarEngine;
  onDevice: boolean;
  /** The rate of the audio the native side converts to: always 16 kHz. */
  sampleRate: number;
  preRollSeconds: number;
  /** The engine is running (the same as isRunning()). */
  running: boolean;
  /** The rate iOS actually runs the audio session at. 16 kHz is asked for; iOS decides. */
  sessionSampleRate: number;
  /** This phone can cancel its own speaker out of the microphone (iOS 18.2+, some 2024 and later iPhones). */
  echoCancelAvailable: boolean;
  /** It is doing so now. A headset or Bluetooth route turns it off, and iOS may decline it. */
  echoCancelled: boolean;
  /**
   * This ear turned the audio session off and on once so iOS would apply echo
   * cancellation (start's mayReactivate). Worth logging beside echoCancelled:
   * whether that did it is unproven (2026-09-23).
   */
  echoCancelReactivated: boolean;
  /** iOS threw when echo cancellation was asked for, rather than taking the preference and declining it. */
  echoCancelError?: string;
};

/**
 * The ear's state. "stopped" with a `cause` and a `reason` is the ear stopping
 * on its own (an interruption began, iOS restarted its audio system, the
 * microphone changed and couldn't be picked up again): restartEngine() brings
 * it back. "stopped" with neither is a stop() the app asked for, or a start
 * that failed. "error" is the ear failing to come back by itself when an
 * interruption ended; it stays stopped. "listening" carries the description,
 * and `after` when it is back from something.
 */
export type NameEarState = Partial<NameEarDescription> & {
  state: "preparing" | "downloading" | "listening" | "error" | "stopped";
  reason?: string;
  cause?: "interruption" | "reset" | "route";
  after?: "interruption" | "route" | "restart";
};

export type NameEarEvents = {
  /** The name was heard. `at` is a millisecond timestamp. */
  onName: (event: { at: number }) => void;
  /** What the recogniser has heard of the current stretch so far. Never logged. */
  onWord: (event: { text: string; isFinal: boolean }) => void;
  /** preparing → downloading (first use, the model) → listening; stopped / error. See NameEarState. */
  onState: (event: NameEarState) => void;
  /** Loudness in dBFS, about five times a second, for the orb's halo. */
  onLevel: (event: { dbfs: number }) => void;
};

type NameEarNativeModule = {
  availability(): Promise<{ available: boolean; engine: NameEarEngine; reason?: string }>;
  start(options: { name: string; preRollSeconds?: number; echoCancel?: boolean; mayReactivate?: boolean }): Promise<NameEarDescription>;
  stop(): Promise<void>;
  /** Missing from native builds before 2026-09-23. */
  restartEngine?: () => Promise<NameEarDescription>;
  isRunning(): boolean;
  addListener<K extends keyof NameEarEvents>(event: K, listener: NameEarEvents[K]): EventSubscription;
};

// requireOptional rather than require: in Expo Go and on the web this is null instead of a throw.
const NameEar = requireOptionalNativeModule<NameEarNativeModule>("NameEar");

/** True when the module is in this build (an iOS development or TestFlight build). */
export const nameEarAvailable = NameEar !== null;

function native(): NameEarNativeModule {
  if (!NameEar) throw new Error("Hearing speech on the phone needs the installed OVOA app, not Expo Go.");
  return NameEar;
}

/** Whether this phone can recognise speech on its own, and how. False with a reason when it can't. */
export async function availability() {
  if (!NameEar) return { available: false, engine: "none" as const, reason: "This build can't recognise speech on the phone." };
  return native().availability();
}

/**
 * Starts the microphone and the on-device recogniser. Only from the foreground:
 * iOS refuses otherwise. Already running, it keeps running (with this name) and
 * resolves at once. Stopped on its own (an interruption, a lost microphone), it
 * comes back the light way, as restartEngine() does, recogniser and transcript
 * kept; while iOS still refuses ('!pri' during a call) it rejects and the ear
 * stays, to come back by itself when the interruption ends. Builds before
 * 2026-09-23 built a new ear instead. No audio is kept: `preRollSeconds` is
 * always 0, because the words are all anything uses now. `echoCancel` (on
 * unless false) asks iOS to take the phone's own speaker out of the microphone
 * where the phone can. `mayReactivate` says nothing in the app is playing right
 * now, so a new ear may turn the audio session off and on once per launch to
 * have that applied: off, it never does, because turning the session off stops
 * every player (a reply, a cue, the alarm's keep-awake loop).
 */
export const start = (options: { name: string; echoCancel?: boolean; mayReactivate?: boolean }) =>
  native().start({ name: options.name, preRollSeconds: 0, echoCancel: options.echoCancel, mayReactivate: options.mayReactivate });
export const stop = () => (NameEar ? native().stop() : Promise.resolve());
/** True only while the microphone's engine runs: false through an interruption, a lost microphone or a restart. */
export const isRunning = () => (NameEar ? native().isRunning() : false);

/**
 * Brings a stopped or silent ear back without rebuilding it: a new engine and
 * tap and the session reactivated, but the recogniser kept (no model check, no
 * new transcriber), where stop() and start() do all of it again. Rejects when
 * the ear isn't started or iOS still refuses; the message names '!pri' and its
 * number (561017449) when another audio session outranks OVOA's, after the
 * native side has already tried again at 200, 400 and 800 ms. Undefined where
 * the native side lacks it (Expo Go, the web, an older build), so callers check
 * `typeof restartEngine === "function"` and otherwise stop() and start().
 */
export const restartEngine =
  NameEar && typeof NameEar.restartEngine === "function" ? (): Promise<NameEarDescription> => native().restartEngine!() : undefined;

export function addListener<K extends keyof NameEarEvents>(event: K, listener: NameEarEvents[K]): EventSubscription {
  return native().addListener(event, listener);
}
