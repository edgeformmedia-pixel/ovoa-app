import type { MotionSource } from "../../modules/ute-ble";

// "Twist to listen": spots a twist of the wrist in the ES100's motion readings. Pure TypeScript,
// no device code, so it can be tested on its own. See docs/es100-twist-to-listen.md.
//
// The ES100 reports motion slowly (motion probe, 2026-09-19): its gyroscope test about once a
// second, its accelerometer one reading per request. So there's a detector per kind of sensor,
// each calibrated on the user's own twist:
// - spin (gyroscope, "gyro3"): how fast the wrist turns, |x| + |y| + |z|. A reading only catches a
//   twist while it's happening, so the user twists back and forth for a second or two; one big
//   reading, or two fairly big ones close together, fires.
// - tilt (accelerometer, "gsensor…"): how far the wrist has turned from where it rested, read off
//   the gravity vector, around the axis calibration saw the twist turn it (the forearm). A turned
//   wrist stays visible between slow readings.

export type Sample = { t: number; v: number[] };

export type TwistKind = "spin" | "tilt";

/** Gyroscope: one reading of `high` or more fires, or two of `low` or more within PAIR_MS. */
export type SpinProfile = { kind: "spin"; high: number; low: number };
/** Accelerometer: turning `degrees` or more from rest, around `axis` (a unit vector in the clip's frame), fires. */
export type TiltProfile = { kind: "tilt"; axis: [number, number, number]; degrees: number };
export type TwistProfile = SpinProfile | TiltProfile;
/** What calibration learned, per kind of sensor. */
export type TwistProfiles = { spin?: SpinProfile; tilt?: TiltProfile };

/** Which detector a source's readings feed; null for sources twist can't use. */
export function twistKind(source: MotionSource | null | undefined): TwistKind | null {
  if (source === "gyro3") return "spin";
  if (source === "gsensor" || source === "gsensorToggle" || source === "gsensorGap" || source === "gsensorOnce") return "tilt";
  return null;
}

/** A gyroscope reading that carries data: while the test is off the clip sends state 0 and zeros. */
export const gyroLive = (v: number[]) => v[3] !== 0 || v[0] !== 0 || v[1] !== 0 || v[2] !== 0;

/** How fast the wrist is turning, from one gyroscope reading. */
export const spinOf = (v: number[]) => Math.abs(v[0] ?? 0) + Math.abs(v[1] ?? 0) + Math.abs(v[2] ?? 0);

/**
 * The phone only knows when a batch arrived, so spread its samples evenly
 * between the previous batch and this one: t_i = prevT + (t - prevT) * (i + 1) / n.
 */
export function spreadBatch(prevT: number | null, t: number, values: number[][]): Sample[] {
  const n = values.length;
  // First batch (or a long gap): assume ~40 ms between samples.
  const from = prevT === null || t - prevT > 2000 ? t - 40 * n : prevT;
  return values.map((v, i) => ({ t: from + ((t - from) * (i + 1)) / n, v }));
}

export function calibrate(kind: TwistKind, rest: Sample[], twists: Sample[][]): TwistProfile {
  return kind === "spin" ? calibrateSpin(rest, twists) : calibrateTilt(rest, twists);
}

/** Streaming detector: feed it every reading, in order. Calls onTwist, with what it saw, when a twist shows. */
export function createTwistDetector(profile: TwistProfile, onTwist: (why: string) => void): (s: Sample) => void {
  return profile.kind === "spin" ? spinDetector(profile, onTwist) : tiltDetector(profile, onTwist);
}

export function describeProfile(p: TwistProfile) {
  return p.kind === "spin"
    ? `gyroscope: fires on a reading of ${p.high}+, or two of ${p.low}+ within ${PAIR_MS / 1000} s`
    : `accelerometer: fires on turning ${p.degrees}°+ around the forearm`;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The well-formed profiles in what storage held (an older format is dropped: calibrate again). */
export function readProfiles(value: unknown): TwistProfiles {
  const { spin, tilt } = (value ?? {}) as { spin?: Partial<SpinProfile>; tilt?: Partial<TiltProfile> };
  const out: TwistProfiles = {};
  if (spin?.kind === "spin" && finite(spin.high) && finite(spin.low)) out.spin = { kind: "spin", high: spin.high, low: spin.low };
  const axis = tilt?.axis;
  if (tilt?.kind === "tilt" && finite(tilt.degrees) && Array.isArray(axis) && axis.length === 3 && axis.every(finite)) {
    out.tilt = { kind: "tilt", axis: [axis[0], axis[1], axis[2]], degrees: tilt.degrees };
  }
  return out;
}

// --- Gyroscope ----------------------------------------------------------------

/** Two readings of `low` or more this close together also fire: at a reading a second, a 2 s twist gives two. */
const PAIR_MS = 3000;
/** After firing, readings are ignored this long: the user is still finishing the twist. */
const SPIN_REFRACTORY_MS = 4000;
const MIN_HIGH = 80;
const MIN_LOW = 60;

/**
 * Calibration from ~6 s of rest and three ~3 s windows of twisting back and forth. At a reading a
 * second a window can miss the twist altogether, so two of the three have to stand out from rest.
 * The thresholds sit between the busiest resting reading and the weakest twist that stood out.
 */
export function calibrateSpin(rest: Sample[], twists: Sample[][]): SpinProfile {
  const restSpins = rest.filter((s) => gyroLive(s.v)).map((s) => spinOf(s.v));
  if (restSpins.length < 3) {
    throw new Error(`Only ${restSpins.length} readings arrived while resting (the clip sends about one a second). Try again.`);
  }
  const restMax = Math.max(...restSpins);
  const standOut = restMax * 1.3 + 15;
  const peaks = twists.map((tw) => Math.max(0, ...tw.filter((s) => gyroLive(s.v)).map((s) => spinOf(s.v))));
  const good = peaks.filter((p) => p >= standOut);
  if (good.length < 2) {
    throw new Error(
      `The twists didn't stand out from resting (rest up to ${restMax}, twists ${peaks.join(", ")}). Hold still while resting, and twist quicker.`,
    );
  }
  const weakest = Math.min(...good);
  const high = Math.round(Math.max(restMax + 0.7 * (weakest - restMax), standOut, MIN_HIGH));
  const low = Math.round(Math.min(high - 10, Math.max(restMax + 0.4 * (weakest - restMax), restMax + 10, MIN_LOW)));
  return { kind: "spin", high, low };
}

function spinDetector(profile: SpinProfile, onTwist: (why: string) => void) {
  let lastFire = -Infinity;
  let recent: number[] = []; // when the last readings of `low` or more came
  return (s: Sample) => {
    if (!gyroLive(s.v) || s.t - lastFire < SPIN_REFRACTORY_MS) return;
    const spin = spinOf(s.v);
    if (spin < profile.low) return;
    recent = [...recent.filter((t) => s.t - t < PAIR_MS), s.t];
    if (spin < profile.high && recent.length < 2) return;
    lastFire = s.t;
    recent = [];
    onTwist(spin >= profile.high ? `spin ${spin} ≥ ${profile.high}` : `two readings ≥ ${profile.low} within ${PAIR_MS / 1000} s`);
  };
}

// --- Accelerometer ------------------------------------------------------------

type Vec = [number, number, number];

/** How quickly "where the wrist rests" follows a new pose; a twist is quicker than this. */
const TILT_FOLLOW_MS = 4000;
/** After a gap this long, where the wrist rests is read afresh. */
const TILT_GAP_MS = 10_000;
const TILT_REFRACTORY_MS = 3000;
/** How closely a turn has to match the calibrated axis, as a cosine (0.5 = within 60°). */
const AXIS_MATCH = 0.5;
/** How closely calibration's twists have to agree on their axis (0.8 = within about 37°). */
const AXIS_AGREE = 0.8;
const MIN_DEGREES = 15;

const vec = (v: number[]): Vec => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function unit(v: Vec): Vec | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** The angle between two unit vectors, in degrees. */
const degreesBetween = (a: Vec, b: Vec) => (Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * 180) / Math.PI;

/**
 * Calibration: the resting readings give where gravity points with the wrist still; in each twist
 * window, the reading furthest from that gives how far, and around which axis, the twist turned the
 * clip. Two of the three have to turn it clearly, around about the same axis.
 */
export function calibrateTilt(rest: Sample[], twists: Sample[][]): TiltProfile {
  const restDirs = rest.map((s) => unit(vec(s.v))).filter((d): d is Vec => d !== null);
  if (restDirs.length < 3) throw new Error(`Only ${restDirs.length} readings arrived while resting. Try again.`);
  const g0 = unit(restDirs.reduce<Vec>((sum, d) => [sum[0] + d[0], sum[1] + d[1], sum[2] + d[2]], [0, 0, 0]));
  if (!g0) throw new Error("The resting readings pointed every way. Hold still and try again.");
  const restNoise = Math.max(...restDirs.map((d) => degreesBetween(g0, d)));
  const standOut = Math.max(restNoise * 3, 20);

  const turns = twists.map((tw) => {
    let best: { deg: number; axis: Vec | null } = { deg: 0, axis: null };
    for (const s of tw) {
      const d = unit(vec(s.v));
      if (!d) continue;
      const deg = degreesBetween(g0, d);
      if (deg > best.deg) best = { deg, axis: unit(cross(g0, d)) };
    }
    return best;
  });
  const good = turns.filter((t): t is { deg: number; axis: Vec } => t.axis !== null && t.deg >= standOut);
  if (good.length < 2) {
    throw new Error(
      `The twists didn't turn the clip enough (resting wobble ${Math.round(restNoise)}°, twists ${turns.map((t) => `${Math.round(t.deg)}°`).join(", ")}). Twist further.`,
    );
  }
  // The largest group of twists around about the same axis (back and forth turns it both ways, so
  // the sign doesn't matter) sets the axis; a twist that went another way is left out.
  let agreeing: { deg: number; axis: Vec }[] = [];
  for (const ref of good) {
    const group = good
      .filter((t) => Math.abs(dot(t.axis, ref.axis)) >= AXIS_AGREE)
      .map((t) => ({ deg: t.deg, axis: dot(t.axis, ref.axis) < 0 ? ([-t.axis[0], -t.axis[1], -t.axis[2]] as Vec) : t.axis }));
    if (group.length > agreeing.length) agreeing = group;
  }
  const axis = unit(agreeing.reduce<Vec>((sum, t) => [sum[0] + t.axis[0], sum[1] + t.axis[1], sum[2] + t.axis[2]], [0, 0, 0]));
  if (agreeing.length < 2 || !axis) {
    throw new Error("Each twist turned the clip a different way. Twist around your forearm, the same way each time.");
  }
  const weakest = Math.min(...agreeing.map((t) => t.deg));
  const degrees = Math.round(Math.max(weakest * 0.6, restNoise * 2 + 5, MIN_DEGREES));
  const round = (c: number) => Math.round(c * 1000) / 1000;
  return { kind: "tilt", axis: [round(axis[0]), round(axis[1]), round(axis[2])], degrees };
}

function tiltDetector(profile: TiltProfile, onTwist: (why: string) => void) {
  const twistAxis = unit(profile.axis) ?? profile.axis;
  let rest: Vec | null = null;
  let lastT = 0;
  let lastFire = -Infinity;
  return (s: Sample) => {
    const d = unit(vec(s.v));
    if (!d) return;
    if (!rest || s.t - lastT > TILT_GAP_MS) {
      rest = d;
      lastT = s.t;
      return;
    }
    const deg = degreesBetween(rest, d);
    const axis = unit(cross(rest, d));
    if (deg >= profile.degrees && axis && Math.abs(dot(axis, twistAxis)) >= AXIS_MATCH && s.t - lastFire >= TILT_REFRACTORY_MS) {
      lastFire = s.t;
      onTwist(`turned ${Math.round(deg)}° ≥ ${profile.degrees}°`);
    }
    // Follow a new pose over a few seconds.
    const k = 1 - Math.exp(-(s.t - lastT) / TILT_FOLLOW_MS);
    lastT = s.t;
    rest = unit([rest[0] + k * (d[0] - rest[0]), rest[1] + k * (d[1] - rest[1]), rest[2] + k * (d[2] - rest[2])]) ?? rest;
  };
}
