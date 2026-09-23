import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAssistant } from "../lib/assistant";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { measureSpot, pointAt, useDrawer, type SpotRect } from "../lib/drawer";
import { usePlan } from "../lib/plan";
import { tourPref, useTourSeen } from "../lib/tour";
import { colors, lift, radius, space, type } from "../lib/theme";
import { createSpeaker, speakOnDevice } from "../lib/voice";
import { SPRING } from "./motion";
import { Btn, IconTile, type IconName, type Tone } from "./ui";

// The quick tour, spoken, and shown rather than described.
//
// OVOA reads each card out loud and moves on by itself when it has finished
// saying it. For each row of the menu it does what the person will do: opens
// the menu, points at the row, taps it, and leaves them on that screen while
// it explains it. So by the end they have watched every step once.
//
// Shown once (lib/tour.ts), straight after the setup conversation. Skippable at
// any point; the speaker button silences it and stops it moving on its own, for
// somewhere it can't talk. With a plan it speaks in their chosen OVOA voice; the
// free plan has no server voice, so it uses the phone's own.

type Step = {
  icon: IconName;
  tone: Tone;
  title: string;
  /** Shown and spoken, so written to be heard: no symbols. */
  body: string;
  /** What it does on screen while it says this. */
  show?:
    | { menu: "open" }
    | { menu: "tap"; row: string; href: Href }
    | { go: Href }
    /** Points at something on a screen rather than in the menu. */
    | { point: string; on: Href };
};

function steps(assistant: string, free: boolean): Step[] {
  const home: Href = free ? "/" : "/chat";
  return [
    {
      icon: "sparkles-outline",
      tone: "violet",
      title: free ? "Welcome to OVOA" : `${assistant} is ready`,
      body: free
        ? "Let me show you around. It takes half a minute."
        : `You're all set up. I'm ${assistant}. Let me show you around — it takes half a minute.`,
      show: { go: home },
    },
    {
      icon: "menu",
      tone: "blue",
      title: "The menu",
      body: "To get around, tap the three lines at the top left of any screen, or swipe in from the left edge. That opens the menu: Talk and Apps at the top, the apps you've added under them, and Settings at the bottom.",
      show: { menu: "open" },
    },
    free
      ? {
          icon: "time-outline",
          tone: "teal",
          title: "Today",
          body: "Today is your notes and your health for the day. With a plan, this is where you'd talk to me.",
          show: { menu: "tap", row: "Today", href: "/" },
        }
      : {
          icon: "mic",
          tone: "teal",
          title: "Talk",
          body: "Talk is where the app opens. Tap the circle and speak. Ask me to remind you of something, plan your day, or text someone.",
          show: { menu: "tap", row: "Talk", href: "/chat" },
        },
    {
      icon: "apps-outline",
      tone: "violet",
      title: "Apps",
      body: "Apps is everything else — your morning brief, your day, activity, recording, safety and more. Search for one and tap install to add it, and it shows up in the menu too. Each one says how much of your daily usage it uses. Press and hold an app to remove it.",
      show: { menu: "tap", row: "Apps", href: "/apps" as Href },
    },
    {
      icon: "add-circle-outline",
      tone: "teal",
      title: "Create your own",
      body: free
        ? "At the top of Apps is Create. With a plan, you can make your own apps just by saying what you want — like a grocery helper, or a study buddy."
        : "At the top of Apps is Create. Tap it, then say or type what you want — like a grocery helper that asks what you're out of. I'll make it into an app, show it to you, and it goes in your apps. When you open it, I follow its instructions while we talk.",
      show: { point: "Create", on: "/apps" as Href },
    },
    {
      icon: "settings-outline",
      tone: "amber",
      title: "Settings",
      body: free
        ? "Settings starts with your account: your plan, your name, your password, and signing out. Under that are the switches for this phone. You can play this tour again from here, too."
        : "Settings starts with your account: your plan, your name, your password, and signing out. Under that is how I sound and listen, what I remember, and what I'm allowed to do on my own. You can play this tour again from here, too.",
      show: { menu: "tap", row: "Settings", href: "/settings" },
    },
    {
      icon: "checkmark-circle-outline",
      tone: "green",
      title: "That's it",
      body: free ? "That's everything. Enjoy OVOA." : "That's everything. Whenever you're ready, just talk to me.",
      show: { go: home },
    },
  ];
}

/** Long enough to see the menu open and the row ringed before it's tapped. */
const POINT_MS = 1600;
/** How long the menu or a new screen takes to settle before the spotlight measures it. */
const SETTLE_MS = 420;
/** The dim's border: wider than any phone, so its outer edge is never on screen. */
const DIM = 2000;
/** Room around what's lit, so it isn't tight to the edges. */
const HOLE_PAD = 6;
/** Where the cut-out goes when there's nothing to show: past every edge. */
const HOLE_OUT = 60;
/** Between finishing one card and starting the next. */
const BEAT_MS = 700;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** About how long a card takes to read to yourself: a third of a second a word, and never under three seconds. */
const readingMs = (text: string) => Math.max(3000, text.split(/\s+/).length * 330);

export function Tour() {
  const seen = useTourSeen();
  if (seen !== false) return null;
  return <Walkthrough />;
}

function Walkthrough() {
  const router = useRouter();
  const drawer = useDrawer();
  const insets = useSafeAreaInsets();
  const { token, user } = useSession();
  const { free, can } = usePlan();
  const [at, setAt] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const [speaking, setSpeaking] = useState(false);

  // Talk's microphone stays shut for the whole tour. Left open, it heard the
  // tour's own voice as a question and answered it ("Let me look into that")
  // over the top of the next card.
  const { hold } = useAssistant();
  useEffect(() => {
    let release = () => {};
    void hold(() => new Promise<void>((r) => (release = r)));
    return () => release();
  }, [hold]);

  const all = steps(user?.settings.assistantName || "OVOA", free);
  const step = all[at];
  const last = at === all.length - 1;

  // With a plan, the chosen OVOA voice; otherwise the phone's own, which is free.
  const speaker = useRef(createSpeaker(token));
  const stopDevice = useRef<(() => void) | null>(null);
  const hush = () => {
    speaker.current.stop();
    stopDevice.current?.();
    stopDevice.current = null;
  };
  const say = (text: string) =>
    can.voice
      ? speaker.current.speak(text, { filler: false })
      : speakOnDevice(text, (stop) => (stopDevice.current = stop));

  // The spotlight: the screen dimmed except a soft cut-out around what's being
  // talked about, springing from one thing to the next. With nothing to show
  // it opens out past the edges of the screen, and the dim fades away.
  const { width: W, height: H } = useWindowDimensions();
  const hx = useSharedValue(-HOLE_OUT);
  const hy = useSharedValue(-HOLE_OUT);
  const hw = useSharedValue(W + HOLE_OUT * 2);
  const hh = useSharedValue(H + HOLE_OUT * 2);
  const shade = useSharedValue(0);
  const spotlight = (r: SpotRect | null) => {
    const t = r
      ? { x: r.x - HOLE_PAD, y: r.y - HOLE_PAD, w: r.width + HOLE_PAD * 2, h: r.height + HOLE_PAD * 2 }
      : { x: -HOLE_OUT, y: -HOLE_OUT, w: W + HOLE_OUT * 2, h: H + HOLE_OUT * 2 };
    hx.value = withSpring(t.x, SPRING);
    hy.value = withSpring(t.y, SPRING);
    hw.value = withSpring(t.w, SPRING);
    hh.value = withSpring(t.h, SPRING);
    shade.value = withTiming(r ? 1 : 0, { duration: 350 });
  };
  const holeStyle = useAnimatedStyle(() => ({
    left: hx.value - DIM,
    top: hy.value - DIM,
    width: hw.value + DIM * 2,
    height: hh.value + DIM * 2,
    opacity: shade.value,
  }));
  const glowStyle = useAnimatedStyle(() => ({
    left: hx.value,
    top: hy.value,
    width: hw.value,
    height: hh.value,
    opacity: shade.value,
  }));
  /** Shines on `label` once whatever is moving (the menu, a new screen) has settled. */
  const shineOn = async (label: string, after: number, live: () => boolean) => {
    await wait(after);
    if (!live()) return;
    // A drawer still springing open can measure as nothing: one more look.
    let r = await measureSpot(label);
    if (!r && live()) {
      await wait(SETTLE_MS);
      r = await measureSpot(label);
    }
    if (live()) spotlight(r);
  };

  // One card: show it, say it, and move on when it's been said.
  useEffect(() => {
    let cancelled = false;
    const show = step.show;

    const act = async () => {
      if (!show) return;
      const live = () => !cancelled;
      if ("go" in show) {
        pointAt(null);
        spotlight(null);
        drawer.close();
        router.navigate(show.go);
      } else if ("point" in show) {
        drawer.close();
        router.navigate(show.on);
        // The new screen has to be up before its row can be found and lit.
        await wait(SETTLE_MS);
        if (cancelled) return;
        pointAt(show.point);
        await shineOn(show.point, SETTLE_MS, live);
      } else if (show.menu === "open") {
        drawer.open();
        await shineOn("Menu", SETTLE_MS, live);
      } else {
        // What they'll do themselves: open the menu, find the row, tap it.
        drawer.open();
        pointAt(show.row);
        await shineOn(show.row, SETTLE_MS, live);
        if (cancelled) return;
        await wait(POINT_MS);
        // Moved on (Next, Back, Skip) while pointing: the next card owns the screen now.
        if (cancelled) return;
        pointAt(null);
        spotlight(null);
        drawer.close();
        router.navigate(show.href);
      }
    };

    const talk = async () => {
      if (!voiceOn) return;
      setSpeaking(true);
      const started = Date.now();
      await say(step.body).catch(logFail("tour: speaking"));
      if (cancelled) return;
      setSpeaking(false);
      // Never faster than it can be read. A voice that couldn't play (offline,
      // a bad minute on the server) comes back at once, and without this the
      // tour ran through every card in a few seconds.
      await wait(Math.max(0, readingMs(step.body) - (Date.now() - started)) + BEAT_MS);
      if (!cancelled && !last) setAt((i) => i + 1);
    };

    void act();
    void talk();
    return () => {
      cancelled = true;
      hush();
      setSpeaking(false);
      // Nothing half-done left behind: a ring on a row, or a spotlight on it.
      pointAt(null);
      spotlight(null);
    };
    // Keyed on the card and the voice switch only: a re-render mid-sentence must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, voiceOn]);

  // Nothing left pointed at or open behind it once it's gone.
  useEffect(() => () => pointAt(null), []);

  const finish = (go?: Href) => {
    hush();
    pointAt(null);
    spotlight(null);
    drawer.close();
    tourPref.done();
    if (go) router.navigate(go);
  };

  return (
    <View style={styles.scrim}>
      {/* One view with an enormous border is the dim; its hollow middle is the cut-out. */}
      <Animated.View pointerEvents="none" style={[styles.dim, holeStyle]} />
      <Animated.View pointerEvents="none" style={[styles.glow, glowStyle]} />
      <View style={[styles.card, { marginBottom: insets.bottom + space.s4 }]}>
        <View style={styles.top}>
          <Text style={styles.count}>
            {at + 1} of {all.length}
          </Text>
          <View style={styles.topRight}>
            <Pressable
              onPress={() => setVoiceOn((v) => !v)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={voiceOn ? "Stop talking" : "Talk me through it"}
            >
              <Ionicons
                name={voiceOn ? (speaking ? "volume-high" : "volume-medium") : "volume-mute"}
                size={20}
                color={voiceOn ? colors.now : colors.inkMute}
              />
            </Pressable>
            <Pressable onPress={() => finish()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Skip the tour">
              <Text style={styles.skip}>Skip</Text>
            </Pressable>
          </View>
        </View>

        <IconTile name={step.icon} tone={step.tone} size={48} />
        <Text style={styles.title}>{step.title}</Text>
        <Text style={styles.body}>{step.body}</Text>

        <View style={styles.dots}>
          {all.map((_, i) => (
            <View key={i} style={[styles.dot, i === at && styles.dotOn]} />
          ))}
        </View>

        <View style={styles.actions}>
          {at > 0 ? (
            <Pressable onPress={() => setAt(at - 1)} hitSlop={8} style={styles.back} accessibilityLabel="Back">
              <Ionicons name="chevron-back" size={20} color={colors.ink} />
            </Pressable>
          ) : (
            <View />
          )}
          {last ? (
            <Btn label={free ? "Got it" : "Start talking"} kind="go" onPress={() => finish(free ? "/" : "/chat")} />
          ) : (
            <Btn label="Next" kind="go" onPress={() => setAt(at + 1)} />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    // Clear: the spotlight does the dimming, and only while there's something to point at.
    backgroundColor: "transparent",
    justifyContent: "flex-end",
    paddingHorizontal: space.s4,
  },
  dim: { position: "absolute", borderWidth: DIM, borderColor: "rgba(12,14,18,0.55)", borderRadius: DIM + 16 },
  glow: {
    position: "absolute",
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.now,
    shadowColor: colors.now,
    shadowOpacity: 0.7,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.sheet,
    padding: space.s5,
    gap: space.s2,
    ...lift,
  },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.s1 },
  topRight: { flexDirection: "row", alignItems: "center", gap: space.s4 },
  count: { ...type.meta, color: colors.inkMute },
  skip: { ...type.meta, fontWeight: "600", color: colors.inkMute },
  title: { ...type.title, color: colors.ink, marginTop: space.s1 },
  body: { ...type.sub, color: colors.inkDim },
  dots: { flexDirection: "row", gap: 6, paddingTop: space.s2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.wash2 },
  dotOn: { backgroundColor: colors.ink, width: 18 },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: space.s2 },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.wash,
    alignItems: "center",
    justifyContent: "center",
  },
});
