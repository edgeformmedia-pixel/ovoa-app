import * as Application from "expo-application";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { AppState, Platform } from "react-native";
import { API_URL } from "./api";
import {
  breadcrumbs,
  clock,
  devlog,
  formatDevLog,
  LEVEL_ORDER,
  onDevLog,
  recentLog,
  setLogContext,
  sweepLog,
  type LogEntry,
  type LogLevel,
} from "./devlog";
import { storage } from "./storage";

// Sends the dev log to the server (POST /logs → D1 table device_logs), so what
// happens on the phone can be read remotely. Also routes console output,
// uncaught JS errors and unhandled promise rejections into the log.
//
// Two things it has to get right. Battery: the old uploader woke the phone every
// three seconds all day whether or not it had anything to say, so there is no
// interval any more — a line schedules the next send and nothing is running when
// the queue is empty. And crashes: a fatal used to call flush() and return, which
// gave the request no time to finish, so the one line worth having was the one
// that never arrived. The queue is now written to disk synchronously first
// (expo-file-system's File.write is synchronous in SDK 57) and picked up next launch.

/** How soon a new line goes. Long enough for a burst to travel together. */
const FLUSH_MS = 3000;
/** Something that went wrong goes sooner: a crash may be a second away. */
const URGENT_MS = 400;
/** The server's own per-request limit (api/src/logs.ts). */
const MAX_BATCH = 200;
/** 200 rows × a 4000-character detail is an 800 KB body; a phone on one bar never lands it. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_QUEUE = 2000;
/** A trim goes down to here, so the next line isn't over the cap again straight away. */
const TRIM_TO = 1500;
/** Waits after a failure, then two minutes forever. */
const BACKOFF_MS = [3_000, 8_000, 20_000, 45_000, 120_000];
/**
 * The server holds a throttled device off for ten minutes (api/src/logs.ts) and
 * drops what it sends meanwhile. Sending every three seconds anyway was a request
 * a phone could have kept, times every phone; the rows wait here instead.
 */
const THROTTLE_PAUSE_MS = 10 * 60_000;
let throttledUntil = 0;
/** How many rows a crash is allowed to write to disk. A synchronous write during a crash must be small. */
const SPILL_ROWS = 300;
/**
 * In the cache, not Documents: Documents is backed up to iCloud, and a standing
 * copy of the log there is a worse trade than iOS occasionally purging a spill
 * we only need to survive until the next launch.
 */
const SPILL_FILE = "ovoa-log-spill.json";
const DEVICE_KEY = "ovoa.deviceId";

let queue: LogEntry[] = [];
/** Rows recovered from a previous launch. They keep that launch's session id, so they go on their own. */
let carried: { sessionId: string; rows: LogEntry[] } | null = null;
let token: string | null = null;
let deviceId: string | null = null;
let flushing = false;
let started = false;
let failures = 0;
let lastOkAt = 0;
/** Whether the last attempt reached the server at all. Null until something has been tried. */
let online: boolean | null = null;
let droppedTotal = 0;
let trimming = false;
let badShapeLogged = false;
/** True while React Native's own error handler is running, which logs the same error again. */
let inHandler = false;

/**
 * Below this, a line is kept on the phone but not uploaded. A release build
 * uploads warnings and errors, plus the few timing lines below (2026-09-22:
 * every phone was sending its whole info-level narrative, thousands of rows a
 * day each, read by nobody unless something went wrong). What stays on the
 * phone still reaches the server three ways: attached to any error as
 * breadcrumbs, whole with a crash, and whole when Send logs is pressed. A dev
 * build keeps "info", and Dev tools can lower either to "trace" for an hour.
 */
let uploadFrom: LogLevel = __DEV__ ? "info" : "warn";
export const setUploadLevel = (level: LogLevel) => (uploadFrom = level);
export const uploadLevel = () => uploadFrom;

/**
 * Lines a release build uploads whatever their level: one per turn or per
 * listening session, each carrying a number the cost and latency work is
 * measured by. Matched on the start of the text, so a new line has to be
 * added here on purpose to be uploaded; nothing gets in by accident.
 */
const MILESTONES: RegExp[] = [
  /^app started/,
  /^heard its name/,
  /^listening live/,
  // One per conversation: how often the name opened the phone's ear (liveListen.ts).
  /^stopped listening on the phone/,
  // A phone without its own recogniser, using Apple's for a turn (onDeviceTranscribe.ts).
  /^listening with Apple's recogniser/,
  /^speaking \d+ ms after the question/,
  /^BUG REPORT/,
  /^picked up \d+ log lines/,
  // One row per recording turned into words on the phone (onDeviceTranscribe.ts).
  /^on-device transcript after/,
  // Apple Health's read status (healthSync.ts): written when what it says
  // changes and once a launch, plus once per locked or not-asked spell. Without
  // it only the warn lines went up, and device_logs couldn't tell a locked
  // iPhone from no Watch data (2026-09-23). A few rows per phone a day.
  /^health sync: /,
  // The AI-led setup (app/onboarding.tsx): one row per turn (engine, first
  // sentence ms, what it asks next) and one when it ends; ids and numbers only
  // (2026-09-23).
  /^setup: /,
  // Whatever the person said that got no answer, and why: the gate's drops
  // (turnGate.ts, the reason only, never the words), the server's "not for
  // OVOA" (a length only), a reply dropped mid-turn, and listening going off
  // with the reason. Three answers went unanswered on 2026-09-24, and one reply
  // was lost when listening stopped, and none of it was in device_logs.
  /^ignored: /,
  /^not meant for the assistant/,
  /^dropped the reply/,
  /^stopped listening because/,
  // The band's button: each press as the clip reported it, what the app made of
  // it, and whether listening started. "I double click and it doesn't start
  // listening" (2026-09-24) left nothing in device_logs to read. A handful of
  // rows per click, and only when the button is pressed.
  /^clip press/,
  /^clip: (single click|double click|press)/,
  /^click: /,
  /^double click/,
  /^summoned$/,
];
/** perf lines are the turn breakdowns (turnTimer.ts): one row per spoken turn. */
const MILESTONE_KINDS = new Set<LogEntry["kind"]>(["perf"]);

function uploads(entry: LogEntry) {
  if (LEVEL_ORDER[entry.level] >= LEVEL_ORDER[uploadFrom]) return true;
  return MILESTONE_KINDS.has(entry.kind) || MILESTONES.some((re) => re.test(entry.text));
}

/**
 * What was kept on the phone and not uploaded, newest last. Bounded like the
 * on-phone log itself. A crash or Send logs moves it into the queue whole, so
 * the story before the error goes up with the error.
 */
const MAX_SKIPPED = 400;
let skipped: LogEntry[] = [];

/** Moves everything held back into the upload queue, in order. */
function adoptSkipped() {
  if (!skipped.length) return 0;
  const rows = skipped;
  skipped = [];
  queue = [...queue, ...rows].sort((a, b) => a.seq - b.seq);
  if (queue.length > MAX_QUEUE) trim();
  return rows.length;
}

/**
 * Send logs: everything on the phone goes up now, the held-back lines
 * included, behind a marker row that says so. For a tester who was told
 * "press Send logs and tell me when", and for the day something is wrong but
 * nothing has failed loudly enough to upload itself.
 */
export async function sendRecentLogs(why = "sent by hand") {
  const held = adoptSkipped();
  devlog("log", `SEND LOGS: ${why}`, `${held} held-back lines included; build ${build}; phone ${JSON.stringify(context())}`, {
    level: "warn",
    collapse: false,
  });
  await flush();
  if (pending()) await flush();
  return pending()
    ? { ok: false, detail: `Saved on this phone (${pending()} lines waiting). It goes as soon as you're back online.` }
    : { ok: true, detail: `Sent ${held} lines that were only on the phone, and everything since.` };
}

const sessionId = Math.random().toString(36).slice(2, 12);
const build = `${Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "?"} (${
  Application.nativeBuildVersion ?? "?"
}) ${Platform.OS} ${__DEV__ ? "dev" : "release"}`;

/** Tags uploads with the signed-in user (or clears it on sign-out). The token itself is never logged. */
export function setLogToken(value: string | null) {
  token = value;
}

// --- Context ---------------------------------------------------------------

let diskAt = 0;
let diskMB: number | null = null;

/** Free disk, read at most every five minutes: it is a native call and it barely moves. */
function freeDiskMB() {
  const now = Date.now();
  if (now - diskAt > 5 * 60_000) {
    diskAt = now;
    try {
      diskMB = Math.round(Paths.availableDiskSpace / (1024 * 1024));
    } catch {
      diskMB = null;
    }
  }
  return diskMB;
}

/**
 * What was true of the phone while this batch was written. Reachability comes
 * from our own uploads rather than a network module: the question it answers is
 * "why did nothing arrive", and a failed upload is that answer exactly.
 */
function context() {
  return {
    state: AppState.currentState,
    net: online === null ? "?" : online ? "up" : "down",
    sinceOkS: lastOkAt ? Math.round((Date.now() - lastOkAt) / 1000) : null,
    signedIn: !!token,
    diskMB: freeDiskMB(),
    queued: queue.length,
    droppedTotal,
  };
}

/** A line for the Report a problem screen and for the Dev tools readout. */
export const logStatus = () => ({ build, deviceId, sessionId, ...context() });

// --- Uploading -------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let dueAt = 0;

/** Nothing is running when there is nothing to send, and an error can pull the next send forward. */
function schedule(ms: number) {
  const at = Date.now() + ms;
  if (timer && dueAt <= at) return;
  if (timer) clearTimeout(timer);
  dueAt = at;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, ms);
}

const backoff = () => {
  const base = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
  // Jitter, so a hundred phones coming back on the same cell don't retry in step.
  return base + Math.floor(Math.random() * base * 0.25);
};

/** As many rows as fit in one request: the server takes 200, a bad radio takes less. */
function fit(rows: LogEntry[]) {
  const batch = rows.slice(0, MAX_BATCH);
  let bytes = 0;
  for (let i = 0; i < batch.length; i++) {
    bytes += batch[i].text.length + (batch[i].detail?.length ?? 0) + 160;
    if (bytes > MAX_BODY_BYTES) return batch.slice(0, Math.max(1, i));
  }
  return batch;
}

export async function flush() {
  if (flushing || !deviceId) return;
  if (Date.now() < throttledUntil) return schedule(throttledUntil - Date.now());
  sweepLog();
  const fromSpill = !!carried;
  const sending = carried ?? { sessionId, rows: queue };
  if (!sending.rows.length) return;
  flushing = true;
  // fit() inside the try: a throw between `flushing = true` and the try would
  // leave it stuck true and nothing would ever upload again for this launch.
  try {
    const batch = fit(sending.rows);
    // Plain fetch, not request(): request() logs, which would log the upload forever.
    const res = await fetch(`${API_URL}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({
        deviceId,
        sessionId: sending.sessionId,
        build,
        context: JSON.stringify(context()).slice(0, 1000),
        entries: batch.map((e) => ({
          time: e.time,
          kind: e.kind,
          level: e.level,
          text: e.text.slice(0, 1000),
          ...(e.detail && { detail: e.detail.slice(0, 4000) }),
          ...(e.count > 1 && { count: e.count }),
          seq: e.seq,
          ...(e.route && { route: e.route.slice(0, 120) }),
          ...(e.state && { state: e.state.slice(0, 16) }),
        })),
      }),
    });
    online = true;
    // Drop the batch if the server took it, or rejected it as malformed (retrying won't help).
    if (res.ok || res.status === 400) {
      // By identity, not by index: trim() can have rewritten `queue` while the
      // request was in flight, and slicing the old length off the new array
      // resurrected rows that had already been dropped and lost ones that hadn't.
      const sent = new Set(batch.map((e) => e.seq));
      if (fromSpill) {
        const rest = (carried?.rows ?? []).filter((e) => !sent.has(e.seq));
        carried = rest.length ? { sessionId: carried!.sessionId, rows: rest } : null;
        // Everything the last run saved is up: the file must go, or every cold
        // launch from here on re-uploads the same 300 rows.
        if (!carried) clearSpill();
      } else {
        queue = queue.filter((e) => !sent.has(e.seq));
        // Nothing left to lose, so nothing left on disk to send twice.
        if (!queue.length) clearSpill();
      }
      failures = 0;
      lastOkAt = Date.now();
      if (res.status === 400) {
        // Every time, not just the first: each one shreds up to 200 rows, and a
        // silent second occurrence is a hole in the sequence with no explanation.
        devlog("warn", `the server refused a log batch as malformed (400); ${batch.length} rows are gone`, undefined, {
          key: "log batch refused",
        });
      }
      if (res.status === 200) {
        // A throttled batch is accepted and dropped on purpose (api/src/logs.ts).
        const body = (await res.json().catch(() => null)) as { throttled?: boolean; cap?: number } | null;
        if (body?.throttled) {
          throttledUntil = Date.now() + THROTTLE_PAUSE_MS;
          devlog("warn", `the server is throttling this device's logs (${body.cap ?? "?"}/hour); ${batch.length} rows were dropped`, undefined, {
            key: "log throttled",
          });
        }
      }
    } else {
      failures++;
    }
  } catch {
    // Offline, or the radio dropped it: keep the rows and try again later.
    failures++;
    online = false;
  } finally {
    flushing = false;
    const left = (carried?.rows.length ?? 0) + queue.length;
    if (left) schedule(Date.now() < throttledUntil ? throttledUntil - Date.now() : failures ? backoff() : 0);
  }
}

/**
 * The queue is full — no signal for a long stretch. Throw away the chatter
 * before the warnings, and say how much went, so a hole in the sequence numbers
 * has an explanation sitting next to it.
 */
function trim() {
  if (trimming) return;
  trimming = true;
  try {
    if (queue.length <= MAX_QUEUE) return;
    const before = queue.length;
    // Down to TRIM_TO, not to the cap: trimming to exactly MAX_QUEUE left no
    // headroom, so the very next line was over it again and every single line
    // from then on wrote another "queue full" warning of its own.
    const bad = queue.filter((e) => LEVEL_ORDER[e.level] >= LEVEL_ORDER.warn);
    if (bad.length >= TRIM_TO) {
      queue = bad.slice(-TRIM_TO);
    } else {
      const room = TRIM_TO - bad.length;
      // slice(-0) is slice(0), which keeps the whole array — the one case where
      // "keep the last `room`" silently means "keep everything".
      const chatter = room > 0 ? queue.filter((e) => LEVEL_ORDER[e.level] < LEVEL_ORDER.warn).slice(-room) : [];
      queue = [...bad, ...chatter].sort((a, b) => a.seq - b.seq);
    }
    const dropped = before - queue.length;
    if (!dropped) return;
    droppedTotal += dropped;
    devlog(
      "warn",
      `log queue full: ${dropped} lines dropped before they could be uploaded`,
      `${queue.length} still waiting; last upload ${lastOkAt ? `${Math.round((Date.now() - lastOkAt) / 60_000)} min ago` : "never"}`,
      { key: "log queue full" },
    );
  } finally {
    trimming = false;
  }
}

// --- Surviving a crash -----------------------------------------------------

/**
 * Writes what hasn't been uploaded to disk, synchronously. File.write is
 * synchronous in expo-file-system 57, which is the only reason this can run
 * inside a fatal handler at all — an awaited fetch there never finishes.
 */
function spill(why: string) {
  try {
    const rows = [...(carried?.rows ?? []), ...queue].slice(-SPILL_ROWS);
    if (!rows.length) return clearSpill();
    new File(Paths.cache, SPILL_FILE).write(JSON.stringify({ why, at: Date.now(), sessionId, rows }));
  } catch {
    // A full disk, or the file is locked. Nothing useful to do about it from here.
  }
}

/**
 * Everything the spill was holding has since gone up. The file has to go with
 * it: a spill written when the app went to the background, uploaded a moment
 * later and then left on disk, is re-uploaded whole on the next cold launch —
 * 300 duplicate rows for something that already arrived.
 */
function clearSpill() {
  try {
    const file = new File(Paths.cache, SPILL_FILE);
    if (file.exists) file.delete();
  } catch {}
}

/** Picks up what the last run never sent. Those rows keep their own session id and go first. */
function recoverSpill() {
  try {
    const file = new File(Paths.cache, SPILL_FILE);
    if (!file.exists) return;
    const saved = JSON.parse(file.textSync()) as { why?: string; at?: number; sessionId?: string; rows?: LogEntry[] };
    file.delete();
    // Shape-checked: a spill written by a different build of this file is still
    // JSON, and a row missing `text` would throw inside the uploader instead.
    const rows = (Array.isArray(saved.rows) ? saved.rows : [])
      .filter((e): e is LogEntry => !!e && typeof e.text === "string" && typeof e.time === "number")
      .map((e) => ({ ...e, count: e.count ?? 1, level: e.level ?? "info", seq: e.seq ?? 0 }))
      .slice(-SPILL_ROWS);
    if (!rows.length) return;
    carried = { sessionId: saved.sessionId ?? `lost-${sessionId}`, rows };
    devlog(
      "warn",
      `picked up ${rows.length} log lines the last run never sent (${saved.why ?? "reason unknown"})`,
      `session ${saved.sessionId ?? "?"}, saved ${saved.at ? clock(saved.at) : "?"}`,
      { collapse: false },
    );
  } catch {
    try {
      new File(Paths.cache, SPILL_FILE).delete();
    } catch {}
  }
}

// --- Reporting a bug -------------------------------------------------------

/**
 * One row a tester can produce without anybody reading D1 first: easy to find
 * (`WHERE text LIKE 'BUG REPORT%'`), carrying what they typed, what the phone
 * was doing and the last fifty events. Everything queued is pushed before this
 * answers, so "sent" means sent.
 */
export async function sendBugReport(note: string) {
  const summary = note.trim().split("\n")[0].slice(0, 120) || "no description";
  // The report is worth more with the lines that led up to it.
  adoptSkipped();
  devlog(
    "warn",
    `BUG REPORT: ${summary}`,
    [note.trim() || "(nothing typed)", "", `build ${build}`, `phone ${JSON.stringify(context())}`, "", ...breadcrumbs()].join("\n"),
    { level: "error", collapse: false },
  );
  await flush();
  if (pending()) await flush();
  return pending()
    ? { ok: false, detail: `Saved on this phone (${pending()} lines waiting). It goes as soon as you're back online.` }
    : { ok: true, detail: "Sent. Thank you." };
}

const pending = () => (carried?.rows.length ?? 0) + queue.length;

/** Everything a report would carry, as plain text, for Copy and for email. */
export function logSnapshot() {
  return [
    `OVOA log — ${new Date().toISOString()}`,
    `build ${build}`,
    `device ${deviceId ?? "?"} · session ${sessionId}`,
    `phone ${JSON.stringify(context())}`,
    "",
    formatDevLog(recentLog()),
  ].join("\n");
}

// --- Catching what nobody caught -------------------------------------------

function describe(args: unknown[]) {
  return args
    .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : safe(a)))
    .join(" ");
}

function safe(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : safe(err));

/**
 * Console output into the log. Kept in release as well as dev: on a TestFlight
 * phone the console goes nowhere at all, and a console.warn from a library is
 * often the only clue there is. Nothing in src/ calls console directly, so this
 * is purely what React Native and the libraries say.
 */
function captureConsole() {
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      // React Native routes an uncaught error back through console.error
      // (ExceptionsManager.handleException); it has already been logged once.
      if (inHandler) return;
      try {
        const [first, ...rest] = describe(args).split("\n");
        const kind = level === "error" ? "err" : level === "warn" ? "warn" : "log";
        devlog(kind, first.slice(0, 300), rest.length ? rest.join("\n") : undefined, {
          level: level === "log" || level === "info" ? "debug" : undefined,
        });
      } catch {
        // Never let the logger break console.
      }
    };
  }
}

/**
 * Uncaught errors and unhandled rejections.
 *
 * React Native installs its own ErrorUtils handler (setUpErrorHandling.js) and,
 * in a dev build only, its own Hermes rejection tracker — polyfillPromise.js
 * guards that call with __DEV__. So this wraps the handler that is already there
 * and always calls it (dropping it is what stops iOS ever recording the crash),
 * and installs a rejection tracker only in release, where nothing else has.
 */
function captureCrashes() {
  const errorUtils = (
    globalThis as {
      ErrorUtils?: {
        getGlobalHandler(): (e: Error, fatal?: boolean) => void;
        setGlobalHandler(h: (e: Error, fatal?: boolean) => void): void;
      };
    }
  ).ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, fatal) => {
      devlog("err", `${fatal ? "FATAL " : ""}uncaught JS error: ${error?.message ?? String(error)}`, error?.stack, {
        level: fatal ? "fatal" : "error",
        collapse: false,
      });
      // A crash takes the whole on-phone story with it, not just the lines
      // that would have been uploaded anyway: what happened in the minute
      // before is the part worth having.
      if (fatal) adoptSkipped();
      // On disk first: the fetch below will not finish if this is really fatal.
      spill(fatal ? "a fatal JS error" : "an uncaught JS error");
      void flush();
      inHandler = true;
      try {
        previous(error, fatal);
      } finally {
        inHandler = false;
      }
    });
  }

  if (!__DEV__) {
    const hermes = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void } })
      .HermesInternal;
    hermes?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (id: number, error: unknown) =>
        devlog("err", `unhandled promise rejection #${id}: ${message(error)}`, error instanceof Error ? error.stack : safe(error)),
      // A rejection can be caught a moment late (a race whose loser settles second).
      // Saying so beats leaving a red line behind that was never a problem.
      onHandled: (id: number) => devlog("log", `promise rejection #${id} was handled after all`, undefined, { level: "debug" }),
    });
  }
}

/** Call once at startup. */
export function startRemoteLog() {
  if (started) return;
  started = true;

  setLogContext({ state: AppState.currentState });

  onDevLog((entry) => {
    if (!uploads(entry)) {
      skipped.push(entry);
      if (skipped.length > MAX_SKIPPED) skipped.splice(0, skipped.length - MAX_SKIPPED);
      return;
    }
    queue.push(entry);
    if (queue.length > MAX_QUEUE) trim();
    schedule(LEVEL_ORDER[entry.level] >= LEVEL_ORDER.error ? URGENT_MS : FLUSH_MS);
  });

  storage
    .get(DEVICE_KEY)
    .then(async (saved) => {
      deviceId = saved || `${Platform.OS}-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
      if (!saved) await storage.set(DEVICE_KEY, deviceId);
      schedule(0);
    })
    .catch(() => {
      deviceId = `${Platform.OS}-unsaved-${sessionId}`;
      schedule(0);
    });

  captureConsole();
  captureCrashes();
  recoverSpill();

  devlog("log", `app started (${build})`, `session ${sessionId}`);

  AppState.addEventListener("change", (state) => {
    setLogContext({ state });
    devlog("log", `app state: ${state}`, undefined, { level: "debug" });
    sweepLog();
    if (state === "active") {
      // Back from a dead radio or a long suspend: try again now, not after the backoff.
      failures = 0;
      schedule(0);
      return;
    }
    // Going away: iOS may suspend or kill us. Push what we have, and keep a copy
    // on disk in case we are frozen before the request lands.
    spill(`the app went ${state}`);
    void flush();
  });
}
