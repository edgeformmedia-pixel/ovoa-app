import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import { Pedometer } from "expo-sensors";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { api } from "./api";
import { savedToken } from "./auth";
import { onPush } from "./background";
import * as clip from "./clip";
import { devlog } from "./devlog";
import { holdAwake, renderSpeech } from "./voice";

// Things that don't stop until they're answered (server: api/src/alarms.ts).
//
//   An alarm buzzes the band every 30 s and says "Morning Thomas, wake up" until
//   "I'm awake". A hard alarm keeps talking, with barely a pause, until the phone
//   has counted 20 steps; nothing else stops it.
//
//   An urgent reminder (pills) buzzes every 30 s until "I took it", the Done
//   button, or the app.
//
// The band only takes one short command at a time, so the buzz is the motor test
// (option 3) once, every 30 s and never faster. For an alarm to go off at all,
// the app has to still be running at 7am: while one is armed for the next 14
// hours it plays near-silent audio in the background, which iOS allows to run all
// night (the "audio" background mode). The server's pushes every two minutes are
// the backstop for when that fails.

const BUZZ_EVERY_MS = 30_000;
const HARD_STEPS = 20;
/** Gap between one "wake up" and the next: a normal alarm, and a hard one. */
const SAY_EVERY_MS = 30_000;
const HARD_SAY_GAP_MS = 1_500;
/** An alarm this far off doesn't keep the phone awake yet. */
const ARM_AHEAD_MS = 14 * 3_600_000;
/** Local notifications as a last resort when the app isn't running: one a minute for this many minutes. */
const FALLBACK_MINUTES = 10;

export type Nag = {
  key: string;
  kind: "alarm" | "urgent";
  label: string;
  hard: boolean;
  alarmId?: string;
  name?: string;
  startedAt: number;
  steps: number;
};

let nags: Nag[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function useNags() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => nags,
  );
}

// ---------- The loop ----------

let buzzTimer: ReturnType<typeof setInterval> | null = null;
let talking = false;
let stepSub: { remove: () => void } | null = null;
let phrase: { text: string; file: File | null } | null = null;

export function startNag(n: Omit<Nag, "startedAt" | "steps">) {
  if (nags.some((x) => x.key === n.key)) return;
  nags = [...nags, { ...n, startedAt: Date.now(), steps: 0 }];
  devlog("agent", `${n.kind === "alarm" ? (n.hard ? "hard alarm" : "alarm") : "urgent reminder"} going off`, n.label);
  emit();
  void holdAwake(true);
  if (!buzzTimer) {
    void buzzOnce();
    buzzTimer = setInterval(() => void buzzOnce(), BUZZ_EVERY_MS);
  }
  if (n.kind === "alarm") {
    void talk();
    if (n.hard) countSteps();
  }
}

export function stopNag(key: string, why = "stopped") {
  const had = nags.find((n) => n.key === key);
  if (!had) return;
  nags = nags.filter((n) => n.key !== key);
  devlog("agent", `${had.label}: ${why}`);
  emit();
  void cancelFallbacks(key);
  if (!nags.length) {
    if (buzzTimer) clearInterval(buzzTimer);
    buzzTimer = null;
    void holdAwake(false);
  }
  if (!nags.some((n) => n.hard)) {
    stepSub?.remove();
    stepSub = null;
  }
}

async function buzzOnce() {
  if (!nags.length || !clip.isLinked()) return;
  if (Date.now() - clip.lastBuzzAt() < BUZZ_EVERY_MS - 2_000) return;
  await clip.buzz(1, 3);
}

/** Says the wake-up line over and over while an alarm is going off. */
async function talk() {
  if (talking) return;
  talking = true;
  try {
    while (nags.some((n) => n.kind === "alarm")) {
      const alarm = nags.find((n) => n.kind === "alarm")!;
      const text = `Morning${alarm.name ? ` ${alarm.name}` : ""}, wake up. ${alarm.hard ? "Wake up." : ""}`.trim();
      await sayLine(text);
      if (!nags.some((n) => n.kind === "alarm")) break;
      await new Promise((r) => setTimeout(r, alarm.hard ? HARD_SAY_GAP_MS : SAY_EVERY_MS));
    }
  } finally {
    talking = false;
  }
}

/** Plays the line from a file voiced once (and kept), so it can repeat with no network. */
async function sayLine(text: string) {
  try {
    if (phrase?.text !== text || !phrase.file?.exists) {
      const token = await savedToken();
      const made = token ? await renderSpeech(token, text).catch(() => null) : null;
      phrase = { text, file: made };
    }
    if (!phrase.file) {
      devlog("err", "wake-up line: no audio (no network when it was voiced?)");
      return;
    }
    devlog("agent", "saying the wake-up line", text);
    const copy = new File(Paths.cache, `ovoa-wake-${Date.now()}.mp3`);
    phrase.file.copy(copy);
    await new Promise<void>((resolve) => {
      const player = createAudioPlayer(copy.uri);
      const done = () => {
        sub.remove();
        player.remove();
        try {
          copy.delete();
        } catch {}
        resolve();
      };
      const sub = player.addListener("playbackStatusUpdate", (s) => {
        if (s.didJustFinish) done();
      });
      player.volume = 1;
      player.play();
      setTimeout(done, 15_000);
    });
  } catch (err) {
    devlog("err", "couldn't say the wake-up line", String(err));
  }
}

/** A hard alarm counts steps from when it went off; twenty and it's over. */
function countSteps() {
  if (stepSub) return;
  try {
    stepSub = Pedometer.watchStepCount(({ steps }) => {
      nags = nags.map((n) => (n.hard ? { ...n, steps } : n));
      emit();
      const hard = nags.find((n) => n.hard);
      if (hard && steps >= HARD_STEPS) {
        stopNag(hard.key, `${steps} steps: awake`);
        void (async () => {
          const token = await savedToken();
          if (token && hard.alarmId) await api.stopAlarm(token, hard.alarmId, steps).catch(() => {});
        })();
      }
    });
  } catch (err) {
    devlog("err", "can't count steps for the hard alarm", String(err));
  }
}

/** The "I'm awake" / "Done" buttons. A hard alarm has none. */
export async function answerNag(n: Nag) {
  const token = await savedToken();
  if (!token) return;
  if (n.kind === "alarm") {
    if (n.hard || !n.alarmId) return;
    await api.stopAlarm(token, n.alarmId, 0).catch(() => {});
    // Awake is awake: every ordinary alarm going off here stops too (the server does the same).
    for (const other of nags.filter((x) => x.kind === "alarm" && !x.hard)) stopNag(other.key, "answered");
    return;
  }
  await api.nagDone(token, n.key).catch(() => {});
  stopNag(n.key, "answered");
}

// ---------- Arming: keeping the phone awake for tonight's alarm ----------

let armed: { id: string; at: number; hard: boolean; label: string | null }[] = [];
let fireTimers: ReturnType<typeof setTimeout>[] = [];
let quiet: AudioPlayer | null = null;
let holdingForArm = false;
let userName = "";

/** One second of silence, written once: what keeps the app running overnight. */
function silenceFile() {
  const dir = new Directory(Paths.document, "sounds");
  const file = new File(dir, "silence.wav");
  if (file.exists) return file;
  if (!dir.exists) dir.create({ intermediates: true });
  const rate = 8000;
  const bytes = new Uint8Array(44 + rate * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + rate * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, rate * 2, true);
  file.write(bytes);
  return file;
}

async function setQuietAudio(on: boolean) {
  if (on && !quiet) {
    if (!holdingForArm) {
      holdingForArm = true;
      await holdAwake(true);
    }
    try {
      quiet = createAudioPlayer(silenceFile().uri);
      quiet.loop = true;
      quiet.volume = 0.01;
      quiet.play();
      devlog("agent", "keeping the app awake for tonight's alarm");
    } catch (err) {
      devlog("err", "couldn't keep the app awake for the alarm", String(err));
    }
  } else if (!on && quiet) {
    quiet.pause();
    quiet.remove();
    quiet = null;
    if (holdingForArm) {
      holdingForArm = false;
      await holdAwake(false);
    }
  }
}

async function scheduleFallbacks(a: { id: string; at: number; hard: boolean; label: string | null }) {
  for (let i = 0; i < FALLBACK_MINUTES; i++) {
    await Notifications.scheduleNotificationAsync({
      identifier: `alarm:${a.id}:${i}`,
      content: {
        title: a.hard ? "Wake up — 20 steps to stop" : "Wake up",
        body: `Morning${userName ? ` ${userName}` : ""}. ${a.label ?? ""}`.trim(),
        sound: "default",
        interruptionLevel: "timeSensitive",
        data: { type: "alarm-local", alarmId: a.id },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(a.at + i * 60_000) },
    }).catch(() => {});
  }
}

async function cancelFallbacks(key: string) {
  if (!key.startsWith("alarm:")) return;
  const id = key.slice(6);
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  await Promise.all(
    scheduled.filter((n) => n.identifier.startsWith(`alarm:${id}:`)).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {})),
  );
}

/** Reads the alarms, keeps the phone awake if one is coming, and sets it to go off on time here. */
export async function syncAlarms(token: string) {
  try {
    const [{ alarms }, me] = await Promise.all([api.alarms(token), api.me(token).catch(() => null)]);
    userName = (me?.user.name ?? "").split(" ")[0];
    fireTimers.forEach(clearTimeout);
    fireTimers = [];
    const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
    await Promise.all(
      scheduled.filter((n) => n.identifier.startsWith("alarm:")).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {})),
    );
    armed = alarms
      .filter((a) => a.nextAt && a.nextAt > Date.now() && a.nextAt - Date.now() < ARM_AHEAD_MS)
      .map((a) => ({ id: a.id, at: a.nextAt!, hard: a.hard, label: a.label }));
    devlog("agent", armed.length ? `alarms armed: ${armed.map((a) => new Date(a.at).toLocaleTimeString()).join(", ")}` : "no alarm in the next 14 h");
    // Stopped on the server ("I'm awake" said to OVOA): stop here too.
    for (const a of alarms.filter((a) => a.stopped)) stopNag(`alarm:${a.id}`, "stopped");
    // One that's ringing on the server but not here (the phone was asleep): go off now.
    for (const a of alarms.filter((a) => a.ringing)) {
      startNag({ key: `alarm:${a.id}`, kind: "alarm", label: a.label ?? "Alarm", hard: a.hard, alarmId: a.id, name: userName });
    }
    for (const a of armed) {
      await scheduleFallbacks(a);
      fireTimers.push(
        setTimeout(() => {
          startNag({ key: `alarm:${a.id}`, kind: "alarm", label: a.label ?? "Alarm", hard: a.hard, alarmId: a.id, name: userName });
        }, a.at - Date.now()),
      );
    }
    await setQuietAudio(armed.length > 0);
    // Voice the wake-up line now, while there's network, so 7am doesn't depend on it.
    if (armed.length && userName) {
      const text = `Morning ${userName}, wake up.`;
      if (phrase?.text !== text) phrase = { text, file: await renderSpeech(token, text).catch(() => null) };
    }
  } catch (err) {
    devlog("err", "couldn't sync alarms", String(err));
  }
}

/**
 * Keeps the phone's copy of the alarms current. Silent pushes can't be relied on
 * to say an alarm was set (build 54: the 11:13 one never reached the phone, so it
 * wasn't kept awake and slept through it). So it also re-reads them when the app
 * heads to the background — the last moment it can start the keep-awake audio —
 * and every five minutes while it's open. After a voice turn that set one, the
 * assistant calls syncAlarms itself (assistant.tsx).
 */
export function startAlarmSync(token: string) {
  void syncAlarms(token);
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active" || s === "inactive" || s === "background") void syncAlarms(token);
  });
  const every = setInterval(() => {
    if (AppState.currentState === "active") void syncAlarms(token);
  }, 5 * 60_000);
  return () => {
    app.remove();
    clearInterval(every);
  };
}

// ---------- Pushes ----------

onPush("alarm", (p) => {
  const alarmId = typeof p.alarmId === "string" ? p.alarmId : undefined;
  startNag({
    key: typeof p.key === "string" ? p.key : `alarm:${alarmId}`,
    kind: "alarm",
    label: typeof p.label === "string" && p.label ? p.label : "Alarm",
    hard: !!p.hard,
    alarmId,
    name: typeof p.name === "string" ? p.name : userName,
  });
});

onPush("nag", (p) => {
  if (typeof p.key !== "string") return;
  startNag({ key: p.key, kind: "urgent", label: typeof p.label === "string" ? p.label : "Reminder", hard: false });
});

onPush("nag-stop", (p) => {
  if (typeof p.key === "string") stopNag(p.key);
});

onPush("alarms-changed", async () => {
  const token = await savedToken();
  if (token) await syncAlarms(token);
});
