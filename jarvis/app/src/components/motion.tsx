import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  FadeInDown,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { colors } from "../lib/theme";

// How OVOA moves (the Motion Lab, 2026-09-23). Every screen takes its motion
// from here rather than inventing its own, so it all moves the same way:
// springs that settle rather than eases that stop, things rising into place
// rather than appearing, numbers counting to their value. Everything respects
// iOS Reduce Motion: with it on, things are simply there.

/** The one spring. Quick, with a little life at the end. */
export const SPRING = { damping: 15, stiffness: 220, mass: 0.7 } as const;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * A Pressable that sinks under the finger and springs back, instead of fading.
 * `sink` is how far: 0.96 for a card, 0.93 for a small button.
 */
export function PressScale({
  sink = 0.96,
  style,
  children,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, "style" | "children"> & {
  sink?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const scale = useSharedValue(1);
  const reduce = useReducedMotion();
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        if (!reduce) scale.value = withSpring(sink, { damping: 20, stiffness: 400 });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, SPRING);
        onPressOut?.(e);
      }}
      style={[style, animated, rest.disabled && { opacity: 0.4 }]}
    >
      {children}
    </AnimatedPressable>
  );
}

/**
 * Rises into place when it first appears. `index` staggers a list: each row a
 * few hundredths of a second after the one above, so a screen cascades in.
 */
export function Rise({ index = 0, children, style }: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index, 12) * 45).springify().damping(16).stiffness(180)} style={style}>
      {children}
    </Animated.View>
  );
}

/**
 * A number that counts up to its value, easing to a stop, when it first shows
 * and whenever it changes. Driven from JS: it's a handful of numbers for a
 * second and a half, and text can't be animated on the UI thread without a
 * TextInput trick.
 */
export function CountUp({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  duration = 1200,
  style,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  style?: StyleProp<TextStyle>;
}) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(reduce ? value : 0);
  useEffect(() => {
    if (reduce) {
      setShown(value);
      return;
    }
    const start = from.current;
    const began = Date.now();
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (Date.now() - began) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      const now = start + (value - start) * eased;
      setShown(now);
      from.current = now;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduce]);
  return <Text style={style}>{format(shown)}</Text>;
}

/** A shape where something is still loading: a soft pulse rather than a spinner. */
export function Skeleton({ width = "100%", height = 12, radius = 8, style }: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const glow = useSharedValue(0.45);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) return;
    glow.value = withRepeat(withSequence(withTiming(1, { duration: 700 }), withTiming(0.45, { duration: 700 })), -1);
  }, [glow, reduce]);
  const animated = useAnimatedStyle(() => ({ opacity: glow.value }));
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: colors.wash2 }, animated, style]} />;
}

/** Several skeleton rows in the shape of a list: a short line and a longer one, like a time and a title. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <View style={{ gap: 18, paddingVertical: 8 }}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
          <Skeleton width={44} height={12} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width={`${[62, 48, 70, 55][i % 4]}%`} height={13} />
            <Skeleton width={`${[34, 40, 28, 38][i % 4]}%`} height={10} />
          </View>
        </View>
      ))}
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** A ring that sweeps round to `progress` (0 to 1) when it appears or changes. */
export function Ring({
  progress,
  size = 120,
  stroke = 12,
  color = colors.now,
  delay = 0,
  children,
}: {
  progress: number;
  size?: number;
  stroke?: number;
  color?: string;
  delay?: number;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const around = 2 * Math.PI * r;
  const shown = useSharedValue(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const to = Math.max(0, Math.min(1, progress));
    shown.value = reduce ? to : withDelay(delay, withTiming(to, { duration: 1400, easing: Easing.bezier(0.32, 0.72, 0, 1) }));
  }, [progress, delay, reduce, shown]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: around * (1 - shown.value) }));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={[StyleSheet.absoluteFill, { transform: [{ rotate: "-90deg" }] }]}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.wash2} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${around} ${around}`}
          animatedProps={props}
        />
      </Svg>
      {children}
    </View>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * A line through `values` that draws itself from left to right, with the area
 * under it fading up behind and the latest point pulsing gently.
 */
export function DrawnLine({
  values,
  width,
  height,
  color = colors.stop,
  wash = colors.stopWash,
}: {
  values: number[];
  width: number;
  height: number;
  color?: string;
  wash?: string;
}) {
  const reduce = useReducedMotion();
  const drawn = useSharedValue(reduce ? 1 : 0);
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    drawn.value = 0;
    drawn.value = withTiming(1, { duration: 1500, easing: Easing.bezier(0.45, 0, 0.2, 1) });
    pulse.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }), -1);
  }, [values.length, reduce, drawn, pulse]);

  const pad = 5;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(1, hi - lo);
  const x = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(values.length - 1)},${height} L${x(0)},${height} Z`;
  // Long enough to cover the path however jagged; the dash trick only needs an upper bound.
  const length = width * 3;

  const lineProps = useAnimatedProps(() => ({ strokeDashoffset: length * (1 - drawn.value) }));
  const areaStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, drawn.value - 0.5) * 2 }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: 0.45 * (1 - pulse.value) * drawn.value, transform: [{ scale: 1 + pulse.value * 2.2 }] }));
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]);

  return (
    <View style={{ width, height }}>
      <Animated.View style={[StyleSheet.absoluteFill, areaStyle]}>
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="under" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={wash} stopOpacity={1} />
              <Stop offset="1" stopColor={wash} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Path d={area} fill="url(#under)" />
        </Svg>
      </Animated.View>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <AnimatedPath
          d={line}
          stroke={color}
          strokeWidth={2.2}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${length} ${length}`}
          animatedProps={lineProps}
        />
        <Circle cx={lastX} cy={lastY} r={3.5} fill={color} />
      </Svg>
      <Animated.View
        pointerEvents="none"
        style={[{ position: "absolute", left: lastX - 4, top: lastY - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: color }, ringStyle]}
      />
    </View>
  );
}

/**
 * Words that arrive one at a time, each fading up into place, for text that
 * grows as it's heard (what you're saying, on Talk). A word already shown is
 * never animated again; only new ones come in.
 */
export function WordsIn({ text, style, maxLines = 4 }: { text: string; style: StyleProp<TextStyle>; maxLines?: number }) {
  const words = text.split(/\s+/).filter(Boolean);
  const flat = StyleSheet.flatten(style) ?? {};
  const line = typeof flat.lineHeight === "number" ? flat.lineHeight : 23;
  return (
    <View style={[styles.words, { minHeight: line * 2, maxHeight: line * maxLines, maxWidth: flat.maxWidth ?? 320 }]}>
      {words.map((w, i) => (
        <Animated.Text key={i} entering={FadeInDown.duration(260)} style={[style, styles.word]}>
          {w}
        </Animated.Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  words: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", overflow: "hidden", columnGap: 5 },
  word: { minHeight: 0, maxWidth: undefined, textAlign: "center" },
});
