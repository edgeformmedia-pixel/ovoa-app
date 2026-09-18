// Detects the classic fall signature from accelerometer samples (in g):
// a moment of free fall, a hard impact soon after, then the person lying still.

const FREE_FALL_G = 0.4;
const FREE_FALL_MIN_MS = 60;
const IMPACT_G = 2.5;
const IMPACT_WINDOW_MS = 1000;
const STILL_DELAY_MS = 1000; // let the bounce settle
const STILL_WINDOW_MS = 1500;
const STILL_TOLERANCE_G = 0.3;
const STILL_RATIO = 0.8;
const COOLDOWN_MS = 30_000;

type Sample = { x: number; y: number; z: number };

export function createFallDetector(onFall: () => void) {
  let freeFallStart: number | null = null;
  let freeFallEnd: number | null = null;
  let impactAt: number | null = null;
  let stillSamples = 0;
  let totalSamples = 0;
  let lastFallAt = -Infinity;

  const reset = () => {
    freeFallStart = freeFallEnd = impactAt = null;
    stillSamples = totalSamples = 0;
  };

  return (s: Sample, now: number) => {
    if (now - lastFallAt < COOLDOWN_MS) return;
    const g = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);

    if (impactAt !== null) {
      const since = now - impactAt;
      if (since < STILL_DELAY_MS) return;
      totalSamples++;
      if (Math.abs(g - 1) < STILL_TOLERANCE_G) stillSamples++;
      if (since >= STILL_DELAY_MS + STILL_WINDOW_MS) {
        const lyingStill = totalSamples > 0 && stillSamples / totalSamples >= STILL_RATIO;
        reset();
        if (lyingStill) {
          lastFallAt = now;
          onFall();
        }
      }
      return;
    }

    if (g < FREE_FALL_G) {
      freeFallStart ??= now;
      freeFallEnd = null;
      return;
    }

    if (freeFallStart !== null && freeFallEnd === null) {
      if (now - freeFallStart >= FREE_FALL_MIN_MS) freeFallEnd = now;
      else freeFallStart = null; // too brief to be a fall
    }

    if (freeFallEnd !== null) {
      if (g > IMPACT_G) impactAt = now;
      else if (now - freeFallEnd > IMPACT_WINDOW_MS) reset();
    }
  };
}
