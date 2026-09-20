import { useSyncExternalStore } from "react";

// In-memory log of traffic between the app and the API and of what the voice
// engine is doing, shown in the Assistant tab's Logs panel. remoteLog.ts also
// uploads it to the server (D1 table device_logs) for remote debugging.

/** probe: the motion probe's results (Dev tools → Motion lab). */
export type LogKind = "req" | "res" | "err" | "voice" | "log" | "warn" | "ble" | "probe" | "push" | "agent";
export type LogEntry = { id: number; time: number; kind: LogKind; text: string; detail?: string };

const MAX_ENTRIES = 400;
// The server keeps up to 4000 characters; the motion probe's per-source results need most of it.
const MAX_DETAIL = 3900;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const entryListeners = new Set<(entry: LogEntry) => void>();

/** Called with every new entry (the remote uploader). */
export function onDevLog(fn: (entry: LogEntry) => void) {
  entryListeners.add(fn);
  return () => entryListeners.delete(fn);
}

export function devlog(kind: LogKind, text: string, detail?: unknown) {
  const entry: LogEntry = { id: nextId++, time: Date.now(), kind, text };
  if (detail !== undefined) entry.detail = clip(typeof detail === "string" ? detail : safeJson(detail));
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), entry];
  listeners.forEach((l) => l());
  entryListeners.forEach((l) => l(entry));
}

export function clearDevLog() {
  entries = [];
  listeners.forEach((l) => l());
}

export function formatDevLog(list: LogEntry[]) {
  return list
    .map((e) => `${clock(e.time)} ${e.kind.toUpperCase().padEnd(5)} ${e.text}${e.detail ? `\n    ${e.detail}` : ""}`)
    .join("\n");
}

export function useDevLog() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => entries,
  );
}

export function clock(time: number) {
  const d = new Date(time);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(text: string) {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}… (${text.length} chars)` : text;
}
