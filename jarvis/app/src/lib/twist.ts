import type { MotionSource } from "../../modules/ute-ble";

// "Twist to listen": spots a twist of the wrist in the ES100's motion readings. Pure TypeScript,
// no device code, so it can be tested on its own. See docs/es100-twist-to-listen.md.
//
// The ES100 reports motion slowly (motion probes, 2026-09-19): its gyroscope test about once a
// second, its accelerometer once per session. So there's a detector per kind of sensor, each
// calibrated on the user's own twist:
// - spin (gyroscope, "gyro3"): how fast the wrist turns, |x| + |y| + |z|. The axes saturate on
//   quick moves, so any brisk arm movement reads about as high as a twist; what sets a shake apart
//   is how long it lasts. The user rocks the wrist back and forth for about 4 s: four quick readings
//   out of five in a row fire. A gesture or arm swing is over sooner.
// - tilt (accelerometer, "gsensor…"): how far the wrist has turned from where it rested, read off
//   the gravity vector, around the axis calibration saw the twist turn it (the forearm). A turned
//   wrist stays visible between slow readings. Used only if the accelerometer can be read often.

export type Sample = { t: number; v: number[] };

export type TwistKind = "spin" | "tilt";

/**
 * Gyroscope: four of five readings in a row at `active` or more (never under SHAKE_FLOOR) fire.
 * `quiet` is what a still wrist reads.
 */
export type SpinProfile = { kind: "spin"; quiet: number; active: number };
/** Accelerometer: turning `degrees` or more from rest, around `axis` (a unit vector in the clip's frame), fires. */
export type TiltProfile = { kind: "tilt"; axis: [number, number, number]; degrees: number };
export type TwistProfile = SpinProfile | TiltProfile;
/** What calibration learned, per kind of sensor. */
export type TwistProfiles = { spin?: SpinProfile; tilt?: TiltProfile };
/** A calibration's result, and what the user could do better next time, if anything. */
export type Calibration = { profile: TwistProfile; note: string | null };

/** Which detector a source's readings feed; null for sources twist can't use. */
export function twistKind(source: MotionSource | null | undefined): TwistKind | null {
  if (source === "gyro3" || source === "gyro3read") return "spin";
  if (source?.startsWith("gsensor")) return "tilt";
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

/**
 * `rest`: readings while the wrist was held still; `twists`: one list per window of twisting back
 * and forth (leaving out the user's reaction time after the cue).
 */
export function calibrate(kind: TwistKind, rest: Sample[], twists: Sample[][]): Calibration {
  return kind === "spin" ? calibrateSpin(rest, twists) : { profile: calibrateTilt(rest, twists), note: null };
}

/**
 * Our own buzz can leave the gyroscope test off: after every twist summon's buzz (motor test, option
 * 3) no reading came for 9 s, until the watchdog turned it on again (device_logs 2421-2512). So after
 * a buzz the test is turned on once more, `afterMs` from the buzz's start: always for the factory
 * buzzes (2, 3), about half a second after the motor stops; for "find my device" (1) only when no
 * reading has come by then.
 */
export function motionAfterBuzz(option: 1 | 2 | 3, count: number): { afterMs: number; always: boolean } {
  // The bridge turns the motor (or find-my-device) off 0.25 s per pulse after turning it on.
  const buzzMs = 250 * Math.max(1, count);
  return option === 1 ? { afterMs: Math.max(2500, buzzMs + 1500), always: false } : { afterMs: buzzMs + 500, always: true };
}

/** Streaming detector: feed it every reading, in order. Calls onTwist, with what it saw, when a twist shows. */
export function createTwistDetector(profile: TwistProfile, onTwist: (why: string) => void): (s: Sample) => void {
  return profile.kind === "spin" ? spinDetector(profile, onTwist) : tiltDetector(profile, onTwist);
}

export function describeProfile(p: TwistProfile) {
  return p.kind === "spin"
    ? `gyroscope: a shake is ${SHAKE_HITS} of ${SHAKE_OF} readings in a row at ${shakeLevel(p)}+ (still is ${p.quiet} or less)`
    : `accelerometer: fires on turning ${p.degrees}°+ around the forearm`;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The well-formed profiles in what storage held (an older format is dropped: calibrate again). */
export function readProfiles(value: unknown): TwistProfiles {
  const { spin, tilt } = (value ?? {}) as { spin?: Partial<SpinProfile>; tilt?: Partial<TiltProfile> };
  const out: TwistProfiles = {};
  if (spin?.kind === "spin" && finite(spin.quiet) && finite(spin.active)) out.spin = { kind: "spin", quiet: spin.quiet, active: spin.active };
  const axis = tilt?.axis;
  if (tilt?.kind === "tilt" && finite(tilt.degrees) && Array.isArray(axis) && axis.length === 3 && axis.every(finite)) {
    out.tilt = { kind: "tilt", axis: [axis[0], axis[1], axis[2]], degrees: tilt.degrees };
  }
  return out;
}

// --- Gyroscope ----------------------------------------------------------------

/**
 * A shake: the wrist rocked back and forth for 2-3 s. At a reading a second a quick twist fell between
 * readings too often, and "still, then twist" missed while the user was moving (build 32, 2026-09-19).
 * A shake spans several readings: SHAKE_HITS of the last SHAKE_OF readings are quick, all within
 * SHAKE_MS. Everyday movement gives a single spike, rarely three in a row.
 */
const SHAKE_HITS = 4;
const SHAKE_OF = 5;
const SHAKE_MS = 5500;
/**
 * "Quick" is never below this, whatever calibration saw. At 3 of 4 readings of 130+ every ordinary
 * wrist movement fired (build 33: normal movement reads 270-350), so a shake is now longer and harder.
 */
const SHAKE_FLOOR = 220;
/** After firing, readings are ignored this long: the user is still finishing the shake. */
const SPIN_REFRACTORY_MS = 4000;
/** A still wrist read under about 50 (probe, 2026-09-19); "still" is set from the user's rest, within these bounds. */
const QUIET_MIN = 50;
const QUIET_MAX = 100;
/** A twist window counts when its level clears "still" by this much. */
const STAND_OUT = 30;
/** "Active" stays at least this far above "still". */
const ACTIVE_GAP = 20;

const liveSpins = (samples: Sample[]) => samples.filter((s) => gyroLive(s.v)).map((s) => spinOf(s.v));

/** The resting level, leaving out the biggest readings (one in five, at least one): a single bump doesn't count. */
export function restLevel(spins: number[]) {
  const sorted = [...spins].sort((a, b) => a - b);
  return sorted[sorted.length - 1 - Math.max(1, Math.floor(sorted.length / 5))] ?? sorted[0] ?? 0;
}

/** A twist window's level: what at least half its readings (and at least two) reach. */
export function twistLevel(spins: number[]) {
  const sorted = [...spins].sort((a, b) => b - a);
  return sorted[Math.max(2, Math.ceil(sorted.length / 2)) - 1] ?? 0;
}

/**
 * Calibration from ~5 s of rest and three windows of twisting back and forth. At a reading a second
 * a window can miss most of a twist, so two of the three have to stand out. "Still" comes from the
 * rest (capped: a restless rest still calibrates, with a note); "active" sits under the weakest
 * twist that stood out.
 */
export function calibrateSpin(rest: Sample[], twists: Sample[][]): Calibration {
  const restSpins = liveSpins(rest);
  if (restSpins.length < 3) {
    throw new Error(`Only ${restSpins.length} readings arrived while resting (the clip sends about one a second). Try again.`);
  }
  const resting = restLevel(restSpins);
  const quiet = Math.round(Math.min(QUIET_MAX, Math.max(QUIET_MIN, resting + 20)));
  const levels = twists.map((tw) => twistLevel(liveSpins(tw)));
  const good = levels.filter((level) => level >= quiet + STAND_OUT);
  if (good.length < 2) {
    throw new Error(
      `The twists didn't stand out from resting (still up to ${quiet}; twists reached ${levels.join(", ")}). Twist quicker, back and forth, for the whole 2 seconds.`,
    );
  }
  const active = Math.round(Math.max(0.75 * Math.min(...good), quiet + ACTIVE_GAP));
  const note =
    resting + 20 > QUIET_MAX
      ? `Your wrist moved while resting (readings up to ${Math.max(...restSpins)}), so "still" was capped at ${QUIET_MAX}. For a better fit, rest your forearm on a table and calibrate again.`
      : null;
  return { profile: { kind: "spin", quiet, active }, note };
}

/** How quick a reading has to be to count toward a shake. */
export const shakeLevel = (profile: SpinProfile) => Math.max(profile.active, SHAKE_FLOOR);

function spinDetector(profile: SpinProfile, onTwist: (why: string) => void) {
  const level = shakeLevel(profile);
  let recent: { t: number; spin: number }[] = [];
  let lastFire = -Infinity;
  return (s: Sample) => {
    if (!gyroLive(s.v)) return;
    const spin = spinOf(s.v);
    recent = [...recent.filter((r) => s.t - r.t <= SHAKE_MS), { t: s.t, spin }].slice(-SHAKE_OF);
    if (spin < level || s.t - lastFire < SPIN_REFRACTORY_MS) return;
    const hits = recent.filter((r) => r.spin >= level).length;
    if (hits < SHAKE_HITS) return;
    lastFire = s.t;
    recent = [];
    onTwist(`shake: ${hits} of the last ${SHAKE_OF} readings ${level}+`);
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
