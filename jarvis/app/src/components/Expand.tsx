import { useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSpring, withTiming } from "react-native-reanimated";
import type { SpotRect } from "../lib/drawer";
import { SPRING } from "./motion";

// A card that opens into its app: a panel in the card's colour grows from where
// the card is to fill the screen, the app is opened underneath it, and the panel
// fades away to show it. The screen change itself is a plain navigation; this
// is what makes it look like the card became the screen.
//
// One overlay for the whole app (mounted in app/_layout.tsx), asked to play by
// expandFrom().

type Request = { from: SpotRect; color: string; then: () => void };
let play: ((r: Request) => void) | null = null;

/** Grows `color` from `from` to the whole screen, calls `then` once it covers it, then clears. */
export function expandFrom(from: SpotRect | null, color: string, then: () => void) {
  if (!from || !play) return then();
  play({ from, color, then });
}

export function ExpandOverlay() {
  const { width: W, height: H } = useWindowDimensions();
  const reduce = useReducedMotion();
  const [color, setColor] = useState("transparent");
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const w = useSharedValue(0);
  const h = useSharedValue(0);
  const r = useSharedValue(20);
  const shown = useSharedValue(0);

  useEffect(() => {
    play = ({ from, color: c, then }) => {
      if (reduce) return then();
      setColor(c);
      x.value = from.x;
      y.value = from.y;
      w.value = from.width;
      h.value = from.height;
      r.value = 20;
      shown.value = 1;
      x.value = withSpring(0, SPRING);
      y.value = withSpring(0, SPRING);
      w.value = withSpring(W, SPRING);
      h.value = withSpring(H, SPRING);
      r.value = withSpring(0, SPRING);
      // Open the app once the panel has all but filled the screen, then let it
      // fade away to show it.
      setTimeout(then, 260);
      shown.value = withDelay(420, withTiming(0, { duration: 260 }, () => runOnJS(setColor)("transparent")));
    };
    return () => {
      play = null;
    };
  }, [W, H, reduce, x, y, w, h, r, shown]);

  const style = useAnimatedStyle(() => ({
    left: x.value,
    top: y.value,
    width: w.value,
    height: h.value,
    borderRadius: r.value,
    opacity: shown.value,
  }));

  return <Animated.View pointerEvents="none" style={[styles.panel, { backgroundColor: color }, style]} />;
}

const styles = StyleSheet.create({
  panel: { position: "absolute", zIndex: 15 },
});
