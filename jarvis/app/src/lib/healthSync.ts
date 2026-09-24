import { Pedometer } from "expo-sensors";
import { AppState } from "react-native";
import { api, serverOut } from "./api";
import { consentMissing } from "./consent";
import { devlog, devlogRepeat, devlogSettled, logFail } from "./devlog";
import {
  healthAsked,
  healthAvailable,
  healthDays,
  healthLocked,
  heartSince,
  heartWriteAccess,
  lockedHealthError,
  needsHealthPrompt,
  observeHealth,
  saveBandHeartRate,
} from "./health";
import { changedDays, dayKey, daysBack, readsVerdict, syncReport, type HealthReads } from "./healthMath";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// Apple Health, kept in step with OVOA's server (api/src/healthdays.ts, heart.ts).
//
// Two directions. The Band's heart-rate readings are saved to Health as they
// arrive (saveBandReading), so they sit with the rest of the person's health
// data. And what Health has — a watch's heart rate, sleep, workouts, the day's
// numbers — goes up to the server, where the Activity screen and the assistant
// read it. The assistant has to answer with the phone locked, and HealthKit
// refuses every read then (Code=6, device_logs 2026-09-21 23:31:51).
//
// A sync starts on launch, when the app comes forward, when Health says
// something changed (in the background too), and from heart rate's minute
// timer (lib/heart.ts). Every one passes the same gate: not already running,
// Health asked for, the phone unlocked, and 15 minutes since the last — the
// Band's own saves set off Health's observer every five minutes. Nothing here
// asks for permission: the sheet belongs on screen, where Activity shows it.
// Background heart sync used to call requestAuthorization (lib/heart.ts before
// 2026-09-23).

const EVERY_MS = 15 * 60_000;
/** Days read on an account's first sync: what the server keeps (docs/retention.md). After that, yesterday and today. */
const FIRST_DAYS = 14;
/** Heart readings per POST /hr (the server takes up to 2000). */
const HEART_CHUNK = 1000;
/**
 * Band readings waiting for Health, at most a day's worth at the five-minute
 * rate. In memory: a list this long is far past what the keychain
 * (lib/storage.ts) should hold, and Apple keeps writes made while the phone is
 * locked and saves them at unlock, so little ever waits.
 */
const MAX_WAITING = 300;
/** Saves one reading gets before it's dropped. A locked phone doesn't use one up. */
const MAX_TRIES = 3;

/** Where the last heart-rate read from Health got to (an HKQueryAnchor, a few hundred bytes). */
const ANCHOR_KEY = "ovoa.hkHeartAnchor";
/** Fingerprints of the days last sent, and whether they went to /health/days (AI consent) or only /steps. */
const SENT_KEY = "ovoa.hkDaysSent";

export type HealthStatus = {
  reads: HealthReads;
  /** The last try found the iPhone locked. */
  locked: boolean;
  /** The Health sheet has something new to ask. */
  needsPrompt: boolean;
  /** Whether the Band's heart rate may be saved to Health. */
  writeHeart: "on" | "off" | "not_asked";
  /** What wrote heart rate, sleep and steps to Health over the days last synced, OVOA left out. */
  heartSources: string[];
  sleepSources: string[];
  stepSources: string[];
  lastSyncAt: number | null;
  /** Minutes asleep last night, when something recorded sleep. */
  lastNightSleepMin: number | null;
};

const EMPTY: HealthStatus = {
  reads: "unknown",
  locked: false,
  needsPrompt: false,
  writeHeart: "not_asked",
  heartSources: [],
  sleepSources: [],
  stepSources: [],
  lastSyncAt: null,
  lastNightSleepMin: null,
};

let status = EMPTY;
const listeners = new Set<() => void>();

/** What the last sync found. */
export const healthStatus = () => status;

/** Called whenever healthStatus() changes. Returns an unsubscribe function. */
export function onHealthStatus(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function setStatus(patch: Partial<HealthStatus>) {
  const next = { ...status, ...patch };
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  for (const listener of listeners) listener();
}

let running: Promise<void> | null = null;
let lastRunAt = 0;
/** Bumped when a session starts or ends: a sync still running for the last one mustn't save its anchor under the next. */
let session = 0;
/** Health has been asked for on this phone. Only ever turns true, so it's asked of iOS until then. */
let asked = false;
/** The server keeps no day numbers for this account (no AI consent): not sent again this launch. */
let noConsent = false;
/** Why the last sync didn't run, so a locked night is one line in the log rather than one a minute. */
let lastSkip: "not_asked" | "locked" | null = null;
/** The facts the last sync line stated (healthMath.ts syncReport), or null: none yet this launch. */
let lastReport: string | null = null;
const NOTHING_SINCE = { syncs: 0, daysChanged: 0, heartFromHealth: 0, bandSaved: 0 };
/** What happened since the last sync line: the next one's detail. */
let sinceLine = { ...NOTHING_SINCE };

let waiting: { ts: number; bpm: number; tries: number }[] = [];
let saving = false;

// The anchor and fingerprints are this account's progress: the next account
// reads its own fourteen days. Waiting readings were the last person's wrist.
onSignOut("health sync", async () => {
  session++;
  waiting = [];
  noConsent = false;
  lastRunAt = 0;
  lastSkip = null;
  lastReport = null;
  sinceLine = { ...NOTHING_SINCE };
  // Quietly: a listener told now would report to the server with the session that's ending.
  status = EMPTY;
  await storage.remove(ANCHOR_KEY);
  await storage.remove(SENT_KEY);
});

/** Saves a Band reading to Apple Health. lib/heart.ts calls this as each one arrives. */
export function saveBandReading(reading: { ts: number; bpm: number }) {
  if (!healthAvailable) return;
  waiting = [...waiting, { ...reading, tries: 0 }].slice(-MAX_WAITING);
  void saveWaiting();
}

/**
 * Saves the waiting readings, oldest first, and stops at the first that
 * doesn't go: the rest are tried with the next reading, when the app comes
 * forward, and at each sync. Readings wait while the Health sheet hasn't been
 * answered, so they land once it has; saving turned off drops them.
 */
async function saveWaiting() {
  if (saving) return;
  saving = true;
  try {
    while (waiting.length) {
      const access = heartWriteAccess();
      if (access === "off") {
        waiting = [];
        return;
      }
      if (access === "not_asked") return;
      const next = waiting[0];
      try {
        if (!(await saveBandHeartRate(next))) throw new Error("Health didn't keep it");
        waiting = waiting.filter((w) => w !== next);
        sinceLine.bandSaved++;
        devlogSettled("health-band-save");
      } catch (err) {
        if (!(await healthLocked().catch(() => false))) next.tries++;
        const why = err instanceof Error ? err.message : String(err);
        devlogRepeat("health-band-save", "warn", "heart rate: couldn't save a Band reading to Health", why);
        if (next.tries >= MAX_TRIES) waiting = waiting.filter((w) => w !== next);
        return;
      }
    }
  } finally {
    saving = false;
  }
}

/**
 * Syncs Apple Health with the server, once 15 minutes have passed since the
 * last (`force`: now, for Activity). While one is running, callers get that one.
 */
export function syncHealth(token: string, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!healthAvailable) return Promise.resolve();
  if (running) return running;
  if (!force && Date.now() - lastRunAt < EVERY_MS) return Promise.resolve();
  running = run(token, session).finally(() => (running = null));
  return running;
}

/**
 * Writes why a sync didn't run, once until the reason changes or a sync goes
 * through. A locked line says when the last sync was, since a sync that finds
 * nothing new writes no line of its own.
 */
function skip(reason: "not_asked" | "locked") {
  if (lastSkip === reason) return;
  lastSkip = reason;
  if (reason === "not_asked") {
    return devlog("log", "health sync: off: Health hasn't been asked for on this phone yet (Activity asks)");
  }
  const last = status.lastSyncAt;
  const ago = last === null ? "nothing synced yet" : `last synced ${Math.round((Date.now() - last) / 60_000)} min ago`;
  devlog("log", `health sync: waiting: the iPhone is locked, and Health can't be read until it's unlocked (${ago})`);
}

/** What the last sync sent, or null (none yet, or unreadable: the next sync starts over). */
async function lastSent(): Promise<{ ai: boolean; days: Record<string, string> } | null> {
  try {
    return JSON.parse((await storage.get(SENT_KEY)) ?? "null");
  } catch {
    return null;
  }
}

/** Steps on the iPhone's own counter today, or null when it can't be asked without a prompt. */
async function phoneStepsToday() {
  try {
    if (!(await Pedometer.getPermissionsAsync()).granted) return null;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return (await Pedometer.getStepCountAsync(midnight, new Date())).steps;
  } catch {
    return null;
  }
}

async function run(token: string, mine: number) {
  const started = Date.now();
  asked = asked || (await healthAsked());
  if (!asked) {
    lastRunAt = Date.now();
    setStatus({ reads: "not_asked" });
    return skip("not_asked");
  }
  if (await healthLocked().catch(() => false)) {
    setStatus({ locked: true });
    return skip("locked");
  }
  try {
    await saveWaiting();

    // The day numbers and workouts first, so the server's workout finder
    // already knows a watch's workout when its heart rate lands.
    const sent = await lastSent();
    const ai = !consentMissing() && !noConsent;
    const first = !sent || sent.ai !== ai;
    const range = daysBack(first ? FIRST_DAYS : 2);
    const from = range[0];
    const to = range[range.length - 1];
    const read = await healthDays(from, to);
    const stepsOn = new Map(read.steps.map((s) => [s.day, s.steps]));
    const { changed, next } = changedDays(
      read.days.map((d) => ({
        ...d,
        steps: stepsOn.get(d.day),
        workouts: read.workouts.filter((w) => dayKey(new Date(w.start)) === d.day),
      })),
      first || !sent ? {} : sent.days,
      daysBack(FIRST_DAYS)[0],
    );
    let kept = ai;
    const changedOn = new Set(changed.map((d) => d.day));
    // Today goes up on every sync, changed or not: the server takes its newest
    // updated_at as when the phone last read Health (healthdays.ts STALE_MS).
    // Sending only changed days made a quiet evening look 7 h old, and the
    // answer said to unlock the iPhone instead of the real reason (review,
    // 2026-09-23). One small PUT per sync: every 15 minutes at most, and when
    // Activity is opened.
    if (ai) {
      const res = await api.putHealthDays(token, {
        from,
        to,
        days: read.days.filter((d) => changedOn.has(d.day) || d.day === to),
        workouts: read.workouts,
      });
      if (res.skipped === "no_ai_consent") noConsent = true;
      kept = !noConsent;
    }
    if (changed.length) {
      const steps = read.steps.filter((s) => changedOn.has(s.day));
      if (steps.length) await api.syncSteps(token, steps);
      if (mine === session) {
        await storage.set(SENT_KEY, JSON.stringify({ ai: kept, days: next })).catch(logFail("health sync: storage.set"));
      }
    }

    // Heart rate from anything but OVOA, from where the last read got to. The
    // anchor is kept only once every reading is on the server.
    const heart = await heartSince(await storage.get(ANCHOR_KEY).catch(() => null));
    for (let i = 0; i < heart.readings.length; i += HEART_CHUNK) {
      await api.sendHeartRate(token, "health", heart.readings.slice(i, i + HEART_CHUNK));
    }
    if (mine === session && heart.anchor) {
      await storage.set(ANCHOR_KEY, heart.anchor).catch(logFail("health sync: storage.set"));
    }

    const phoneSteps = await phoneStepsToday();
    const reads = readsVerdict(read.sources.any.length + heart.sources.length, phoneSteps);
    const heartSources = [...new Set([...read.sources.heart, ...heart.sources])];
    const needsPrompt = await needsHealthPrompt();
    const writeHeart = heartWriteAccess();
    lastRunAt = Date.now();
    if (mine !== session) return;
    lastSkip = null;
    setStatus({
      reads,
      locked: false,
      needsPrompt,
      writeHeart,
      heartSources,
      sleepSources: read.sources.sleep,
      stepSources: read.sources.steps,
      lastSyncAt: Date.now(),
      lastNightSleepMin: read.days[read.days.length - 1]?.sleep?.asleepMin || null,
    });

    // The line device_logs is read by, when what it says has changed (syncReport).
    sinceLine.syncs++;
    sinceLine.daysChanged += changed.length;
    sinceLine.heartFromHealth += heart.readings.length;
    const report = syncReport({
      reads,
      phoneStepsToday: phoneSteps,
      sources: { ...read.sources, heart: heartSources },
      writeHeart,
      needsPrompt,
      stepsOnly: !kept,
    });
    if (report.key === lastReport) return;
    lastReport = report.key;
    devlog(
      "log",
      `health sync: ${report.text}`,
      JSON.stringify({
        since: sinceLine,
        ms: Date.now() - started,
        range: `${from}..${to}`,
        first,
        hkStepsToday: stepsOn.get(to) ?? null,
        phoneStepsToday: phoneSteps,
        sources: read.sources.any,
        workouts: read.workouts.length,
        waitingForHealth: waiting.length,
      }),
      { level: report.problem ? "warn" : "info", collapse: false },
    );
    sinceLine = { ...NOTHING_SINCE };
  } catch (err) {
    if (lockedHealthError(err)) {
      setStatus({ locked: true });
      return skip("locked");
    }
    lastRunAt = Date.now();
    // Down for maintenance or offline: api.ts has said so once already.
    if (!serverOut()) devlog("warn", "health sync failed", err instanceof Error ? err.message : String(err));
  }
}

/** While signed in: syncs now, and whenever Health or the app says to. Returns a stop function. */
export function startHealthSync(token: string) {
  const mine = ++session;
  void syncHealth(token);
  let offObserver = () => {};
  observeHealth(() => void syncHealth(token))
    .then((off) => (mine === session ? (offObserver = off) : off()))
    .catch(logFail("health sync: observeHealth"));
  const app = AppState.addEventListener("change", (s) => {
    if (s !== "active") return;
    void saveWaiting();
    void syncHealth(token);
  });
  return () => {
    session++;
    offObserver();
    app.remove();
  };
}
