import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import * as ute from "../../modules/ute-ble";
import * as clip from "./clip";
import { devlog, logFail } from "./devlog";
import {
  commandsPerSecond,
  PHASES,
  pickWinner,
  primaryChannel,
  RAW_PACKET,
  scoreChannels,
  tallyPackets,
  verdictFor,
  type ChannelScore,
  type Phase,
  type Verdict,
} from "./probeScore";

// The motion probe (Dev tools → Motion lab), third round. What the first two found (2026-09-19):
// the gyroscope test ("gyro3") streams about one reading a second after one "on" and stops on
// "off"; the g-sensor test answers once per session, because the SDK sends only the first of
// repeated opens; reopening it 3×/s still silenced the clip for 8 s; nothing else answers. And the
// older gyro read command got an answer per request, a gyroscope-test packet the SDK hands to
// gyro3's callback. So this round asks two questions:
// - Does reading the gyroscope on request, on top of its stream, give 2-4 readings a second
//   ("gyro3read" at 1, 2 and 3 reads a second, the last one only for the record: too many
//   commands for twist)? More readings catch more of a twist.
// - Does a different command before each g-sensor open ("gsensorPing": a record-status request)
//   get each open sent? The accelerometer sees how the wrist is turned.
// Between steps it waits for the clip to answer again, logging how long that took.
//
// Each step: settle, hold still 4 s, twist back and forth 5 s, stop. A row per source (kind
// "probe" in device_logs), then a summary. The raw packets the SDK logs are counted per phase, and
// the bytes each command put on the wire are kept.
//
// Verdicts (probeScore.ts): WIN streams (0.6+ readings a second) and twisting clearly moves a value;
// FLAT streams but twisting doesn't move it; SLOW fewer readings; ONE-SHOT one or two; SILENT
// nothing; SKIPPED the SDK doesn't know the command. BREAKS: the clip stopped answering, or went
// into factory-test mode (which blocks recording), after the source ran. The best WIN that doesn't
// break the clip becomes twist-to-listen's first choice.

type Step = { id: string; source: ute.MotionSource | null; intervalMs: number; what: string };

// The riskiest step (the most commands a second) goes last.
const STEPS: Step[] = [
  { id: "baseline", source: null, intervalMs: 0, what: "Nothing on: does the clip send anything by itself?" },
  { id: "gyro3", source: "gyro3", intervalMs: 0, what: "Gyroscope test, sent once (twist's default)" },
  { id: "gyro3read1000", source: "gyro3read", intervalMs: 1000, what: "Gyroscope test, plus a read every second" },
  { id: "gyro3read500", source: "gyro3read", intervalMs: 500, what: "Gyroscope test, plus a read 2×/s" },
  { id: "gsensorPing", source: "gsensorPing", intervalMs: 1000, what: "G-sensor test, a status request then an open, every second" },
  { id: "gsensorOnce", source: "gsensorOnce", intervalMs: 0, what: "G-sensor test, opened once (for comparison)" },
  { id: "gyro3read333", source: "gyro3read", intervalMs: 333, what: "Gyroscope test, plus a read 3×/s (for the record: too many commands for twist)" },
];

/** Time to get the forearm onto a table or leg before "still" starts (readings meanwhile aren't judged). */
const SETTLE_MS = 2000;
const STILL_MS = 4000;
const TWIST_MS = 5000;
const AFTER_MS = 1500;
const CALL_MS = 5000;
/** How long to wait for the clip to answer again, before a step and after one that silenced it. */
const RECOVER_MS = 20_000;
const MAX_LINES_PER_STEP = 3000;
const KEEP_AWAKE_TAG = "motion-probe";

export type { Verdict };

export type StepResult = {
  id: string;
  what: string;
  source: ute.MotionSource | null;
  intervalMs: number;
  verdict: Verdict;
  breaks: boolean;
  /** Readings a second while still + twisting. */
  hz: number;
  /** Best value's twist swing over its resting noise. */
  score: number;
  /** Which value moved most: its index in the sample, or "spin" / "tilt". */
  channel: string | null;
  counts: Record<Phase, number>;
  /** Raw packets from the clip, per phase. */
  raw: Record<Phase, number>;
  /** From turning it on to the first reading, in ms. */
  firstMs: number | null;
  /** How many of the readings differ (1 of several: the same reading over and over). */
  distinct: number;
  /** Gyroscope test packets seen in the raw log, on (with data) and off (zeros). */
  gyroPackets: { on: number; off: number };
  /** How long the clip took to answer again after the step (0: at once), or null: not within RECOVER_MS. */
  recoveredMs: number | null;
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

/** Minutes a full run takes when the clip keeps answering, for the screen. */
export const probeMinutes = Math.ceil((STEPS.length * (SETTLE_MS + STILL_MS + TWIST_MS + AFTER_MS + 4000)) / 60_000);

// --- What the current step collects ------------------------------------------

type Collected = { phase: Phase; ms: number; values: number[] };

let phase: Phase = "start";
/** The source the step turned on; null for the baseline, which takes anything. */
let current: ute.MotionSource | null = null;
let collecting = false;
let stepStartedAt = 0;
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
    const ms = Date.now() - stepStartedAt;
    for (const values of batch) samples.push({ phase, ms, values });
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

type ClipCheck = { alive: boolean; state: number | null };

async function clipStatus(): Promise<ClipCheck> {
  const status = await within(ute.getStatus(), 3000);
  return status.ok ? { alive: true, state: status.value.state as number } : { alive: false, state: null };
}

/** Asks the clip for its status until it answers, for up to RECOVER_MS; how long that took. */
async function waitForClip(): Promise<ClipCheck & { waitedMs: number }> {
  const began = Date.now();
  for (;;) {
    const status = await clipStatus();
    const waitedMs = Date.now() - began;
    if (status.alive || waitedMs >= RECOVER_MS || stopRequested) return { ...status, waitedMs };
    await wait(2000);
  }
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
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(logFail("motionProbe: activateKeepAwakeAsync"));
  try {
    await clip.beginProbe(tap);
    const [sensors, activity] = [await within(ute.probeSensors(), CALL_MS), await within(ute.readActivity(), CALL_MS)];
    const clipState = clip.getClipState();
    devlog(
      "probe",
      `probe v3 start: ${STEPS.length} sources`,
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
    const winner = pickWinner(
      results,
      (source, intervalMs) => clip.canTwistWith(source) && commandsPerSecond(source, intervalMs) <= clip.MAX_TWIST_COMMANDS_PER_SECOND,
    );
    set({ winner });
    // A full run decides what twist tries first; nothing usable means its default (gyro3).
    if (!stopRequested) {
      await clip.setPreferredMotion(winner?.source ? { source: winner.source, intervalMs: winner.intervalMs } : null);
    }
    devlog(
      "probe",
      stopRequested
        ? `probe stopped after ${results.length} of ${STEPS.length}`
        : winner
          ? `probe summary: winner ${winner.id} (${winner.hz}/s, score ${winner.score}, ${winner.channel})`
          : "probe summary: no source won; twist stays on gyro3",
      fit({
        seconds: Math.round((Date.now() - began) / 1000),
        winner: winner?.id ?? null,
        results: results.map((r) => ({
          id: r.id,
          verdict: r.verdict,
          breaks: r.breaks,
          hz: r.hz,
          score: r.score,
          channel: r.channel,
          samples: r.counts.still + r.counts.twist,
          distinct: r.distinct,
          firstMs: r.firstMs,
          recoveredMs: r.recoveredMs,
          raw: r.raw.still + r.raw.twist,
          gyroPackets: r.gyroPackets,
        })),
        activityAfter: after.ok ? after.value : after.error,
      }),
    );
  } catch (err) {
    set({ error: message(err) });
    devlog("err", "motion probe failed", message(err));
  } finally {
    collecting = false;
    await clip.endProbe().catch(logFail("motionProbe: clip.endProbe"));
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(logFail("motionProbe: deactivateKeepAwake"));
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
  // Every step starts with a clip that answers, so one step's trouble isn't blamed on the next.
  show(index, step, "Checking the clip answers…");
  const pre = await waitForClip();

  show(index, step, "Rest your forearm on a table or your leg…");
  collecting = true;
  stepStartedAt = Date.now();
  const start = step.source ? await within(ute.setMotionSource(step.source, true, step.intervalMs), CALL_MS) : null;
  await wait(SETTLE_MS);

  phase = "still";
  show(index, step, "Keep it there, completely still");
  await wait(STILL_MS);

  phase = "twist";
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(logFail("motionProbe: Haptics.notificationAsync"));
  show(index, step, "Twist your wrist back and forth now!");
  await wait(TWIST_MS);

  phase = "after";
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(logFail("motionProbe: Haptics.impactAsync"));
  show(index, step, "Stop. Hold still…");
  const stop = step.source ? await within(ute.setMotionSource(step.source, false, step.intervalMs), CALL_MS) : null;
  await wait(AFTER_MS);
  collecting = false;
  current = null;
  const seconds = (Date.now() - stepStartedAt) / 1000;

  const post = await clipStatus();
  let recoveredMs: number | null = 0;
  if (!post.alive) {
    show(index, step, "The clip stopped answering; waiting for it…");
    const ended = Date.now();
    const back = await waitForClip();
    recoveredMs = back.alive ? Date.now() - ended : null;
  }
  return analyze(step, { pre, post, start, stop, recoveredMs, seconds });
}

// --- Judging a step -----------------------------------------------------------

type Run = {
  pre: ClipCheck & { waitedMs: number };
  post: ClipCheck;
  start: Outcome<void> | null;
  stop: Outcome<void> | null;
  recoveredMs: number | null;
  seconds: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

function analyze(step: Step, run: Run) {
  const inPhase = (p: Phase) => samples.filter((s) => s.phase === p);
  const counts = Object.fromEntries(PHASES.map((p) => [p, inPhase(p).length])) as Record<Phase, number>;
  const still = inPhase("still").map((s) => s.values);
  const twist = inPhase("twist").map((s) => s.values);
  const channels: ChannelScore[] = scoreChannels(step.source, still, twist);
  const best = primaryChannel(channels);
  const packets = tallyPackets(lines);

  const moving = counts.still + counts.twist;
  const total = counts.start + moving;
  const hz = round1(moving / ((STILL_MS + TWIST_MS) / 1000));
  const score = best?.score ?? 0;
  const unsupported = !!run.start && !run.start.ok && /doesn't support/.test(run.start.error);
  const verdict = verdictFor({ unsupported, total, hz, score });
  const breaks =
    (run.pre.alive && !run.post.alive) ||
    (run.post.state === ute.RecordState.FactoryTest && run.pre.state !== ute.RecordState.FactoryTest);
  const firstMs = samples.length ? Math.min(...samples.map((s) => s.ms)) : null;
  const distinct = new Set(samples.map((s) => s.values.join(","))).size;

  const notes: string[] = [];
  if (run.start && !run.start.ok) notes.push(`start: ${run.start.error}`);
  if (!run.pre.alive) notes.push(`the clip wasn't answering before this ran (waited ${Math.round(run.pre.waitedMs / 1000)} s)`);
  else if (run.pre.waitedMs > 4000) notes.push(`the clip took ${Math.round(run.pre.waitedMs / 1000)} s to answer before this ran`);
  if (breaks) notes.push(run.post.alive ? "left the clip in factory-test mode" : "the clip stopped answering");
  if (run.recoveredMs) notes.push(`answered again after ${Math.round(run.recoveredMs / 1000)} s`);
  else if (run.recoveredMs === null) notes.push(`still not answering after ${RECOVER_MS / 1000} s`);
  if (samples.length >= 3 && distinct === 1) notes.push("every reading identical (a stale value?)");
  if (packets.raw.twist > packets.raw.still * 1.5 + 2) notes.push(`more raw packets while twisting (${packets.raw.still} → ${packets.raw.twist})`);
  if (counts.after > 2) notes.push(`${counts.after} readings after stop`);
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
    channel: best?.channel ?? null,
    counts,
    raw: packets.raw,
    firstMs,
    distinct,
    gyroPackets: { on: packets.gyroOn, off: packets.gyroOff },
    recoveredMs: run.recoveredMs,
    note: notes.join("; "),
  };
  const detail = {
    id: step.id,
    source: step.source,
    intervalMs: step.intervalMs,
    commandsPerSecond: commandsPerSecond(step.source, step.intervalMs),
    verdict,
    breaks,
    hz,
    score,
    channel: result.channel,
    counts,
    firstMs,
    distinct,
    start: outcome(run.start),
    stop: outcome(run.stop),
    pre: run.pre,
    post: run.post,
    recoveredMs: run.recoveredMs,
    seconds: round1(run.seconds),
    gyroPackets: result.gyroPackets,
    gsensorPackets: packets.gsensor,
    sent: packets.sent,
    sentKeys: packets.sentKeys,
    raw: packets.raw,
    note: result.note,
    channels: channels.slice(0, 4),
    still: still.slice(0, 5),
    twist: twist.slice(0, 8),
    sentExamples: packets.sentExamples,
    rawKeys: packets.rawKeys,
    rawExamples: packets.rawExamples,
    strays,
    inputs: inputs.slice(0, 6),
  };
  return { result, detail };
}

function summaryLine(r: StepResult) {
  return `${r.verdict}${r.breaks ? " +BREAKS CLIP" : ""} · ${r.hz}/s · score ${r.score}${r.channel ? ` (${r.channel})` : ""}${r.note ? ` · ${r.note}` : ""}`;
}

/** Keeps a row's detail under the server's 4000 characters, dropping the bulkiest parts first. */
function fit(detail: Record<string, unknown>) {
  let text = JSON.stringify(detail);
  for (const key of ["inputs", "strays", "rawExamples", "rawKeys", "twist", "still", "channels", "sentExamples"]) {
    if (text.length <= 3800) break;
    const { [key]: _dropped, ...rest } = detail;
    detail = rest;
    text = JSON.stringify(detail);
  }
  return text;
}
