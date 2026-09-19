import type { MotionSource } from "../../modules/ute-ble";
import { gyroLive, restLevel, spinOf, twistKind, twistLevel } from "./twist";

// Judging a motion probe step (lib/motionProbe.ts). Pure, so it can be checked against logged runs.

export type Phase = "start" | "still" | "twist" | "after";
export const PHASES: Phase[] = ["start", "still", "twist", "after"];

export type Verdict = "WIN" | "FLAT" | "SLOW" | "ONE-SHOT" | "SILENT" | "SKIPPED";

/** Readings a second (while still and twisting) a source needs: the ES100's gyroscope manages about 1. */
export const MIN_HZ = 0.6;
/** How far twisting has to move a value, over how much it wanders at rest, to count as a clear signal. */
export const MIN_SCORE = 3;

export type ChannelScore = {
  /** A value's index in the sample, or "spin" / "tilt" (see scoreChannels). */
  channel: string;
  score: number;
  still: [number, number] | null;
  twist: [number, number] | null;
};

type Vec = [number, number, number];
const unit = (v: number[]): Vec | null => {
  const n = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  return n > 1e-9 ? [(v[0] ?? 0) / n, (v[1] ?? 0) / n, (v[2] ?? 0) / n] : null;
};
const degreesBetween = (a: Vec, b: Vec) =>
  (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const span = (values: number[]): [number, number] | null => (values.length ? [Math.min(...values), Math.max(...values)] : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Per value: how far twisting moves it, over how much it wanders at rest (the values are signed:
 * the bridge decodes them). Besides the raw values, a gyroscope source gets "spin" (|x|+|y|+|z| of
 * the readings with data) and an accelerometer source "tilt" (degrees from where gravity pointed at
 * rest): what the twist detectors watch. Spin is judged like the detector judges it: the level half
 * the twisting readings reach, over the resting level (a single bump while still doesn't count).
 * Best first.
 */
export function scoreChannels(source: MotionSource | null, still: number[][], twist: number[][]): ChannelScore[] {
  const channels: { channel: string; still: number[]; twist: number[]; score?: number }[] = [];
  const width = Math.max(0, ...still.map((v) => v.length), ...twist.map((v) => v.length));
  for (let c = 0; c < width; c++) {
    channels.push({
      channel: String(c),
      still: still.map((v) => v[c]).filter(Number.isFinite),
      twist: twist.map((v) => v[c]).filter(Number.isFinite),
    });
  }
  const kind = twistKind(source);
  if (kind === "spin") {
    const s = still.filter(gyroLive).map(spinOf);
    const t = twist.filter(gyroLive).map(spinOf);
    const score = s.length && t.length ? twistLevel(t) / Math.max(restLevel(s), 25) : undefined;
    channels.push({ channel: "spin", still: s, twist: t, score });
  } else if (kind === "tilt") {
    const dirs = (vs: number[][]) => vs.map(unit).filter((d): d is Vec => d !== null);
    const rest = dirs(still.length ? still : twist.slice(0, 1));
    const g0 = unit(rest.reduce<number[]>((sum, d) => [sum[0] + d[0], sum[1] + d[1], sum[2] + d[2]], [0, 0, 0]));
    if (g0) {
      channels.push({
        channel: "tilt",
        still: dirs(still).map((d) => degreesBetween(g0, d)),
        twist: dirs(twist).map((d) => degreesBetween(g0, d)),
      });
    }
  }

  const scores = channels.flatMap(({ channel, still: s, twist: t, score }) => {
    const twistSpan = span(t);
    if (!twistSpan) return [];
    if (score !== undefined) return [{ channel, score: round1(score), still: span(s), twist: twistSpan }];
    const noise = s.length >= 2 ? Math.max(...s) - Math.min(...s) : 0;
    const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    const swing = Math.max(twistSpan[1] - twistSpan[0], mean === null ? 0 : Math.max(...t.map((v) => Math.abs(v - mean))));
    return [{ channel, score: round1(swing / Math.max(noise, 1)), still: span(s), twist: twistSpan }];
  });
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * The channel a step is judged on: what twist's detector would watch for this source (spin or
 * tilt), otherwise the best-scoring value. With a handful of readings a raw axis can outscore it by
 * chance, and that axis isn't what detects a twist.
 */
export function primaryChannel(scores: ChannelScore[]) {
  return scores.find((c) => c.channel === "spin" || c.channel === "tilt") ?? scores[0] ?? null;
}

export function verdictFor(o: { unsupported: boolean; total: number; hz: number; score: number }): Verdict {
  if (o.unsupported) return "SKIPPED";
  if (o.total === 0) return "SILENT";
  if (o.total <= 2) return "ONE-SHOT";
  if (o.hz < MIN_HZ) return "SLOW";
  if (o.score < MIN_SCORE) return "FLAT";
  return "WIN";
}

/**
 * Commands a second a source costs the clip: the gyroscope test none after its "on"; reading it on
 * request one per interval; the g-sensor one or two per interval.
 */
export function commandsPerSecond(source: MotionSource | null, intervalMs: number) {
  if (!source || source === "gyro3" || source === "gsensorOnce" || intervalMs <= 0) return 0;
  const perInterval = source === "gsensorToggle" || source === "gsensorGap" || source === "gsensorPing" ? 2 : 1;
  return round1((perInterval * 1000) / intervalMs);
}

export type Candidate = {
  verdict: Verdict;
  breaks: boolean;
  source: MotionSource | null;
  intervalMs: number;
  hz: number;
  score: number;
};

/**
 * What twist should use: a WIN that didn't break the clip, from a source twist can use at that rate
 * (`usable` also caps the commands a second). The accelerometer goes first once it reads about once
 * a second (a turned wrist stays visible between readings); then, for the gyroscope, the more
 * readings a second, in steps of about 1, 2 and 3+ (it only sees a twist while it happens); then
 * the fewest commands (the clip froze under many); then the clearest signal.
 */
export function pickWinner<T extends Candidate>(results: T[], usable: (source: MotionSource, intervalMs: number) => boolean): T | null {
  const wins = results.filter((r) => r.verdict === "WIN" && !r.breaks && r.source && usable(r.source, r.intervalMs));
  const rank = (r: T) => (twistKind(r.source) === "tilt" && r.hz >= 0.9 ? 1 : 0);
  const rate = (r: T) => (twistKind(r.source) !== "spin" ? 0 : r.hz >= 2.5 ? 2 : r.hz >= 1.6 ? 1 : 0);
  wins.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      rate(b) - rate(a) ||
      commandsPerSecond(a.source, a.intervalMs) - commandsPerSecond(b.source, b.intervalMs) ||
      b.score - a.score,
  );
  return wins[0] ?? null;
}

/** A packet from the clip as the SDK logs it: "CMD:App receive lenght=14,30000b01…". */
export const RAW_PACKET = /receive\s+len\w*=(\d+),([0-9a-f]+)/i;
/** A command to the clip as the SDK logs it: "CMD:App send 01c2ab0a0100" (or "SDK send pair …"). */
export const SENT_PACKET = /\bsend\s+(?:pair\s+)?(?:len\w*=\d+,)?([0-9a-f]{4,})/i;

export type PacketTally = {
  /** Packets from the clip, per phase, and by their first 3 bytes (the command). */
  raw: Record<Phase, number>;
  rawKeys: Partial<Record<Phase, Record<string, number>>>;
  rawExamples: string[];
  /** Gyroscope test packets (30000b) by their state byte: 1 on (with data), 0 off (zeros). */
  gyroOn: number;
  gyroOff: number;
  /** G-sensor test packets (300014). */
  gsensor: number;
  /** Commands the app sent, by their first 3 bytes, and the first few in full. */
  sent: number;
  sentKeys: Record<string, number>;
  sentExamples: string[];
};

export function tallyPackets(lines: { phase: Phase; line: string }[]): PacketTally {
  const tally: PacketTally = {
    raw: { start: 0, still: 0, twist: 0, after: 0 },
    rawKeys: {},
    rawExamples: [],
    gyroOn: 0,
    gyroOff: 0,
    gsensor: 0,
    sent: 0,
    sentKeys: {},
    sentExamples: [],
  };
  const seen = new Set<string>();
  for (const { phase, line } of lines) {
    const packet = RAW_PACKET.exec(line);
    if (packet) {
      const hex = packet[2].toLowerCase();
      const key = hex.slice(0, 6);
      tally.raw[phase]++;
      const keys = (tally.rawKeys[phase] = tally.rawKeys[phase] ?? {});
      keys[key] = (keys[key] ?? 0) + 1;
      if (key === "30000b") {
        if (hex.slice(6, 8) === "00") tally.gyroOff++;
        else tally.gyroOn++;
      }
      if (key === "300014") tally.gsensor++;
      if (!seen.has(key) && tally.rawExamples.length < 8) {
        seen.add(key);
        tally.rawExamples.push(`${phase}: ${hex.slice(0, 80)}`);
      }
      continue;
    }
    const sent = SENT_PACKET.exec(line);
    if (sent) {
      const hex = sent[1].toLowerCase();
      tally.sent++;
      tally.sentKeys[hex.slice(0, 6)] = (tally.sentKeys[hex.slice(0, 6)] ?? 0) + 1;
      if (tally.sentExamples.length < 6 && !tally.sentExamples.some((e) => e.endsWith(hex.slice(0, 40)))) {
        tally.sentExamples.push(`${phase}: ${hex.slice(0, 40)}`);
      }
    }
  }
  return tally;
}
