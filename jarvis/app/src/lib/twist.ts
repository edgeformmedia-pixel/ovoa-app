// "Twist to listen": spots a quick counter-clockwise flick of the wrist in the
// ES100's motion stream. Pure TypeScript, no device code, so it can be tested
// on its own. See docs/es100-twist-to-listen.md.
//
// The clip can be worn many ways, so calibration learns which value and which
// direction a counter-clockwise twist moves; detection then watches for a fast
// swing on that value that comes back (a flick, not a change of pose).

export type TwistProfile = { axis: number; sign: 1 | -1; threshold: number };

export type Sample = { t: number; v: number[] };

/** Every value in a motion-stream sample: x, y, speed, xThrow, yThrow, speedThrow. */
export const MOTION_AXES = [0, 1, 2, 3, 4, 5];

const RETURN_MS = 700; // the swing must come back within this long
const REFRACTORY_MS = 2000; // ignore the next 2 s after firing
const BASELINE_ALPHA = 0.02;
const MIN_SCORE = 4; // a twist must stand this many times above the resting noise

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

/** Calibration: ~3 s of stillness, then 3 twists. Picks the value and direction with the largest twist-vs-rest swing. */
export function calibrate(rest: Sample[], twists: Sample[][], axes = MOTION_AXES): TwistProfile {
  if (rest.length < 5) throw new Error("No motion data arrived while resting. Is the motion stream on?");
  if (twists.some((tw) => tw.length === 0)) throw new Error("No motion data arrived during a twist.");
  let best = { axis: axes[0], sign: 1 as 1 | -1, score: 0, peak: 0 };
  for (const axis of axes) {
    const restVals = rest.map((s) => s.v[axis] ?? 0);
    const mean = restVals.reduce((a, b) => a + b, 0) / restVals.length;
    const noise = Math.sqrt(restVals.reduce((a, b) => a + (b - mean) ** 2, 0) / restVals.length) || 1;
    // The signed peak deviation in each twist; all of them must agree on the direction.
    const peaks = twists.map((tw) => {
      const devs = tw.map((s) => (s.v[axis] ?? 0) - mean);
      const max = Math.max(...devs);
      const min = Math.min(...devs);
      return Math.abs(max) >= Math.abs(min) ? max : min;
    });
    const sameSign = peaks.every((p) => p !== 0 && Math.sign(p) === Math.sign(peaks[0]));
    const minPeak = Math.min(...peaks.map(Math.abs));
    const score = sameSign ? minPeak / noise : 0;
    if (score > best.score) best = { axis, sign: Math.sign(peaks[0]) as 1 | -1, score, peak: minPeak };
  }
  if (best.score < MIN_SCORE) throw new Error("The twist didn't stand out from resting. Try a sharper flick.");
  return { axis: best.axis, sign: best.sign, threshold: best.peak * 0.6 };
}

/** Streaming detector. Feed every sample; calls onTwist at most once per REFRACTORY_MS. */
export function createTwistDetector(profile: TwistProfile, onTwist: () => void) {
  let baseline: number | null = null;
  let armedAt: number | null = null; // when the swing crossed the threshold
  let lastFire = -Infinity;

  return (s: Sample) => {
    const raw = s.v[profile.axis] ?? 0;
    if (baseline === null) baseline = raw;
    const d = profile.sign * (raw - baseline);

    // The baseline only follows while no swing is in progress, so a twist doesn't drag it along.
    if (armedAt === null) baseline += BASELINE_ALPHA * (raw - baseline);

    if (s.t - lastFire < REFRACTORY_MS) return;

    if (armedAt === null) {
      if (d > profile.threshold) armedAt = s.t; // counter-clockwise swing started
      return;
    }
    if (s.t - armedAt > RETURN_MS) {
      armedAt = null; // held too long: a pose change, not a flick
      return;
    }
    if (d < profile.threshold / 3) {
      armedAt = null;
      lastFire = s.t;
      onTwist();
    }
  };
}
