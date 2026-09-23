import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { devlog } from "./devlog";
import { storage } from "./storage";

// The moments OVOA marks with a sound and a tap: the "Glass" set, picked in the
// Orb Studio (2026-09-23), rendered by scripts/make-sounds.mjs.
//
// Each cue is a sound and a haptic that belong together — a soft tick when it
// starts listening, a double tap when something worked — so the phone can be
// felt as well as heard. Sounds can be turned off in Settings; the haptic
// stays, because a tap in the hand is never in anyone else's way.
//
// Played with keepAudioSessionActive, the same as OVOA's voice (voice.ts): a
// cue finishing must never be what switches the audio session off under a
// microphone that's still listening.

export type Cue = "wake" | "sent" | "reply" | "done" | "error" | "remind" | "created" | "approve";

const FILES: Record<Cue, number> = {
  wake: require("../../assets/sounds/glass-wake.wav"),
  sent: require("../../assets/sounds/glass-sent.wav"),
  reply: require("../../assets/sounds/glass-reply.wav"),
  done: require("../../assets/sounds/glass-done.wav"),
  error: require("../../assets/sounds/glass-error.wav"),
  remind: require("../../assets/sounds/glass-remind.wav"),
  created: require("../../assets/sounds/glass-created.wav"),
  approve: require("../../assets/sounds/glass-approve.wav"),
};

const HAPTIC: Record<Cue, () => Promise<void>> = {
  wake: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  sent: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
  reply: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  done: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  remind: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  created: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  approve: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid),
};

// ---------- whether sounds are on ----------

const KEY = "ovoa.sounds";
const listeners = new Set<(on: boolean) => void>();
let soundsOn: boolean | null = null;

export const soundsPref = {
  /** On unless turned off. */
  get: async () => {
    if (soundsOn === null) soundsOn = (await storage.get(KEY).catch(() => null)) !== "0";
    return soundsOn;
  },
  set: async (on: boolean) => {
    soundsOn = on;
    listeners.forEach((l) => l(on));
    await storage.set(KEY, on ? "1" : "0");
  },
};
void soundsPref.get();

export function useSoundsOn() {
  const [on, setOn] = useState(soundsOn ?? true);
  useEffect(() => {
    soundsPref.get().then(setOn);
    listeners.add(setOn);
    return () => void listeners.delete(setOn);
  }, []);
  return on;
}

// ---------- playing ----------

/** One player per cue, made the first time it's needed and kept. */
const players = new Map<Cue, AudioPlayer>();

function player(cue: Cue) {
  let p = players.get(cue);
  if (!p) {
    p = createAudioPlayer(FILES[cue], { keepAudioSessionActive: true });
    p.volume = 0.6;
    players.set(cue, p);
  }
  return p;
}

/** Marks a moment. Never throws, and never waits: a cue is never the reason something is slow. */
export function cue(which: Cue, { sound = true }: { sound?: boolean } = {}) {
  if (Platform.OS !== "web") HAPTIC[which]().catch(() => {});
  if (!sound || soundsOn === false) return;
  try {
    const p = player(which);
    void p.seekTo(0).then(() => p.play()).catch(() => {});
  } catch (err) {
    devlog("warn", `cue ${which} couldn't play`, err instanceof Error ? err.message : String(err));
  }
}
