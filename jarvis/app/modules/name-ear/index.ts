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

export type NameEarEvents = {
  /** The name was heard. `at` is a millisecond timestamp. */
  onName: (event: { at: number }) => void;
  /** What the recogniser has heard of the current stretch so far. Never logged. */
  onWord: (event: { text: string; isFinal: boolean }) => void;
  /** preparing → downloading (first use, the model) → listening; interrupted / error / stopped. */
  onState: (event: { state: "preparing" | "downloading" | "listening" | "interrupted" | "error" | "stopped"; engine?: string; reason?: string; after?: string }) => void;
  /** Loudness in dBFS, about five times a second, for the orb's halo. */
  onLevel: (event: { dbfs: number }) => void;
};

type NameEarNativeModule = {
  availability(): Promise<{ available: boolean; engine: NameEarEngine; reason?: string }>;
  start(options: { name: string; preRollSeconds?: number }): Promise<{ engine: NameEarEngine; onDevice: boolean; sampleRate: number; preRollSeconds: number }>;
  stop(): Promise<void>;
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
 * resolves at once. No audio is kept: `preRollSeconds` is always 0, because
 * the words are all anything uses now.
 */
export const start = (options: { name: string }) => native().start({ name: options.name, preRollSeconds: 0 });
export const stop = () => (NameEar ? native().stop() : Promise.resolve());
export const isRunning = () => (NameEar ? native().isRunning() : false);

export function addListener<K extends keyof NameEarEvents>(event: K, listener: NameEarEvents[K]): EventSubscription {
  return native().addListener(event, listener);
}
