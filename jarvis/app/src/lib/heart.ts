import { AppState } from "react-native";
import * as ute from "../../modules/ute-ble";
import { api } from "./api";
import * as clip from "./clip";
import { devlog, logFail } from "./devlog";
import { saveBandReading, startHealthSync, syncHealth } from "./healthSync";
import { onSignOut } from "./signOut";

// Heart rate, all day (server: api/src/heart.ts).
//
// The ES100 has a heart-rate sensor after all (build 51's probe, 2026-09-21: a
// one-off "measure" answers in about a second; resting 61-67, 79 running in
// place). So while the clip is linked the phone asks it for a reading every
// five minutes, every minute once heart rate is up (a workout is probably
// happening), and never while the clip is busy recording or sending a
// recording — one short command at a time is what keeps it from freezing.
//
// Each reading is also saved to Apple Health as it arrives (healthSync.ts), so
// the Band's heart rate sits with the rest of the person's health data; before
// 2026-09-23 it only ever reached OVOA's server. What a watch writes to Health
// goes up to the server from there too. Either source is enough; the server
// merges them and finds the workouts in whatever arrives.

const EVERY_MS = 5 * 60_000;
/** Once heart rate is up, readings come this often, so a workout has a shape. */
const WORKOUT_EVERY_MS = 60_000;
/** Readings this far above resting switch to the faster rate. */
const RAISED_BY = 25;
/** Readings sent together, or sooner if this long has passed. */
const BATCH = 5;
const BATCH_MS = 10 * 60_000;
/** A buzz this recent means the clip is busy: wait. */
const AFTER_BUZZ_MS = 15_000;

let resting = 65;
/** The Live screen is streaming heart rate: don't ask the band as well, and keep one reading a minute. */
let live = false;
let lastLiveKept = 0;
export const setLiveHeart = (on: boolean) => void (live = on);
let lastReading = 0;
let asking = false;
let batch: { ts: number; bpm: number }[] = [];
let lastSent = Date.now();
/** "Measure now" was pressed: send its reading straight away, so the server (and the assistant) have it. */
let sendNext = false;

// Readings not sent yet were measured on the last person's wrist. Kept, a failed
// flush at sign-out (the session already gone) sent them in under the next account.
onSignOut("heart rate queue", () => {
  batch = [];
});

async function flushBand(token: string, force = false) {
  if (!batch.length || (!force && batch.length < BATCH && Date.now() - lastSent < BATCH_MS)) return;
  const sending = batch;
  batch = [];
  try {
    await api.sendHeartRate(token, "band", sending);
    lastSent = Date.now();
  } catch (err) {
    batch = [...sending, ...batch].slice(-200);
    devlog("warn", "heart rate: couldn't send readings", String(err));
  }
}

/** Asks the band for a reading. False when it's busy (or streaming for the Live screen) or didn't answer. */
async function askBand() {
  if (live || asking || !clip.clipIdle() || Date.now() - clip.lastBuzzAt() < AFTER_BUZZ_MS) return false;
  asking = true;
  try {
    // The reading itself comes back as an input event (onHeartRate below).
    await ute.setHeartRate("measure", true);
    return true;
  } catch (err) {
    devlog("warn", "heart rate: the clip didn't answer", String(err));
    return false;
  } finally {
    asking = false;
  }
}

/**
 * A reading now, for Activity's "Measure now": the same guards as the timer's
 * (never while the clip is busy), without waiting for its turn. False when the
 * band can't be asked; the reading itself arrives through clip.onHeartRate.
 */
export async function measureNow() {
  sendNext = true;
  const asked = await askBand();
  if (!asked) sendNext = false;
  return asked;
}

/** Readings taken but not sent yet, oldest first, so a screen can show them before the server has them. */
export const pendingBand = () => [...batch];

/** While signed in. Returns a stop function. */
export function startHeartRate(token: string) {
  api
    .heartToday(token)
    .then((r) => (resting = r.baseline || resting))
    .catch(logFail("heart: heartToday"));

  const offReading = clip.onHeartRate((bpm) => {
    if (bpm < 30 || bpm > 230) return;
    if (live) {
      if (Date.now() - lastLiveKept < 60_000) return;
      lastLiveKept = Date.now();
    }
    lastReading = bpm;
    const reading = { ts: Date.now(), bpm };
    batch.push(reading);
    saveBandReading(reading);
    void flushBand(token, sendNext || bpm >= resting + RAISED_BY);
    sendNext = false;
  });

  // One timer at the fast rate, which skips its turn when the slow rate is due.
  // It also offers Apple Health a sync, which goes ahead every 15 minutes.
  let lastAsked = 0;
  const timer = setInterval(() => {
    void syncHealth(token);
    const raised = lastReading >= resting + RAISED_BY;
    if (Date.now() - lastAsked < (raised ? WORKOUT_EVERY_MS : EVERY_MS) - 5_000) return;
    lastAsked = Date.now();
    void askBand();
    void flushBand(token);
  }, WORKOUT_EVERY_MS);

  const stopHealth = startHealthSync(token);
  const app = AppState.addEventListener("change", (s) => {
    if (s === "background") void flushBand(token, true);
  });

  return () => {
    offReading();
    clearInterval(timer);
    stopHealth();
    app.remove();
    void flushBand(token, true);
  };
}
