import { useSyncExternalStore } from "react";

// In-memory log of traffic between the app and the API and of what the voice
// engine is doing, shown in the Assistant tab's Logs panel. remoteLog.ts also
// uploads it to the server (D1 table device_logs) for remote debugging.
//
// Everything is collapsed on the way in. One three-second retry loop wrote
// 7,150 identical rows in a day, and the phone sent 90,103 rows in 24 hours
// (device_logs, 2026-09-21) — more than anyone can read, with the one line that
// mattered buried in them. A line that repeats is written once, counted, and
// closed with a "× 412 in 21 min" row when it stops, so a loop costs two rows
// instead of thousands.

/**
 * probe: the motion probe's results (Dev tools → Motion lab).
 * perf: where one spoken turn's seconds went (turnTimer.ts).
 * file: what is on disk and where — recordings, fillers, speech clips. Its own
 * kind because "the file couldn't be opened" is only answerable with the path
 * that was tried and the names actually in the folder (device_logs, 2026-09-20).
 * nav: which screen is open (app/_layout.tsx). Added after the /agent crash,
 * which the log could not pin to a screen because nothing recorded the route.
 */
export type LogKind =
  | "req"
  | "res"
  | "err"
  | "voice"
  | "log"
  | "warn"
  | "ble"
  | "probe"
  | "push"
  | "agent"
  | "perf"
  | "file"
  | "nav";

/**
 * How much a line matters, apart from which part of the app wrote it. The kinds
 * above don't change — a week of rows and ~180 devlog() calls still read the
 * same — so the level rides alongside them, and the question that actually gets
 * asked in SQL becomes `WHERE level IN ('error','fatal')` instead of a guess at
 * which kinds happen to be bad news.
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export const LEVEL_ORDER: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

/** What a kind means when the caller doesn't say. Every existing call site lands here. */
const KIND_LEVEL: Record<LogKind, LogLevel> = {
  err: "error",
  warn: "warn",
  req: "debug",
  res: "debug",
  ble: "debug",
  probe: "debug",
  file: "debug",
  nav: "debug",
  voice: "info",
  push: "info",
  agent: "info",
  perf: "info",
  log: "info",
};

export type LogEntry = {
  id: number;
  /** Gapless within one launch: a hole in D1 means an upload never arrived. */
  seq: number;
  time: number;
  kind: LogKind;
  level: LogLevel;
  text: string;
  detail?: string;
  /** How many identical lines this row stands for. 1 unless it was collapsed. */
  count: number;
  /** The screen the user was on and whether the app was in front. Kept for warn and worse. */
  route?: string;
  state?: string;
};

export type LogOptions = {
  /** Overrides the kind's default level. */
  level?: LogLevel;
  /** false: never collapse this line into a repeat. For lines whose whole point is the number in them. */
  collapse?: boolean;
  /** Counts lines as the same repeat even when their text differs. */
  key?: string;
};

const MAX_ENTRIES = 400;
// The server keeps up to 4000 characters; the motion probe's per-source results need most of it.
const MAX_DETAIL = 3900;
/** The last events, attached to every error. Room is left for them inside MAX_DETAIL. */
const MAX_CRUMBS = 50;
const MAX_CRUMB_CHARS = 1800;
/** A line nothing has repeated for this long closes its group and writes its count. */
const COLLAPSE_QUIET_MS = 45_000;
/** At most this many groups are watched at once; the stalest is closed to make room. */
const MAX_GROUPS = 200;
/** Rows allowed in one minute. Past it they are dropped — but never silently. */
const CEILING_PER_MINUTE = 240;
/** How often a repeat redraws its row on the phone. The upload doesn't see these. */
const REPAINT_MS = 500;
/** How often the open groups are walked looking for ones that have gone quiet. */
const SWEEP_EVERY_MS = 5000;

let entries: LogEntry[] = [];
let nextId = 1;
let nextSeq = 1;
const listeners = new Set<() => void>();
const entryListeners = new Set<(entry: LogEntry) => void>();

/** Where the app is. The root layout keeps this current; it rides on every warn or worse. */
let place: { route?: string; state?: string } = {};

/** Called with every new entry (the remote uploader). */
export function onDevLog(fn: (entry: LogEntry) => void) {
  entryListeners.add(fn);
  return () => entryListeners.delete(fn);
}

/** The screen and the app state, so an error in D1 says where it happened. */
export function setLogContext(patch: { route?: string; state?: string }) {
  place = { ...place, ...patch };
}

export function devlog(kind: LogKind, text: string, detail?: unknown, options?: LogOptions) {
  try {
    write(kind, text, detail, options);
  } catch {
    // Logging must never break the thing it is logging.
  }
}

/**
 * Levels, for new code. The kind still says which part of the app spoke, so
 * `log.debug("ble", …)` is a Bluetooth line that stays on the phone unless the
 * upload level is lowered, while `log.error(…)` is an err row with breadcrumbs.
 */
export const log = {
  trace: (kind: LogKind, text: string, detail?: unknown) => devlog(kind, text, detail, { level: "trace" }),
  debug: (kind: LogKind, text: string, detail?: unknown) => devlog(kind, text, detail, { level: "debug" }),
  info: (kind: LogKind, text: string, detail?: unknown) => devlog(kind, text, detail, { level: "info" }),
  warn: (text: string, detail?: unknown) => devlog("warn", text, detail, { level: "warn" }),
  error: (text: string, detail?: unknown) => devlog("err", text, detail, { level: "error" }),
  /** The app is going down. Never collapsed, never dropped by the ceiling. */
  fatal: (text: string, detail?: unknown) => devlog("err", text, detail, { level: "fatal", collapse: false }),
};

/**
 * For a .catch that used to swallow the error: logs what failed, and why, as a
 * warning, so nothing that goes wrong on the phone is invisible (2026-09-21).
 */
export const logFail = (what: string) => (err: unknown) => {
  devlog("warn", `${what} failed`, err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
};

/**
 * For a line that can repeat without end: a retry loop, a microphone iOS keeps
 * refusing. `key` is a fixed string, one per call site, never built from the
 * data — it counts two lines as the same repeat even when their wording differs,
 * which the fingerprint below can't do when the wording changes completely.
 *
 * `windowMs` is accepted and ignored: the group closes when the line stops
 * coming (COLLAPSE_QUIET_MS) rather than on a fixed window, so a loop that runs
 * for an hour still reports at 10, 100 and 1000 rather than every five minutes.
 */
export function devlogRepeat(key: string, kind: LogKind, text: string, detail?: unknown, _windowMs?: number) {
  devlog(kind, text, detail, { key });
}

/**
 * Whatever was repeating has come right. Writes out the copies not yet counted,
 * so the log says how long it was broken, and lets the next failure be logged in
 * full rather than being folded into a group that is still open.
 */
export function devlogSettled(key: string) {
  const group = groups.get(key);
  if (!group) return;
  groups.delete(key);
  report(group, Date.now(), "stopped");
}

// --- Writing ---------------------------------------------------------------

function write(kind: LogKind, text: string, detail: unknown, options?: LogOptions) {
  const now = Date.now();
  const level = options?.level ?? KIND_LEVEL[kind];
  const safeText = redact(String(text)).slice(0, 1000);
  const body = detail === undefined ? undefined : redact(typeof detail === "string" ? detail : safeJson(detail));

  // Close anything that has gone quiet, so its count lands before this line. Every
  // five seconds, not on every write: the sweep walks every open group, and a loop
  // logging on a 250 ms timer would walk it two hundred times a minute for nothing.
  if (now - lastSweep > SWEEP_EVERY_MS) sweepLog(now);

  const print = options?.key ?? fingerprint(kind, safeText, body);
  const open = options?.collapse === false ? undefined : groups.get(print);
  if (open) {
    open.count++;
    open.lastAt = now;
    open.text = safeText;
    open.detail = body;
    touchCrumb(open, safeText, now);
    repaint(open, now);
    // A loop that never stops still has to reach the server before it does: 10, 100, 1000…
    if (isPowerOfTen(open.count)) report(open, now, "so far");
    return;
  }

  const row = emit({
    time: now,
    kind,
    level,
    text: safeText,
    detail: clip(withCrumbs(level, body)),
    count: 1,
    ...(LEVEL_ORDER[level] >= LEVEL_ORDER.warn ? where() : null),
  });
  const crumb = addCrumb(`${clock(now)} ${kind} ${safeText.slice(0, 120)}`);
  if (options?.collapse === false) return;
  if (groups.size >= MAX_GROUPS) closeStalest(now);
  groups.set(print, {
    kind,
    level,
    count: 1,
    // The row just emitted accounts for the first one; everything after it is owed.
    reported: 1,
    reportedAt: now,
    firstAt: now,
    lastAt: now,
    text: safeText,
    detail: body,
    row,
    paintedAt: now,
    crumb,
  });
}

/** Puts a row in the panel and hands it to the uploader. The only place a seq is spent. */
function emit(entry: Omit<LogEntry, "id" | "seq">) {
  if (!allow(entry)) return null;
  const row: LogEntry = { ...entry, id: nextId++, seq: nextSeq++ };
  push(row);
  return row;
}

function push(row: LogEntry) {
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), row];
  listeners.forEach((l) => l());
  entryListeners.forEach((l) => l(row));
}

// --- The ceiling -----------------------------------------------------------

let windowStart = 0;
let windowCount = 0;
let dropped = 0;
const droppedBy = new Map<string, number>();

/**
 * The last line of defence. Nothing gets past CEILING_PER_MINUTE rows a minute,
 * and the minute after a cut opens with a row saying how much went and what
 * most of it was — truncation that nobody is told about is worse than the flood.
 */
/**
 * Starts a new minute, and says what the last one cost. Called from allow() and
 * from every sweep, because the sweep is the only one that happens when nothing
 * is being logged: a flood followed by silence would otherwise take its tally
 * to the grave, which is the silent truncation this is all supposed to prevent.
 */
function rollWindow(now: number) {
  if (now - windowStart < 60_000) return;
  const missed = dropped;
  const worst = [...droppedBy.entries()].sort((a, b) => b[1] - a[1])[0];
  windowStart = now;
  windowCount = 0;
  dropped = 0;
  droppedBy.clear();
  if (!missed) return;
  windowCount++;
  push({
    id: nextId++,
    seq: nextSeq++,
    time: now,
    kind: "warn",
    level: "warn",
    text: `log: ${missed} lines dropped in the last minute (ceiling ${CEILING_PER_MINUTE}/min)`,
    detail: worst ? `most of them (× ${worst[1]}): ${worst[0]}` : undefined,
    count: missed,
    ...where(),
  });
}

function allow(entry: Omit<LogEntry, "id" | "seq">) {
  rollWindow(entry.time);
  // A fatal always goes through: it is the last thing this launch will ever say.
  if (entry.level === "fatal" || windowCount < CEILING_PER_MINUTE) {
    windowCount++;
    return true;
  }
  dropped++;
  const key = entry.text.slice(0, 80);
  droppedBy.set(key, (droppedBy.get(key) ?? 0) + 1);
  return false;
}

// --- Collapsing repeats ----------------------------------------------------

type Group = {
  kind: LogKind;
  level: LogLevel;
  count: number;
  /** How many of those are already accounted for by rows that have gone out. */
  reported: number;
  /** When the last of those rows went, so a progress row says "in the last 40 s". */
  reportedAt: number;
  firstAt: number;
  lastAt: number;
  text: string;
  detail?: string;
  /** The row already sent for this group, so the panel can count up in place. */
  row: LogEntry | null;
  paintedAt: number;
  /** Which breadcrumb belongs to this group, so a repeat updates it instead of filling the ring. */
  crumb: number;
};

const groups = new Map<string, Group>();

/**
 * What makes two lines the same line. Digits are blurred out: "no audio for
 * 3021 ms" and "no audio for 3122 ms" are one loop, and if the numbers counted
 * nothing would ever collapse — which is exactly how 7,150 rows happened. Only
 * the first line of the detail is used, so the top stack frame still separates
 * two different errors that share a message.
 */
function fingerprint(kind: LogKind, text: string, detail: string | undefined) {
  const nl = detail === undefined ? -1 : detail.indexOf("\n");
  const head = detail === undefined ? "" : nl >= 0 ? detail.slice(0, nl) : detail;
  return `${kind}\u0000${blur(text)}\u0000${blur(head)}`;
}

const blur = (text: string) => text.replace(/0x[0-9a-f]+/gi, "#").replace(/\d+/g, "#").slice(0, 240);

const isPowerOfTen = (n: number) => n >= 10 && /^10*$/.test(String(n));

/**
 * Closes groups nothing has added to for a while. Called on every write, by the
 * uploader's flush and when the app changes state, so a stopped loop still gets
 * its count without a timer of its own running all day.
 */
export function sweepLog(now = Date.now()) {
  lastSweep = now;
  // Also the only chance a finished flood gets to report what it dropped.
  rollWindow(now);
  for (const [print, group] of groups) {
    if (now - group.lastAt < COLLAPSE_QUIET_MS) continue;
    groups.delete(print);
    report(group, now, "stopped");
  }
}

let lastSweep = 0;

/** Too many groups at once: close the one that has been quiet longest. */
function closeStalest(now: number) {
  let oldest: [string, Group] | null = null;
  for (const pair of groups) if (!oldest || pair[1].lastAt < oldest[1].lastAt) oldest = pair;
  if (!oldest) return;
  groups.delete(oldest[0]);
  report(oldest[1], now, "stopped");
}

/**
 * The row a collapsed group leaves behind: how many more there were since the
 * last time it said anything, how long that went on, and the latest wording.
 *
 * Only the ones not already reported are counted. A loop writes a row at 10, at
 * 100 and again when it stops; if each of those carried the running total, the
 * counts would sum to four times the truth and no SQL over the table could be
 * trusted.
 */
function report(group: Group, now: number, tense: "stopped" | "so far") {
  const more = group.count - group.reported;
  if (more < 1) return;
  const detail = [
    `first ${clock(group.firstAt)}, last ${clock(group.lastAt)}${tense === "so far" ? ", still going" : ""}`,
    `${group.count} in all since ${clock(group.firstAt)}`,
    group.detail ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const window = now - group.reportedAt;
  const row = emit({
    time: now,
    kind: group.kind,
    level: group.level,
    text: `× ${more} more in ${lasted(window)} — ${group.text}`.slice(0, 1000),
    detail: clip(detail),
    count: more,
    ...(LEVEL_ORDER[group.level] >= LEVEL_ORDER.warn ? where() : null),
  });
  // Only once the row is really out. Marking them reported first meant a row the
  // ceiling refused took its occurrences with it, and the counts in D1 no longer
  // added up to what happened — which is the one thing this is for.
  if (!row) return;
  group.reported = group.count;
  group.reportedAt = now;
}

/**
 * Counts the repeat up on the phone's own panel. The uploaded row keeps count 1
 * on purpose: the closing row carries the real number, so nothing has to be
 * sent twice to correct it.
 */
function repaint(group: Group, now: number) {
  if (!group.row || !listeners.size || now - group.paintedAt < REPAINT_MS) return;
  group.paintedAt = now;
  const id = group.row.id;
  const updated = { ...group.row, count: group.count, time: now };
  entries = entries.map((e) => (e.id === id ? updated : e));
  group.row = updated;
  listeners.forEach((l) => l());
}

// --- Breadcrumbs -----------------------------------------------------------

const crumbs: string[] = [];
/** How many crumbs have fallen off the front, so a group's index stays valid. */
let crumbBase = 0;

function addCrumb(line: string) {
  crumbs.push(line);
  if (crumbs.length > MAX_CRUMBS) {
    crumbs.shift();
    crumbBase++;
  }
  return crumbBase + crumbs.length - 1;
}

/**
 * A repeat rewrites its own crumb instead of pushing a new one. Otherwise one
 * loop fills all fifty and the error that follows arrives with no history at all.
 */
function touchCrumb(group: Group, text: string, time: number) {
  const line = `${clock(time)} ${group.kind} ${text.slice(0, 120)} × ${group.count}`;
  const i = group.crumb - crumbBase;
  if (i >= 0 && i < crumbs.length) crumbs[i] = line;
  else group.crumb = addCrumb(line);
}

/** The last events, newest last. remoteLog puts these in a bug report too. */
export const breadcrumbs = () => crumbs.slice();

/**
 * An error arrives with what led to it. A stack trace says where it broke; the
 * fifty lines before it say what the app was doing, which is the part that was
 * always missing when reading device_logs after the fact.
 */
function withCrumbs(level: LogLevel, detail: string | undefined) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER.error || crumbs.length === 0) return detail;
  const room = MAX_DETAIL - MAX_CRUMB_CHARS - 48;
  const head = detail ? `${detail.slice(0, room)}\n` : "";
  return `${head}--- the ${crumbs.length} events before this ---\n${tail(crumbs.join("\n"), MAX_CRUMB_CHARS)}`;
}

/** The end of a long string: with breadcrumbs the newest lines are the ones worth keeping. */
const tail = (text: string, max: number) => (text.length <= max ? text : `…${text.slice(text.length - max)}`);

// --- Secrets ---------------------------------------------------------------

const SECRET_FIELD =
  /"(password|currentPassword|newPassword|token|pushToken|accessToken|refreshToken|idToken|apiKey|authorization|secret|siriKey)"\s*:\s*"[^"]*"/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// Encoding-blind: in a url the brackets arrive as %5B/%5D, which is how one of
// these reached D1 whole. An Expo push token is a bearer credential on its own.
const PUSH_TOKEN = /Expo(?:nent)?PushToken(?:\[|%5B)[^\]%]*(?:\]|%5D)/gi;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/**
 * Nothing that could sign somebody in, and no whole email address, reaches D1 —
 * the log table is public to anyone with the worker's URL and a device id.
 * Each pass is guarded by a cheap test so the common case costs one regex.
 */
function redact(text: string) {
  let out = text;
  if (/password|token|secret|apikey|authorization|sirikey/i.test(out)) {
    out = out.replace(SECRET_FIELD, (m) => `${m.slice(0, m.indexOf(":") + 1)}"…"`);
  }
  if (/Bearer |Basic /.test(out)) out = out.replace(BEARER, (_m, scheme: string) => `${scheme} …`);
  if (/PushToken/i.test(out)) out = out.replace(PUSH_TOKEN, "ExponentPushToken[…]");
  if (out.includes("@")) out = out.replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`);
  return out;
}

// --- The panel and the odds and ends ---------------------------------------

export function clearDevLog() {
  entries = [];
  groups.clear();
  crumbs.length = 0;
  crumbBase = 0;
  lastSweep = 0;
  listeners.forEach((l) => l());
}

/** Everything still in memory, for a bug report or the Copy button. */
export const recentLog = () => entries;

export function formatDevLog(list: LogEntry[]) {
  return list
    .map(
      (e) =>
        `${clock(e.time)} ${e.kind.toUpperCase().padEnd(5)} ${e.level.padEnd(5)} ${e.count > 1 ? `× ${e.count} ` : ""}${e.text}` +
        `${e.route ? ` [${e.route}${e.state ? ` ${e.state}` : ""}]` : ""}${e.detail ? `\n    ${e.detail}` : ""}`,
    )
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

/** "21 min", the way a person would say how long something went on for. */
function lasted(ms: number) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

const where = () => ({ route: place.route, state: place.state });

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function clip(text: string | undefined) {
  if (text === undefined) return undefined;
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}… (${text.length} chars)` : text;
}
