import { requireOptionalNativeModule } from "expo";
import type { EventSubscription } from "expo-modules-core";

// The phone's own ear: Apple's on-device speech recognition listening for the
// assistant's name, with the microphone owned natively. See ios/src/NameEarModule.swift
// for what it does and why. This file is the JavaScript side: typed calls, and
// null-safe when the native module isn't in the build (Expo Go, the web,
// Android), so everything degrades to the old way rather than crashing.

/** Which recogniser the phone is using. */
export type NameEarEngine = "analyzer" | "sfspeech" | "none";

export type NameEarEvents = {
  /** The name was heard. `at` is a millisecond timestamp. */
  onName: (event: { at: number }) => void;
  /** What the recogniser has heard so far, for the app's own fuzzy match. Never logged. */
  onWord: (event: { text: string; isFinal: boolean }) => void;
  /** Audio, only while sending: 16 kHz 16-bit mono PCM. `preRoll` is the few seconds kept before the request began. */
  onAudio: (event: { data: ArrayBuffer; preRoll: boolean; sampleRate: number }) => void;
  /** preparing → downloading (first use, the model) → listening; interrupted / error / stopped. */
  onState: (event: { state: "preparing" | "downloading" | "listening" | "interrupted" | "error" | "stopped"; engine?: string; reason?: string; after?: string }) => void;
  /** Loudness in dBFS, about five times a second, for the orb's halo. */
  onLevel: (event: { dbfs: number }) => void;
};

type NameEarNativeModule = {
  availability(): Promise<{ available: boolean; engine: NameEarEngine; reason?: string }>;
  start(options: { name: string; preRollSeconds?: number }): Promise<{ engine: NameEarEngine; onDevice: boolean; sampleRate: number; preRollSeconds: number }>;
  stop(): Promise<void>;
  setSending(on: boolean): Promise<void>;
  isRunning(): boolean;
  isSending(): boolean;
  addListener<K extends keyof NameEarEvents>(event: K, listener: NameEarEvents[K]): EventSubscription;
};

// requireOptional rather than require: in Expo Go and on the web this is null instead of a throw.
const NameEar = requireOptionalNativeModule<NameEarNativeModule>("NameEar");

/** True when the module is in this build (an iOS development or TestFlight build). */
export const nameEarAvailable = NameEar !== null;

function native(): NameEarNativeModule {
  if (!NameEar) throw new Error("Hearing the name on the phone needs the installed OVOA app, not Expo Go.");
  return NameEar;
}

/** Whether this phone can recognise speech on its own, and how. False with a reason when it can't. */
export async function availability() {
  if (!NameEar) return { available: false, engine: "none" as const, reason: "This build can't hear the name on the phone." };
  return native().availability();
}

/** Starts the microphone and the on-device recogniser. Only from the foreground: iOS refuses otherwise. */
export const start = (options: { name: string; preRollSeconds?: number }) => native().start(options);
export const stop = () => (NameEar ? native().stop() : Promise.resolve());
/** On: the pre-roll, then live audio, arrives as onAudio events. Off: it stops. */
export const setSending = (on: boolean) => (NameEar ? native().setSending(on) : Promise.resolve());
export const isRunning = () => (NameEar ? native().isRunning() : false);
export const isSending = () => (NameEar ? native().isSending() : false);

export function addListener<K extends keyof NameEarEvents>(event: K, listener: NameEarEvents[K]): EventSubscription {
  return native().addListener(event, listener);
}
