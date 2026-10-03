import { AppState } from "react-native";
import * as ute from "../../modules/ute-ble";
import { api, type SleepNight } from "./api";
import * as clip from "./clip";
import { consentMissing } from "./consent";
import { devlog, logFail } from "./devlog";
import { dayKey } from "./healthMath";
import { saveBandReading } from "./healthSync";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// OVOA Fit measuring by itself (health plan, 2026-10-02; server: api/src/healthdays.ts).
//
// Until now the phone asked the band for a reading every five minutes
// (lib/heart.ts), which only happens while iOS keeps the app running: a locked
// phone left gaps, and sleep was never measured at all. Now, each time the band
// links, it's told to measure on its own (heart rate every five minutes, blood
// oxygen every hour, sleep stages overnight) and keep what it measured. The
// phone copies that history off whenever it can: on link, when the app comes
// forward, when the band says it has new data, and every half hour from heart
// rate's timer. Heart rate goes to /hr like any band reading (and to Apple
// Health); blood oxygen and sleep go to /band/days, a row a day.
//
// Firmware that refuses both heart-rate settings keeps the old polling:
// selfMeasuring() is false and heart.ts goes on asking.

const SETTINGS: ute.HealthConfig = { hrMode: "auto", hrIntervalMin: 5, spo2IntervalMin: 60, sleep: true };
/** Where the last copy reached, seconds. */
const CURSOR_KEY = "bandHealth.syncedTo";
/** How far back a band never copied before is read: what the server keeps. */
const FIRST_SEC = 3 * 86_400;
/** Read again from a little before the cursor: the band may still have been filling the last frame. */
const OVERLAP_SEC = 3_600;
/** Sleep is read over the last day and a half, so last night is always whole. */
const SLEEP_SEC = 36 * 3_600;
const EVERY_MS = 30 * 60_000;
const HEART_CHUNK = 1000;

let measuring = false;
let configuredFor: string | null = null;
let syncing = false;
let lastSync = 0;

/** The band is measuring heart rate by itself, so the phone needn't poll it. */
export const selfMeasuring = () => measuring;

onSignOut("band health cursor", async () => {
  measuring = false;
  configuredFor = null;
  await storage.remove(CURSOR_KEY);
});

/** Tells the linked band what to measure, once per link. */
async function configure() {
  const device = await ute.connectedDevice().catch(() => null);
  const id = device?.id ?? device?.address ?? "band";
  if (configuredFor === id) return;
  try {
    const codes = await ute.configureHealth(SETTINGS);
    configuredFor = id;
    measuring = codes.autoHr === 0 || codes.continuousHr === 0;
    devlog("ble", "band health: configured", codes);
  } catch (err) {
    measuring = false;
    devlog("warn", "band health: couldn't configure", String(err));
  }
}

const STAGE: Record<number, keyof NonNullable<SleepNight["stages"]>> = { 1: "deep", 2: "core", 3: "awake", 4: "rem", 5: "core", 6: "core" };
/** A gap this long between stretches of sleep starts a new night (or a nap). */
const NIGHT_GAP_SEC = 90 * 60;

/**
 * The band's sleep stretches as nights, one per local day: the longest night
 * that ended that day. Start and end markers (types 7, 8) carry no time.
 */
export function sleepNights(segments: ute.SleepSegment[]): { day: string; night: SleepNight }[] {
  const parts = segments.filter((s) => STAGE[s.type] && s.minutes > 0 && s.start > 0).sort((a, b) => a.start - b.start);
  const groups: ute.SleepSegment[][] = [];
  for (const s of parts) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && s.start - (prev.start + prev.minutes * 60) < NIGHT_GAP_SEC) last.push(s);
    else groups.push([s]);
  }
  const byDay = new Map<string, SleepNight>();
  for (const g of groups) {
    const stages: NonNullable<SleepNight["stages"]> = {};
    for (const s of g) stages[STAGE[s.type]] = (stages[STAGE[s.type]] ?? 0) + s.minutes;
    const start = g[0].start * 1000;
    const end = Math.max(...g.map((s) => (s.start + s.minutes * 60) * 1000));
    const asleepMin = g.filter((s) => s.type !== 3).reduce((n, s) => n + s.minutes, 0);
    if (asleepMin < 30) continue;
    const night: SleepNight = { asleepMin, inBedMin: Math.round((end - start) / 60_000), start, end, stages, source: "OVOA Fit" };
    const day = dayKey(new Date(end));
    if ((byDay.get(day)?.asleepMin ?? 0) < asleepMin) byDay.set(day, night);
  }
  return [...byDay].map(([day, night]) => ({ day, night }));
}

/** Blood oxygen by local day: the average and the lowest reading. */
export function spo2Days(samples: ute.BandSample[]) {
  const byDay = new Map<string, number[]>();
  for (const s of samples) {
    if (s.spo2 < 70 || s.spo2 > 100) continue;
    const day = dayKey(new Date(s.ts * 1000));
    byDay.set(day, [...(byDay.get(day) ?? []), s.spo2]);
  }
  return [...byDay].map(([day, v]) => ({ day, spo2Pct: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10, spo2Low: Math.min(...v) }));
}

/** Copies what the band stored since the last copy. Skipped while the band is busy or a copy is running. */
export async function syncBand(token: string, why: string) {
  if (syncing || !clip.isLinked() || !clip.clipIdle()) return;
  syncing = true;
  lastSync = Date.now();
  try {
    await configure();
    const now = Math.floor(Date.now() / 1000);
    const cursor = Number(await storage.get(CURSOR_KEY).catch(() => null)) || 0;
    const from = cursor ? Math.max(cursor - OVERLAP_SEC, now - FIRST_SEC) : now - FIRST_SEC;

    const { samples, frames } = await ute.readHealthHistory(from, now);
    const heart = samples.filter((s) => s.hr >= 30 && s.hr <= 230).map((s) => ({ ts: s.ts * 1000, bpm: s.hr }));
    for (let i = 0; i < heart.length; i += HEART_CHUNK) await api.sendHeartRate(token, "band", heart.slice(i, i + HEART_CHUNK));
    // Apple Health takes the newest; heart.ts saves live readings the same way.
    for (const r of heart.filter((r) => r.ts > cursor * 1000)) saveBandReading(r);

    const sleep = await ute.readSleep(Math.min(from, now - SLEEP_SEC), now).catch((err) => {
      devlog("warn", "band health: couldn't read sleep", String(err));
      return { segments: [] as ute.SleepSegment[], summary: "" };
    });
    const days = new Map<string, { day: string; spo2Pct?: number; spo2Low?: number; sleep?: SleepNight }>();
    for (const d of spo2Days(samples)) days.set(d.day, d);
    for (const { day, night } of sleepNights(sleep.segments)) days.set(day, { ...(days.get(day) ?? { day }), sleep: night });
    if (days.size && !consentMissing()) await api.putBandDays(token, [...days.values()].slice(-31));

    await storage.set(CURSOR_KEY, String(now));
    devlog("ble", `band health: copied (${why})`, {
      frames,
      minutes: samples.length,
      heart: heart.length,
      days: [...days.keys()],
      sleepSegments: sleep.segments.length,
      sleepSummary: sleep.summary.slice(0, 400),
    });
  } catch (err) {
    devlog("warn", `band health: copy failed (${why})`, String(err));
  } finally {
    syncing = false;
  }
}

/** While signed in. Returns a stop function. */
export function startBandHealth(token: string) {
  const sync = (why: string) => void syncBand(token, why).catch(logFail("band health: sync"));
  const offLink = clip.onLinkChange((linked) => {
    if (!linked) {
      configuredFor = null;
      measuring = false;
      return;
    }
    // A moment for the link's own handshake before anything else is asked.
    setTimeout(() => sync("linked"), 8_000);
  });
  const offReady = clip.onHealthReady((type) => sync(`band has data ${type}`));
  const timer = setInterval(() => {
    if (Date.now() - lastSync >= EVERY_MS) sync("timer");
  }, 60_000);
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active" && Date.now() - lastSync > 5 * 60_000) sync("app opened");
  });
  if (clip.isLinked()) sync("start");
  return () => {
    offLink();
    offReady();
    clearInterval(timer);
    app.remove();
  };
}
