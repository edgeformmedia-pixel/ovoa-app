import Constants from "expo-constants";
import { AppState, Platform } from "react-native";
import { API_URL } from "./api";
import { onDevLog, type LogEntry } from "./devlog";
import { storage } from "./storage";

// Sends the dev log to the server (POST /logs → D1 table device_logs) every few
// seconds, so what happens on the phone can be read remotely. Also routes
// console output, uncaught JS errors and unhandled promise rejections into the log.

const FLUSH_MS = 3000;
const MAX_BATCH = 200;
const MAX_QUEUE = 2000;
const DEVICE_KEY = "ovoa.deviceId";

let queue: LogEntry[] = [];
let token: string | null = null;
let deviceId: string | null = null;
let flushing = false;
let started = false;
const sessionId = Math.random().toString(36).slice(2, 12);
const build = `${Constants.expoConfig?.version ?? "?"} ${Platform.OS} ${__DEV__ ? "dev" : "release"}`;

/** Tags uploads with the signed-in user (or clears it on sign-out). */
export function setLogToken(value: string | null) {
  token = value;
}

async function flush() {
  if (flushing || !queue.length || !deviceId) return;
  flushing = true;
  const batch = queue.slice(0, MAX_BATCH);
  try {
    // Plain fetch, not request(): request() logs, which would log the upload forever.
    const res = await fetch(`${API_URL}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({
        deviceId,
        sessionId,
        build,
        entries: batch.map((e) => ({
          time: e.time,
          kind: e.kind,
          text: e.text.slice(0, 1000),
          ...(e.detail && { detail: e.detail.slice(0, 4000) }),
        })),
      }),
    });
    // Drop the batch if the server took it, or rejected it as malformed (retrying won't help).
    if (res.ok || res.status === 400) queue = queue.slice(batch.length);
  } catch {
    // Offline: keep it and try again next time.
  } finally {
    flushing = false;
  }
}

function text(args: unknown[]) {
  return args
    .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : safe(a)))
    .join(" ");
}

function safe(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Call once at startup. */
export function startRemoteLog(devlog: (kind: LogEntry["kind"], text: string, detail?: unknown) => void) {
  if (started) return;
  started = true;

  onDevLog((entry) => {
    queue.push(entry);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  });

  storage
    .get(DEVICE_KEY)
    .then(async (saved) => {
      deviceId = saved || `${Platform.OS}-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
      if (!saved) await storage.set(DEVICE_KEY, deviceId);
    })
    .catch(() => (deviceId = `${Platform.OS}-unsaved-${sessionId}`));

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const [first, ...rest] = text(args).split("\n");
      devlog(level === "error" ? "err" : level, first.slice(0, 300), rest.length ? rest.join("\n") : undefined);
    };
  }

  const errorUtils = (globalThis as {
    ErrorUtils?: {
      getGlobalHandler(): (e: Error, fatal?: boolean) => void;
      setGlobalHandler(h: (e: Error, fatal?: boolean) => void): void;
    };
  }).ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, fatal) => {
      devlog("err", `${fatal ? "FATAL " : ""}JS error: ${error?.message}`, error?.stack);
      flush();
      previous(error, fatal);
    });
  }

  const hermes = (globalThis as {
    HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void };
  }).HermesInternal;
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id: number, error: unknown) =>
      devlog("err", `unhandled promise rejection: ${error instanceof Error ? error.message : safe(error)}`, error instanceof Error ? error.stack : undefined),
  });

  devlog("log", `app started (${build})`);
  setInterval(flush, FLUSH_MS);
  AppState.addEventListener("change", (state) => {
    devlog("log", `app state: ${state}`);
    flush();
  });
}
