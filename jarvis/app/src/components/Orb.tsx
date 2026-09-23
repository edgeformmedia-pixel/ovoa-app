import { Canvas, Picture, Skia, createPicture } from "@shopify/react-native-skia";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect } from "react";
import { useDerivedValue, useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";

// The orb: a globe of points, drawn with Skia on the UI thread.
//
// Chosen in the Orb Studio (2026-09-23) as "Particle Globe, fewer particles".
// One shared clock turns it; what it is doing changes how:
//   off        grey, small, barely turning
//   idle       teal, breathing slowly
//   listening  teal, points scatter with the real microphone level
//   thinking   violet, spins up and ripples in bands
//   speaking   violet, the equator swells with each syllable
// Speaking has no level of its own to read (the voice plays from a file), so
// its pulse is a made-up syllable rhythm, which reads as talking.
//
// Everything per frame happens in worklets: nothing here re-renders React
// while it moves.

export type OrbMode = "off" | "idle" | "listening" | "thinking" | "speaking";

const MODE: Record<OrbMode, number> = { off: 0, idle: 1, listening: 2, thinking: 3, speaking: 4 };

/** Fewer than the studio's 520: each point is larger, and the globe reads as dots rather than dust. */
const COUNT = 180;

/** Points spread evenly over a unit sphere (a Fibonacci lattice), plus a phase each. */
const POINTS: number[] = (() => {
  const out: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < COUNT; i++) {
    const y = 1 - (i / (COUNT - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    out.push(Math.cos(th) * r, y, Math.sin(th) * r, (i * 2.399) % (Math.PI * 2));
  }
  return out;
})();

// theme.ts: now, agent, inkMute.
const TEAL = [14, 140, 168];
const VIOLET = [91, 79, 199];
const GREY = [139, 147, 161];

export default function Orb({
  mode,
  level,
  size = 220,
}: {
  mode: OrbMode;
  /** How loud the microphone is, 0 to 1. */
  level: number;
  size?: number;
}) {
  const clock = useSharedValue(0);
  const modeSV = useSharedValue(MODE[mode]);
  const target = useSharedValue(0);
  const loud = useSharedValue(0);
  const speak = useSharedValue(0);
  const warm = useSharedValue(mode === "thinking" || mode === "speaking" ? 1 : 0);
  const lit = useSharedValue(mode === "off" ? 0 : 1);

  useEffect(() => {
    modeSV.value = MODE[mode];
    warm.value = withTiming(mode === "thinking" || mode === "speaking" ? 1 : 0, { duration: 600 });
    lit.value = withTiming(mode === "off" ? 0 : 1, { duration: 500 });
  }, [mode, modeSV, warm, lit]);

  useEffect(() => {
    target.value = mode === "listening" ? level : 0;
  }, [level, mode, target]);

  const frame = useFrameCallback((f) => {
    "worklet";
    const dt = Math.min(0.05, (f.timeSincePreviousFrame ?? 16) / 1000);
    const m = modeSV.value;
    clock.value += dt * (m === 0 ? 0.25 : m === 1 ? 0.6 : m === 3 ? 1.7 : 1.15);
    loud.value += (target.value - loud.value) * 0.18;
    const t = clock.value;
    const syllable = m === 4 ? Math.abs(Math.sin(t * 7.5)) * (0.55 + 0.45 * Math.sin(t * 1.7)) : 0;
    speak.value += (syllable - speak.value) * 0.3;
  });

  // Only while Talk is on screen: the tabs stay mounted, and a globe turning
  // behind another screen is battery spent on nothing.
  useFocusEffect(
    useCallback(() => {
      frame.setActive(true);
      return () => frame.setActive(false);
    }, [frame]),
  );

  const picture = useDerivedValue(() => {
    const t = clock.value;
    const m = modeSV.value;
    const lv = loud.value;
    const sp = speak.value;
    const w = warm.value;
    const on = lit.value;
    const c = size / 2;

    // A colour as Skia takes it, without parsing a string for every point.
    const rgba = (col: number[], a: number) => Float32Array.of(col[0] / 255, col[1] / 255, col[2] / 255, a);
    const mix = (a: number[], b: number[], k: number) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const front = mix(GREY, mix(TEAL, VIOLET, w), on);
    const back = mix(GREY, mix(VIOLET, TEAL, w), on);

    const breathe = m === 1 ? Math.sin(t * 2) * 0.02 : 0;
    const radius = size * (0.3 + on * 0.04 + breathe + lv * 0.05 + sp * 0.035);
    const spin = t * (m === 3 ? 1.1 : 0.4);
    const tilt = 0.38;
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);

    return createPicture(
      (canvas) => {
        // The glow behind it, strongest when it's listening loudly or talking.
        const glow = Skia.Paint();
        const g = 0.1 + on * (0.14 + lv * 0.3 + sp * 0.25);
        glow.setShader(
          Skia.Shader.MakeRadialGradient(
            { x: c, y: c },
            radius * 1.45,
            [rgba(front, g), rgba(front, 0)],
            null,
            0,
          ),
        );
        canvas.drawCircle(c, c, radius * 1.45, glow);

        // Turn, tilt, displace, then draw back to front.
        const projected: number[][] = [];
        for (let i = 0; i < POINTS.length; i += 4) {
          const x = POINTS[i];
          const y = POINTS[i + 1];
          const z = POINTS[i + 2];
          const ph = POINTS[i + 3];
          let d = 1;
          if (m === 2) d += Math.sin(ph + t * 6) * lv * 0.18;
          if (m === 3) d += Math.sin(y * 6 + t * 5) * 0.05;
          if (m === 4) d += Math.abs(y) < 0.35 ? sp * 0.2 : sp * 0.05;
          const X = x * cs - z * sn;
          const Z1 = x * sn + z * cs;
          const Y = y * ct - Z1 * st;
          const Z = y * st + Z1 * ct;
          projected.push([c + X * radius * d, c + Y * radius * d, Z]);
        }
        projected.sort((a, b) => a[2] - b[2]);

        const dot = Skia.Paint();
        dot.setAntiAlias(true);
        for (const [px, py, pz] of projected) {
          const depth = (pz + 1) / 2;
          const col = depth > 0.5 ? front : back;
          const alpha = (0.18 + depth * 0.82) * (0.55 + on * 0.45);
          dot.setColor(rgba(col, alpha));
          canvas.drawCircle(px, py, (1.3 + depth * 2.7) * (size / 220), dot);
        }
      },
      { width: size, height: size },
    );
  });

  return (
    <Canvas style={{ width: size, height: size }}>
      <Picture picture={picture} />
    </Canvas>
  );
}
