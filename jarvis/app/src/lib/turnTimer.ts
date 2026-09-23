import { useSyncExternalStore } from "react";
import { devlog, type LogKind } from "./devlog";

// Where a turn's time goes.
//
// A spoken turn passes through the clip (record, fetch over Bluetooth, decode),
// the phone (upload), and the server (transcribe, think, voice the reply), and
// until this file existed each of those logged its own line with no way to add
// them up. Every stage is marked here instead, and the turn ends with one line:
//
//   perf  band turn 8.4 s after you stopped speaking
//         fetch 2.7 s · transcribe 0.9 s · think 3.9 s · voice 0.5 s
//
// The same records feed Dev tools → Turn timings, so a slow turn can be taken
// apart on the phone, and remoteLog.ts uploads the line for reading afterwards.

/** A point in a turn. `since` is the time from the previous mark. */
export type TurnMark = { name: string; at: number; since: number; detail?: string };

export type TurnRecord = {
  id: number;
  /** "band": the clip's microphone. "phone": the phone's own. */
  source: "band" | "phone";
  startedAt: number;
  marks: TurnMark[];
  /** What the user said, once it's known. */
  heard?: string;
  /** What the server reported about the model (engine, ms, prompt size). */
  server?: string;
  error?: string;
  endedAt?: number;
};

/** The mark a turn's latency is measured from: everything before it is the user talking. */
const ZERO_MARK = "stopped talking";

const MAX_TURNS = 12;

let turns: TurnRecord[] = [];
let current: TurnRecord | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((l) => l());

/**
 * Starts a turn, ending any turn still open (a click during a reply). `at`: when
 * it really began, if earlier than now — a phone turn starts at the user's last
 * word, not when the gate decided they were done.
 */
export function startTurn(source: TurnRecord["source"], at = Date.now()): TurnRecord {
  if (current) endTurn("replaced by a new turn");
  current = { id: nextId++, source, startedAt: at, marks: [] };
  turns = [...turns.slice(-(MAX_TURNS - 1)), current];
  changed();
  return current;
}

export const currentTurn = () => current;

/** Notes that the turn reached a stage (at `at`, if that was before now). Ignored when no turn is open. */
export function mark(name: string, detail?: string, at = Date.now()) {
  if (!current) return;
  const previous = current.marks.at(-1);
  current.marks.push({ name, at, since: at - (previous?.at ?? current.startedAt), detail });
  changed();
}

/** The user has stopped talking (now, or at `at`): the clock the user actually feels starts here. */
export const markStopTalking = (at?: number) => mark(ZERO_MARK, undefined, at);

export function noteHeard(text: string) {
  if (!current) return;
  current.heard = text;
  changed();
}

export function noteServer(meta: unknown) {
  if (!current) return;
  current.server = typeof meta === "string" ? meta : safe(meta);
  changed();
}

export function failTurn(message: string) {
  if (!current) return;
  current.error = message;
  endTurn();
}

/** Closes the turn and logs its breakdown. */
export function endTurn(reason?: string) {
  const turn = current;
  if (!turn) return;
  current = null;
  turn.endedAt = Date.now();
  if (reason && !turn.error) turn.error = reason;
  devlog(
    "perf",
    summary(turn),
    // The size of what was heard, not the words: a perf line is uploaded from every build.
    [breakdown(turn), turn.server && `server ${turn.server}`, turn.heard && `heard ${turn.heard.length} chars`]
      .filter(Boolean)
      .join("\n    "),
    // Never folded into a repeat: devlog blurs the digits, so every turn with the same
    // stages looked like one line and all but the first lost their numbers in device_logs.
    { collapse: false },
  );
  changed();
}

/**
 * A stopwatch for anything that isn't a whole turn: a Bluetooth fetch, a Health
 * read, a screen's first paint. Every leg is timed, the whole thing writes one
 * line, and while a turn is open the legs land on its breakdown too — so the
 * next "why was that slow" has an answer without a one-off Date.now() being
 * added to yet another file.
 *
 *   const s = span("clip fetch");
 *   s.mark("first byte");
 *   s.end(`${kb} KB`);
 *   // perf  clip fetch 2.7 s — 412 KB
 *   //       first byte 1.9 s · done 0.8 s
 *
 * `toTurn: false` for something that runs alongside a turn but isn't part of
 * what the user is waiting for (a background sync), so it doesn't pad the
 * breakdown with time nobody felt.
 */
export function span(name: string, { kind = "perf" as LogKind, toTurn = true } = {}) {
  const startedAt = Date.now();
  let last = startedAt;
  let ended = false;
  const legs: string[] = [];

  const leg = (label: string) => {
    const at = Date.now();
    legs.push(`${label} ${seconds(at - last)}`);
    last = at;
    if (toTurn) mark(`${name}: ${label}`);
  };

  return {
    /** Notes that the span reached a stage. */
    mark: leg,
    /** Closes the span and logs it. Calling it twice does nothing the second time. */
    end: (detail?: string) => {
      if (ended) return 0;
      ended = true;
      if (legs.length) leg("done");
      const total = Date.now() - startedAt;
      devlog(kind, `${name} ${seconds(total)}${detail ? ` — ${detail}` : ""}`, legs.length ? legs.join(" · ") : undefined);
      return total;
    },
    /** Closes the span as a failure, with however far it got. */
    fail: (err: unknown) => {
      if (ended) return 0;
      ended = true;
      const total = Date.now() - startedAt;
      devlog(
        "err",
        `${name} failed after ${seconds(total)}`,
        [legs.join(" · "), err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)].filter(Boolean).join("\n"),
      );
      return total;
    },
    elapsed: () => Date.now() - startedAt,
  };
}

/** "band turn 8.4 s after you stopped speaking" — the number the user feels. */
export function summary(turn: TurnRecord) {
  const zero = turn.marks.find((m) => m.name === ZERO_MARK)?.at;
  const end = turn.endedAt ?? Date.now();
  const waited = zero ? end - zero : end - turn.startedAt;
  const what = turn.error ? `failed after ${seconds(waited)}` : `${seconds(waited)} after you stopped speaking`;
  return `${turn.source} turn ${what}${turn.error ? ` — ${turn.error}` : ""}`;
}

/** Every stage and what it cost, longest first in the reader's mind: order is kept. */
export function breakdown(turn: TurnRecord) {
  return turn.marks.map((m) => `${m.name} ${seconds(m.since)}${m.detail ? ` (${m.detail})` : ""}`).join(" · ");
}

/** Time from the moment the user stopped talking to a given mark, if both happened. */
export function latencyTo(turn: TurnRecord, markName: string) {
  const zero = turn.marks.find((m) => m.name === ZERO_MARK)?.at;
  const hit = turn.marks.find((m) => m.name === markName)?.at;
  return zero && hit ? hit - zero : null;
}

export const recentTurns = () => turns;

export function useTurns() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => turns,
  );
}

export function clearTurns() {
  turns = [];
  current = null;
  changed();
}

function seconds(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

function safe(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
