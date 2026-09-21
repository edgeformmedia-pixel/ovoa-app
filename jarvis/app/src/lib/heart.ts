import { AppState } from "react-native";
import * as ute from "../../modules/ute-ble";
import { api } from "./api";
import * as clip from "./clip";
import { devlog } from "./devlog";
import { healthAvailable, healthPermission, heartRateSince, watchHeartRate } from "./health";
import { storage } from "./storage";

// Heart rate, all day (server: api/src/heart.ts).
//
// The ES100 has a heart-rate sensor after all (build 51's probe, 2026-09-21: a
// one-off "measure" answers in about a second; resting 61-67, 79 running in
// place). So while the clip is linked the phone asks it for a reading every
// five minutes, every minute once heart rate is up (a workout is probably
// happening), and never while the clip is busy recording or sending a
// recording — one short command at a time is what keeps it from freezing.
//
// Anything a watch writes to Apple Health goes up too. Either source is
// enough; the server finds the workouts in whatever arrives.

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
const HEALTH_LAST_KEY = "ovoa.hrHealthLast";

let resting = 65;
let lastReading = 0;
let asking = false;
let batch: { ts: number; bpm: number }[] = [];
let lastSent = Date.now();

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

async function askBand() {
  if (asking || !clip.clipIdle() || Date.now() - clip.lastBuzzAt() < AFTER_BUZZ_MS) return;
  asking = true;
  try {
    // The reading itself comes back as an input event (onHeartRate below).
    await ute.setHeartRate("measure", true);
  } catch (err) {
    devlog("warn", "heart rate: the clip didn't answer", String(err));
  } finally {
    asking = false;
  }
}

/** Sends what Health has that the server hasn't seen. */
export async function sendHealthHeartRate(token: string) {
  if (!healthAvailable || (await healthPermission()) !== "ok") return;
  const last = Number(await storage.get(HEALTH_LAST_KEY).catch(() => null)) || Date.now() - 24 * 3_600_000;
  const samples = await heartRateSince(new Date(last + 1)).catch(() => []);
  if (!samples.length) return;
  for (let i = 0; i < samples.length; i += 1000) await api.sendHeartRate(token, "health", samples.slice(i, i + 1000));
  await storage.set(HEALTH_LAST_KEY, String(samples[samples.length - 1].ts)).catch(() => {});
  devlog("log", `heart rate: sent ${samples.length} readings from Health`);
}

/** While signed in. Returns a stop function. */
export function startHeartRate(token: string) {
  api
    .heartToday(token)
    .then((r) => (resting = r.baseline || resting))
    .catch(() => {});

  const offReading = clip.onHeartRate((bpm) => {
    if (bpm < 30 || bpm > 230) return;
    lastReading = bpm;
    batch.push({ ts: Date.now(), bpm });
    void flushBand(token, bpm >= resting + RAISED_BY);
  });

  // One timer at the fast rate, which skips its turn when the slow rate is due.
  let lastAsked = 0;
  const timer = setInterval(() => {
    const raised = lastReading >= resting + RAISED_BY;
    if (Date.now() - lastAsked < (raised ? WORKOUT_EVERY_MS : EVERY_MS) - 5_000) return;
    lastAsked = Date.now();
    void askBand();
    void flushBand(token);
  }, WORKOUT_EVERY_MS);

  void sendHealthHeartRate(token);
  let offHealth: () => void = () => {};
  watchHeartRate(() => void sendHealthHeartRate(token))
    .then((off) => (offHealth = off))
    .catch(() => {});
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active") void sendHealthHeartRate(token);
    if (s === "background") void flushBand(token, true);
  });

  return () => {
    offReading();
    clearInterval(timer);
    offHealth();
    app.remove();
    void flushBand(token, true);
  };
}
