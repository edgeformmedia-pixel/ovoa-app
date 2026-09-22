import Ionicons from "@expo/vector-icons/Ionicons";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, mono, numeric, space, type } from "../lib/theme";

// One day, one spine. Time is the structure — a mono time column, a rail, and
// one line per moment — rather than a stack of cards that all look alike.
//
// Four states have to be told apart at a glance without reading a word:
//   done    a grey dot, the title greyed. Green if it was a thing you kept.
//   now     a big teal dot and the only line on the screen set in lead.
//   next    a hollow dot on a dashed rail, the title muted.
//   missed  a hollow amber ring, the title amber.
// A fifth, byovoa, is a violet diamond: the agent's own hand, never decoration.
//
// A moment that needs an answer gets a 2px left rail in `now` and an indent.
// Never a filled card, never a border, never a radius — if it starts looking
// like a card again the design has been lost.

const TIME_W = 42;
const RAIL_W = 18;
/** Where the dot sits: the middle of the first line of the title. */
const DOT_Y = 18;
/** How far a row has to be dragged before Done is showing. */
const REVEAL = 84;

export type MomentState = "done" | "kept" | "now" | "next" | "missed" | "agent" | "agentQuiet";

export type Moment = {
  id: string;
  /** The time column, already in the reader's clock. */
  at: string;
  /** For ordering, and for working out where NOW falls. */
  sortAt: number;
  title: string;
  state: MomentState;
  /** A detail line under the title, for what a moment actually was. */
  detail?: string;
  /** The block that asks something of you. Rendered under the title. */
  answer?: ReactNode;
  /** A future moment you can swipe left to tick off. */
  onDone?: () => void;
};

export function Spine({ moments, now = Date.now() }: { moments: Moment[]; now?: number }) {
  const ordered = useMemo(() => [...moments].sort((a, b) => a.sortAt - b.sortAt), [moments]);
  // NOW goes between the last moment already behind you and the first ahead.
  const split = ordered.findIndex((m) => m.sortAt > now);
  const at = split === -1 ? ordered.length : split;

  return (
    <View>
      {ordered.map((m, i) => (
        <View key={m.id}>
          {i === at && <NowLine />}
          <MomentRow moment={m} />
        </View>
      ))}
      {at === ordered.length && <NowLine />}
    </View>
  );
}

function NowLine() {
  return (
    <View style={styles.nowLine}>
      <Text style={styles.nowLabel}>NOW</Text>
      {/* Three segments instead of a gradient: nothing here draws one, and a
          solid rule all the way across reads as a divider rather than a mark. */}
      <View style={[styles.nowRule, { flex: 2 }]} />
      <View style={[styles.nowRule, { flex: 3, opacity: 0.45 }]} />
      <View style={[styles.nowRule, { flex: 4, opacity: 0.15 }]} />
    </View>
  );
}

function MomentRow({ moment }: { moment: Moment }) {
  const { state } = moment;
  const slide = useRef(new Animated.Value(0)).current;
  const [revealed, setRevealed] = useState(false);
  const openRef = useRef(false);

  const settle = (open: boolean) => {
    openRef.current = open;
    setRevealed(open);
    Animated.timing(slide, {
      toValue: open ? -REVEAL : 0,
      duration: 200,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
      useNativeDriver: true,
    }).start();
  };

  const swipeable = !!moment.onDone;
  const pan = useMemo(
    () =>
      swipeable
        ? PanResponder.create({
            // Bubble phase, not capture: a vertical scroll belongs to the list,
            // and the drawer only claims drags that start at the screen edge.
            onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
            onPanResponderMove: (_e, g) => {
              const from = openRef.current ? -REVEAL : 0;
              slide.setValue(Math.max(-REVEAL, Math.min(0, from + g.dx)));
            },
            onPanResponderRelease: (_e, g) => {
              const from = openRef.current ? -REVEAL : 0;
              settle(from + g.dx < -REVEAL / 2);
            },
            onPanResponderTerminate: () => settle(openRef.current),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swipeable],
  );

  return (
    <View style={styles.row}>
      <Text style={[styles.time, state === "now" && styles.timeNow]} numberOfLines={1}>
        {moment.at}
      </Text>

      <View style={styles.rail}>
        {state === "next" ? <DashedRail /> : <View style={styles.railLine} />}
        <Dot state={state} />
      </View>

      <View style={styles.body}>
        <Animated.View style={{ transform: [{ translateX: slide }] }} {...(pan?.panHandlers ?? {})}>
          <View style={styles.inner}>
            {/* A moment whose whole point is the question it asks has no title
                of its own — the answer block is the moment. */}
            {!!moment.title && <Text style={[styles.title, TITLE[state]]}>{moment.title}</Text>}
            {!!moment.detail && <Text style={styles.detail}>{moment.detail}</Text>}
            {moment.answer}
          </View>
        </Animated.View>

        {swipeable && (
          <Animated.View
            pointerEvents={revealed ? "auto" : "none"}
            style={[styles.act, { opacity: slide.interpolate({ inputRange: [-REVEAL, 0], outputRange: [1, 0] }) }]}
          >
            <Pressable
              style={styles.mini}
              onPress={() => {
                settle(false);
                moment.onDone?.();
              }}
            >
              <Text style={styles.miniText}>Done</Text>
            </Pressable>
          </Animated.View>
        )}
      </View>
    </View>
  );
}

/**
 * The rail for a moment that has not happened yet. Drawn as real segments
 * rather than a dashed border: React Native renders dashed borders
 * inconsistently, and this looks the same everywhere.
 */
function DashedRail() {
  const [height, setHeight] = useState(0);
  const dashes = Math.ceil(height / 7);
  return (
    <View style={styles.dashWrap} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {Array.from({ length: dashes }, (_, i) => (
        <View key={i} style={styles.dash} />
      ))}
    </View>
  );
}

function Dot({ state }: { state: MomentState }) {
  const diamond = state === "agent" || state === "agentQuiet";
  const size = state === "now" ? 11 : state === "done" || state === "kept" ? 7 : 8;
  return (
    // The halo is the paper punching a hole in the rail, the way the mock's
    // 4px box-shadow does.
    <View style={[styles.halo, { top: DOT_Y - (size + 8) / 2 }]}>
      <View
        style={[
          { width: size, height: size },
          diamond ? styles.diamond : { borderRadius: size / 2 },
          DOT[state],
        ]}
      />
    </View>
  );
}

/** The one thing a moment can ask of you, and how it asks. */
export function Answer({
  eyebrow,
  said,
  who,
  children,
}: {
  /** Left off when the rail and the indent already say it. */
  eyebrow?: string;
  said?: string;
  who?: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.answer}>
      {!!eyebrow && <Text style={styles.eyebrow}>{eyebrow}</Text>}
      {!!said && <Text style={styles.said}>{said}</Text>}
      {!!who && <Text style={styles.who}>{who}</Text>}
      {!!children && <View style={styles.acts}>{children}</View>}
    </View>
  );
}

/** What an answered moment turns into: a fact, not a button. */
export function Settled({ children }: { children: ReactNode }) {
  return (
    <View style={styles.settled}>
      <Ionicons name="checkmark" size={17} color={colors.done} />
      <Text style={styles.settledText}>{children}</Text>
    </View>
  );
}

const DOT: Record<MomentState, object> = {
  done: { backgroundColor: "#B8BEC8" },
  kept: { backgroundColor: colors.done },
  now: { backgroundColor: colors.now },
  next: { backgroundColor: colors.paper, borderWidth: 1.5, borderColor: colors.rail },
  missed: { backgroundColor: colors.paper, borderWidth: 2, borderColor: colors.late },
  agent: { backgroundColor: colors.agent },
  agentQuiet: { backgroundColor: colors.paper, borderWidth: 1.5, borderColor: colors.agent },
};

const TITLE: Record<MomentState, object> = {
  done: { color: colors.inkDim, fontWeight: "400" },
  kept: { color: colors.inkDim, fontWeight: "400" },
  now: { ...type.lead, color: colors.ink },
  next: { color: colors.inkMute, fontWeight: "400" },
  missed: { color: colors.late },
  agent: { color: colors.ink },
  agentQuiet: { color: colors.inkMute, fontWeight: "400" },
};

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "stretch" },

  time: {
    width: TIME_W,
    textAlign: "right",
    paddingTop: 11,
    paddingRight: space.s2,
    ...type.micro,
    ...mono,
    ...numeric,
    letterSpacing: 0,
    color: colors.inkMute,
  },
  timeNow: { color: colors.now, fontWeight: "500" },

  rail: { width: RAIL_W },
  railLine: { position: "absolute", left: RAIL_W / 2 - 0.75, top: 0, bottom: 0, width: 1.5, backgroundColor: colors.rail },
  dashWrap: { position: "absolute", left: RAIL_W / 2 - 0.75, top: 0, bottom: 0, width: 1.5, overflow: "hidden" },
  dash: { height: 3, marginBottom: 4, backgroundColor: colors.railNext },

  halo: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    height: 19,
    // The paper the dot punches through the rail with.
    backgroundColor: colors.paper,
    borderRadius: 10,
  },
  diamond: { transform: [{ rotate: "45deg" }], borderRadius: 2 },

  body: { flex: 1, paddingLeft: space.s3, overflow: "hidden" },
  inner: { paddingVertical: 9 },
  title: { ...type.body, color: colors.ink, lineHeight: 22 },
  detail: { ...type.meta, color: colors.inkMute, marginTop: 2 },

  act: { position: "absolute", top: 5, right: 0, flexDirection: "row", gap: space.s2 },
  mini: { height: 34, paddingHorizontal: 13, borderRadius: 17, backgroundColor: colors.done, justifyContent: "center" },
  miniText: { ...type.meta, fontWeight: "600", color: colors.paper },

  nowLine: { flexDirection: "row", alignItems: "center", marginTop: space.s2, marginBottom: space.s1 },
  nowLabel: {
    width: TIME_W,
    textAlign: "right",
    paddingRight: space.s2,
    ...type.micro,
    ...mono,
    fontWeight: "500",
    color: colors.now,
  },
  nowRule: { height: 1.5, backgroundColor: colors.now },

  answer: {
    marginTop: space.s2,
    paddingLeft: space.s4,
    borderLeftWidth: 2,
    borderLeftColor: colors.now,
    gap: space.s2,
  },
  eyebrow: { ...type.micro, ...mono, color: colors.now, textTransform: "uppercase" },
  said: { ...type.body, color: colors.ink, lineHeight: 23 },
  who: { ...type.meta, color: colors.inkMute },
  acts: { flexDirection: "row", alignItems: "center", gap: space.s2, flexWrap: "wrap" },

  settled: { flexDirection: "row", alignItems: "center", gap: space.s2, marginTop: space.s2 },
  settledText: { ...type.sub, fontWeight: "500", color: colors.done, flex: 1 },
});
