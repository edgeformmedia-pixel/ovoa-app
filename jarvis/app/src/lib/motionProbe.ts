import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import * as ute from "../../modules/ute-ble";
import * as clip from "./clip";
import { devlog } from "./devlog";

// The motion probe (Dev tools → Motion lab). The ES100 answers few of the SDK's motion
// commands and nobody knows which, so this tries every one of them, one at a time, while
// the user holds still and then twists, and uploads a row per source (kind "probe" in
// device_logs) plus a summary. The raw packets the SDK logs are counted per phase too, so
// a clip that sends motion the SDK doesn't parse still shows up (more packets while twisting).
//
// Verdicts: WIN streams and twisting clearly moves a value; FLAT streams but twisting doesn't
// move it; SLOW under 2 samples a second; ONE-SHOT one or two readings; SILENT nothing;
// SKIPPED the SDK doesn't know the command. BREAKS: the clip stopped answering, or went into
// factory-test mode (which blocks recording), after the source ran. The best WIN that doesn't
// break the clip becomes twist-to-listen's first choice.

type Step = { id: string; source: ute.MotionSource | null; intervalMs: number; what: string };

// Most promising first. The g-sensor and gyro tests may answer only once per connection, so
// their variants run in the order most likely to get fresh readings. Known failures run last.
const STEPS: Step[] = [
  { id: "baseline", source: null, intervalMs: 0, what: "Nothing on: does the clip send anything by itself?" },
  { id: "gyro3", source: "gyro3", intervalMs: 0, what: "Gyroscope test (newer command), sent once" },
  { id: "gyro3poll", source: "gyro3poll", intervalMs: 200, what: "Gyroscope test (newer command), resent 5×/s" },
  { id: "gsensorToggle", source: "gsensorToggle", intervalMs: 300, what: "G-sensor test, closed and reopened 3×/s" },
  { id: "gsensor2", source: "gsensor", intervalMs: 500, what: "G-sensor test, reopened 2×/s" },
  { id: "gsensor10", source: "gsensor", intervalMs: 100, what: "G-sensor test, reopened 10×/s" },
  { id: "gsensorOnce", source: "gsensorOnce", intervalMs: 0, what: "G-sensor test, opened once" },
  { id: "gyro", source: "gyro", intervalMs: 100, what: "Gyroscope read (older command), 10×/s" },
  { id: "frame", source: "frame", intervalMs: 0, what: "Live health frame (steps)" },
  { id: "game", source: "game", intervalMs: 0, what: "Motion game stream (failed before)" },
  { id: "wear6", source: "wear6", intervalMs: 0, what: "Wearable 6-axis test (failed before)" },
  { id: "wear3", source: "wear3", intervalMs: 0, what: "Wearable 3-axis test (failed before)" },
];

const SETTLE_MS = 700;
const STILL_MS = 3000;
const TWIST_MS = 4000;
const AFTER_MS = 1500;
const CALL_MS = 5000;
const MAX_LINES_PER_STEP = 3000;
const KEEP_AWAKE_TAG = "motion-probe";

type Phase = "start" | "still" | "twist" | "after";
const PHASES: Phase[] = ["start", "still", "twist", "after"];

export type Verdict = "WIN" | "FLAT" | "SLOW" | "ONE-SHOT" | "SILENT" | "SKIPPED";

export type StepResult = {
  id: string;
  what: string;
  source: ute.MotionSource | null;
  intervalMs: number;
  verdict: Verdict;
  breaks: boolean;
  /** Samples a second while still + twisting. */
  hz: number;
  /** Best value's twist swing over its resting noise. */
  score: number;
  /** Which value of the sample moved most, or null. */
  channel: number | null;
  counts: Record<Phase, number>;
  /** Raw packets from the clip, per phase. */
  raw: Record<Phase, number>;
  note: string;
};

export type ProbeState = {
  running: boolean;
  /** Index of the step running. */
  step: number;
  total: number;
  what: string | null;
  instruction: string | null;
  /** Live counters for the step running. */
  samples: number;
  raw: number;
  results: StepResult[];
  winner: StepResult | null;
  error: string | null;
  finishedAt: number | null;
};

let state: ProbeState = {
  running: false,
  step: 0,
  total: STEPS.length,
  what: null,
  instruction: null,
  samples: 0,
  raw: 0,
  results: [],
  winner: null,
  error: null,
  finishedAt: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<ProbeState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useProbe() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Minutes a full run takes, for the screen. */
export const probeMinutes = Math.ceil(
  (STEPS.length * (SETTLE_MS + STILL_MS + TWIST_MS + AFTER_MS + 2500)) / 60_000,
);

// --- What the current step collects ------------------------------------------

type Collected = { phase: Phase; values: number[] };

let phase: Phase = "start";
/** The source the step turned on; null for the baseline, which takes anything. */
let current: ute.MotionSource | null = null;
let collecting = false;
let samples: Collected[] = [];
let strays: Record<string, number> = {};
let lines: { phase: Phase; line: string }[] = [];
let inputs: string[] = [];
let stopRequested = false;

const tap: clip.ProbeTap = {
  onMotion(source, batch) {
    if (!collecting) return;
    if (current !== null && source !== current) {
      strays[source] = (strays[source] ?? 0) + batch.length;
      return;
    }
    for (const values of batch) samples.push({ phase, values });
    set({ samples: samples.length });
  },
  onLog(line) {
    if (!collecting || lines.length >= MAX_LINES_PER_STEP) return;
    lines.push({ phase, line });
    if (RAW_PACKET.test(line)) set({ raw: state.raw + 1 });
  },
  onInput(input) {
    if (collecting) inputs.push(`${phase}: ${input.kind} ${input.value}${input.detail ? ` ${input.detail}` : ""}`);
  },
};

/** A packet from the clip as the SDK logs it: "CMD:App receive lenght=6,01e7ac020101,34F2". */
const RAW_PACKET = /receive\s+len\w*=(\d+),([0-9a-f]+)/i;

// --- Running it ---------------------------------------------------------------

export function stopProbe() {
  stopRequested = true;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Waits, returning early when the user stops the probe. */
async function wait(ms: number) {
  for (let waited = 0; waited < ms && !stopRequested; waited += 100) {
    await new Promise((r) => setTimeout(r, Math.min(100, ms - waited)));
  }
}

type Outcome<T> = { ok: true; value: T; ms: number } | { ok: false; error: string; ms: number };

async function within<T>(promise: Promise<T>, ms: number): Promise<Outcome<T>> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
      }),
    ]);
    return { ok: true, value, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: message(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function clipStatus() {
  const status = await within(ute.getStatus(), 3000);
  return status.ok ? { alive: true, state: status.value.state as number } : { alive: false, state: null };
}

const outcome = (o: Outcome<unknown> | null) => (o ? (o.ok ? { ok: true, ms: o.ms } : { ok: false, ms: o.ms, error: o.error }) : null);

function show(index: number, step: Step, instruction: string) {
  set({ step: index, what: step.what, instruction });
}

export async function runProbe() {
  if (state.running) return;
  stopRequested = false;
  set({ running: true, step: 0, results: [], winner: null, error: null, finishedAt: null, samples: 0, raw: 0 });
  const began = Date.now();
  const results: StepResult[] = [];
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
  try {
    await clip.beginProbe(tap);
    const [sensors, activity] = [await within(ute.probeSensors(), CALL_MS), await within(ute.readActivity(), CALL_MS)];
    const clipState = clip.getClipState();
    devlog(
      "probe",
      `probe start: ${STEPS.length} sources`,
      JSON.stringify({
        device: clipState.device && { name: clipState.device.name, model: clipState.device.model, firmware: clipState.device.firmware },
        factoryTests: sensors.ok ? Object.keys(sensors.value.all ?? {}).filter((k) => sensors.value.all?.[k]) : sensors.error,
        flagsOn: Object.keys(clipState.capabilities ?? {}).filter((k) => clipState.capabilities?.[k]),
        activity: activity.ok ? activity.value : activity.error,
      }),
    );

    for (let i = 0; i < STEPS.length && !stopRequested; i++) {
      if (clip.getClipState().phase !== "connected") throw new Error("The clip disconnected.");
      const { result, detail } = await runStep(STEPS[i], i);
      results.push(result);
      set({ results: [...results] });
      devlog("probe", `probe ${result.id}: ${summaryLine(result)}`, fit(detail));
    }

    const after = await within(ute.readActivity(), CALL_MS);
    const winner = pickWinner(results);
    set({ winner });
    if (winner?.source) {
      await clip.setPreferredMotion({ source: winner.source, intervalMs: winner.intervalMs || 100 });
    }
    devlog(
      "probe",
      stopRequested
        ? `probe stopped after ${results.length} of ${STEPS.length}`
        : winner
          ? `probe summary: winner ${winner.id} (${winner.hz} Hz, score ${winner.score}, value ${winner.channel})`
          : "probe summary: no source streams motion",
      fit({
        seconds: Math.round((Date.now() - began) / 1000),
        results: results.map((r) => ({
          id: r.id,
          verdict: r.verdict,
          breaks: r.breaks,
          hz: r.hz,
          score: r.score,
          channel: r.channel,
          samples: r.counts.still + r.counts.twist,
          rawStill: r.raw.still,
          rawTwist: r.raw.twist,
        })),
        activityAfter: after.ok ? after.value : after.error,
      }),
    );
  } catch (err) {
    set({ error: message(err) });
    devlog("err", "motion probe failed", message(err));
  } finally {
    collecting = false;
    await clip.endProbe().catch(() => {});
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    set({ running: false, instruction: null, what: null, finishedAt: Date.now() });
  }
}

async function runStep(step: Step, index: number) {
  samples = [];
  strays = {};
  lines = [];
  inputs = [];
  phase = "start";
  current = step.source;
  set({ samples: 0, raw: 0 });
  show(index, step, "Getting ready…");
  const pre = await clipStatus();

  collecting = true;
  const startedAt = Date.now();
  const start = step.source ? await within(ute.setMotionSource(step.source, true, step.intervalMs || 100), CALL_MS) : null;
  await wait(SETTLE_MS);

  phase = "still";
  show(index, step, "Hold your wrist completely still");
  await wait(STILL_MS);

  phase = "twist";
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  show(index, step, "Twist your wrist back and forth now!");
  await wait(TWIST_MS);

  phase = "after";
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  show(index, step, "Stop. Hold still…");
  const stop = step.source ? await within(ute.setMotionSource(step.source, false, step.intervalMs || 100), CALL_MS) : null;
  await wait(AFTER_MS);
  collecting = false;
  current = null;
  const post = await clipStatus();

  return analyze(step, { pre, post, start, stop, seconds: (Date.now() - startedAt) / 1000 });
}

// --- Judging a step -----------------------------------------------------------

type Run = {
  pre: { alive: boolean; state: number | null };
  post: { alive: boolean; state: number | null };
  start: Outcome<void> | null;
  stop: Outcome<void> | null;
  seconds: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

function span(values: number[]) {
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

function analyze(step: Step, run: Run) {
  const count = (p: Phase) => samples.filter((s) => s.phase === p).length;
  const counts = Object.fromEntries(PHASES.map((p) => [p, count(p)])) as Record<Phase, number>;
  const still = samples.filter((s) => s.phase === "still").map((s) => s.values);
  const twist = samples.filter((s) => s.phase === "twist").map((s) => s.values);
  const width = Math.max(0, ...samples.map((s) => s.values.length));

  // Per value: how far twisting moves it, over how much it wanders at rest.
  let best = { channel: null as number | null, score: 0 };
  const ranges = [];
  for (let c = 0; c < width; c++) {
    const s = still.map((v) => v[c]).filter(Number.isFinite);
    const t = twist.map((v) => v[c]).filter(Number.isFinite);
    const stillSpan = span(s);
    const twistSpan = span(t);
    ranges.push({ still: stillSpan, twist: twistSpan });
    if (!twistSpan) continue;
    const noise = stillSpan && s.length >= 2 ? stillSpan[1] - stillSpan[0] : 0;
    const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    const swing = Math.max(twistSpan[1] - twistSpan[0], mean === null ? 0 : Math.max(...t.map((v) => Math.abs(v - mean))));
    const score = swing / Math.max(noise, 1);
    if (score > best.score) best = { channel: c, score };
  }

  // Raw packets from the clip, per phase and by command (first 3 bytes).
  const raw = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
  const rawKeys: Record<string, Record<string, number>> = {};
  const examples = new Map<string, string>();
  let sent = 0;
  for (const { phase: p, line } of lines) {
    const packet = RAW_PACKET.exec(line);
    if (packet) {
      raw[p]++;
      const key = packet[2].slice(0, 6).toLowerCase();
      rawKeys[p] = rawKeys[p] ?? {};
      rawKeys[p][key] = (rawKeys[p][key] ?? 0) + 1;
      if (!examples.has(key) && examples.size < 8) examples.set(key, `${p}: ${packet[2].slice(0, 80)}`);
    } else if (/send/i.test(line)) {
      sent++;
    }
  }

  const moving = counts.still + counts.twist;
  const total = counts.start + moving;
  const hz = round1(moving / ((STILL_MS + TWIST_MS) / 1000));
  const score = round1(best.score);
  const unsupported = run.start && !run.start.ok && /doesn't support/.test(run.start.error);
  const verdict: Verdict = unsupported
    ? "SKIPPED"
    : total === 0
      ? "SILENT"
      : total <= 2
        ? "ONE-SHOT"
        : hz < 2
          ? "SLOW"
          : score < 3
            ? "FLAT"
            : "WIN";
  const breaks =
    (run.pre.alive && !run.post.alive) ||
    (run.post.state === ute.RecordState.FactoryTest && run.pre.state !== ute.RecordState.FactoryTest);

  const notes: string[] = [];
  if (run.start && !run.start.ok) notes.push(`start: ${run.start.error}`);
  if (!run.pre.alive) notes.push("the clip wasn't answering before this ran");
  if (breaks) notes.push(run.post.alive ? "left the clip in factory-test mode" : "the clip stopped answering");
  if (raw.twist > raw.still * 1.5 + 2) notes.push(`more raw packets while twisting (${raw.still} → ${raw.twist})`);
  if (counts.after > 2) notes.push(`${counts.after} samples after stop`);
  if (Object.keys(strays).length) notes.push(`other sources: ${JSON.stringify(strays)}`);
  if (stopRequested) notes.push("stopped early");

  const result: StepResult = {
    id: step.id,
    what: step.what,
    source: step.source,
    intervalMs: step.intervalMs,
    verdict,
    breaks,
    hz,
    score,
    channel: best.channel,
    counts,
    raw,
    note: notes.join("; "),
  };
  const detail = {
    id: step.id,
    source: step.source,
    intervalMs: step.intervalMs,
    verdict,
    breaks,
    hz,
    score,
    channel: best.channel,
    counts,
    start: outcome(run.start),
    stop: outcome(run.stop),
    pre: run.pre,
    post: run.post,
    seconds: round1(run.seconds),
    ranges,
    still: still.slice(0, 4),
    twist: twist.slice(0, 8),
    strays,
    inputs: inputs.slice(0, 6),
    raw,
    rawKeys,
    sent,
    rawExamples: [...examples.values()],
    note: result.note,
  };
  return { result, detail };
}

function summaryLine(r: StepResult) {
  return `${r.verdict}${r.breaks ? " +BREAKS CLIP" : ""} · ${r.hz} Hz · score ${r.score}${r.note ? ` · ${r.note}` : ""}`;
}

function pickWinner(results: StepResult[]) {
  const wins = results.filter((r) => r.verdict === "WIN" && !r.breaks && r.source);
  wins.sort((a, b) => b.score - a.score || b.hz - a.hz);
  return wins[0] ?? null;
}

/** Keeps a row's detail under the server's 4000 characters, dropping the bulkiest parts first. */
function fit(detail: Record<string, unknown>) {
  let text = JSON.stringify(detail);
  for (const key of ["rawExamples", "twist", "still", "ranges", "rawKeys", "inputs"]) {
    if (text.length <= 3800) break;
    const { [key]: _dropped, ...rest } = detail;
    detail = rest;
    text = JSON.stringify(detail);
  }
  return text;
}
