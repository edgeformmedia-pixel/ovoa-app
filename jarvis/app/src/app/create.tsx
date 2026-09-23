import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Rise, SPRING } from "../components/motion";
import { Btn, IconTile, Screen, toneWash, type IconName, type Tone } from "../components/ui";
import { cue } from "../lib/cues";
import { setOpenApp } from "../lib/activeApp";
import { api, type AppDraft } from "../lib/api";
import { useAssistant } from "../lib/assistant";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { myApps } from "../lib/myApps";
import { colors, radius, space, type } from "../lib/theme";
import { useConversation } from "../lib/voice";

// Apps → Create: say or type what you want, and OVOA makes it an app.
//
// Three moments: describing it (the microphone or the keyboard, whichever is
// easier where they are), OVOA making it, and seeing what it made before it's
// theirs — name, what it does, how it'll start — with a way to change it. The
// app itself is instructions for the assistant (api/src/myapps.ts); it opens in
// Talk.

const EXAMPLES = [
  "A grocery helper that asks what I'm out of and adds it to my shopping list",
  "A study buddy that quizzes me on Spanish words",
  "A workout coach that plans today's workout from how I slept",
  "A bedtime wind-down that reminds me what's on tomorrow",
];

export default function Create() {
  const router = useRouter();
  const { token, user } = useSession();
  const a = useAssistant();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<AppDraft | null>(null);
  const [making, setMaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHow, setShowHow] = useState(false);

  // Talk's own listening is paused while they dictate here, so the two never
  // share the microphone, and put back as it was when they leave.
  const pausedTalk = useRef(false);
  const convo = useConversation(
    token,
    async (said) => {
      setText((t) => (t.trim() ? `${t.trim()} ${said}` : said));
      convo.end();
      return null;
    },
    { wake: false },
  );
  const listening = convo.phase === "listening" || convo.phase === "waiting";

  useEffect(
    () => () => {
      convo.end();
      if (pausedTalk.current) a.toggleEnabled();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const mic = () => {
    if (listening) return convo.end();
    if (a.alwaysListen) {
      Alert.alert("Always listen is on", "Turn it off on Talk to speak here, or type what you want instead.");
      return;
    }
    if (a.enabled) {
      a.toggleEnabled();
      pausedTalk.current = true;
    }
    setError(null);
    void convo.start();
  };

  const make = async () => {
    const description = text.trim();
    if (description.length < 3 || making) return;
    convo.end();
    setMaking(true);
    setError(null);
    try {
      setDraft((await api.designApp(token, description)).draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMaking(false);
    }
  };

  const add = async (open: boolean) => {
    if (!draft) return;
    setSaving(true);
    try {
      const app = await myApps.save(token, draft);
      cue("created");
      if (open) {
        setOpenApp({ id: app.id, name: app.name, opener: app.opener });
        router.dismissTo("/chat");
      } else router.back();
    } catch (err) {
      Alert.alert("Couldn't add it", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // ---------- what OVOA made ----------
  if (draft) {
    return (
      <Screen>
        <Rise>
          <Text style={styles.heading}>Here's your app</Text>
        </Rise>
        {/* Being made is a moment: the pieces fly together into its icon, the
            name types itself, and the rest settles in after. */}
        <View style={styles.preview}>
          <Assemble icon={draft.icon as IconName} tone={draft.tone} />
          <View style={{ flex: 1, gap: 2 }}>
            <Typed text={draft.name} style={styles.name} delay={650} />
            <Rise index={14}>
              <Text style={styles.meta}>by {user?.name?.trim() || "you"}</Text>
              <Text style={styles.about}>{draft.about}</Text>
            </Rise>
          </View>
        </View>

        {!!draft.opener && (
          <>
            <Text style={styles.label}>It starts by asking</Text>
            <Text style={styles.quote}>“{draft.opener}”</Text>
          </>
        )}

        <Pressable onPress={() => setShowHow((s) => !s)} hitSlop={8}>
          <Text style={styles.label}>What it tells {user?.settings.assistantName || "OVOA"} to do {showHow ? "▾" : "▸"}</Text>
        </Pressable>
        {showHow && <Text style={styles.instructions}>{draft.instructions}</Text>}

        <View style={styles.usage}>
          <Ionicons name="flash-outline" size={14} color={colors.inkMute} />
          <Text style={styles.meta}>Uses some daily usage · each thing you ask it counts as a reply.</Text>
        </View>

        <View style={styles.buttons}>
          <Btn label="Add and open" kind="go" onPress={() => void add(true)} busy={saving} />
          <Btn label="Add to my apps" onPress={() => void add(false)} disabled={saving} />
          <Btn label="Change it" kind="quiet" onPress={() => setDraft(null)} disabled={saving} />
        </View>
      </Screen>
    );
  }

  // ---------- describing it ----------
  return (
    // automaticallyAdjustKeyboardInsets: the list scrolls up past the keyboard,
    // so "Make my app" (right under the box) is never hidden behind it.
    <Screen keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Text style={styles.heading}>What should your app do?</Text>
      <Text style={styles.sub}>Say it or type it, in your own words. OVOA makes it into an app you can open any time.</Text>

      <View style={styles.micWrap}>
        <Pressable
          onPress={mic}
          disabled={making}
          style={({ pressed }) => [styles.mic, listening && styles.micOn, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
          accessibilityLabel={listening ? "Stop listening" : "Say what you want"}
        >
          <Ionicons name={listening ? "stop" : "mic"} size={34} color={listening ? colors.paper : colors.now} />
        </Pressable>
        <Text style={styles.micLabel}>{listening ? "Listening… tap when you're done" : "Tap to say it"}</Text>
        {listening && !!convo.words && <Text style={styles.heard}>{convo.words}</Text>}
      </View>

      <Text style={styles.label}>Or type it</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="e.g. A grocery helper that asks what I'm out of"
        placeholderTextColor={colors.inkMute}
        multiline
        editable={!making}
        // No AutoFill bar: iOS offered contacts and passwords over the button.
        textContentType="none"
        autoComplete="off"
        importantForAutofill="no"
      />

      {making ? (
        <View style={styles.making}>
          <Glimmer text="Making your app…" />
        </View>
      ) : (
        <Btn
          label="Make my app"
          kind="go"
          onPress={() => void make().catch(logFail("create: make"))}
          disabled={text.trim().length < 3}
          style={{ alignSelf: "flex-start", marginTop: space.s2 }}
        />
      )}

      {!text.trim() && (
        <>
          <Text style={styles.label}>Ideas</Text>
          {EXAMPLES.map((e) => (
            <Pressable key={e} onPress={() => setText(e)} style={({ pressed }) => [styles.example, pressed && { opacity: 0.6 }]}>
              <Ionicons name="bulb-outline" size={16} color={colors.inkMute} />
              <Text style={styles.exampleText}>{e}</Text>
            </Pressable>
          ))}
        </>
      )}

      {(error || convo.error) && <Text style={styles.error}>{error ?? convo.error}</Text>}
    </Screen>
  );
}

/** Four pieces of the icon's tile fly in from the corners and lock together, then the icon appears on it. */
function Assemble({ icon, tone }: { icon: IconName; tone: Tone }) {
  const reduce = useReducedMotion();
  const together = useSharedValue(reduce ? 1 : 0);
  const glyph = useSharedValue(reduce ? 1 : 0);
  useEffect(() => {
    if (reduce) return;
    together.value = withSpring(1, SPRING);
    glyph.value = withDelay(420, withSpring(1, SPRING));
  }, [reduce, together, glyph]);

  const S = 56;
  const half = S / 2;
  const from = [
    [-60, -44, -40],
    [64, -52, 50],
    [-64, 50, 30],
    [58, 60, -60],
  ];
  const pieces = from.map(([dx, dy, rot], i) =>
    // The same four hooks every render, in order.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAnimatedStyle(() => {
      const k = 1 - together.value;
      return {
        opacity: Math.min(1, together.value * 1.6),
        transform: [{ translateX: dx * k }, { translateY: dy * k }, { rotate: `${rot * k}deg` }, { scale: 0.5 + together.value * 0.5 }],
      };
    }),
  );
  const glyphStyle = useAnimatedStyle(() => ({ opacity: glyph.value, transform: [{ scale: 0.4 + glyph.value * 0.6 }] }));
  const corner = S * 0.3;

  return (
    <View style={{ width: S, height: S }}>
      {pieces.map((style, i) => (
        <Animated.View
          key={i}
          style={[
            {
              position: "absolute",
              width: half,
              height: half,
              left: i % 2 ? half : 0,
              top: i > 1 ? half : 0,
              backgroundColor: toneWash(tone),
              borderTopLeftRadius: i === 0 ? corner : 0,
              borderTopRightRadius: i === 1 ? corner : 0,
              borderBottomLeftRadius: i === 2 ? corner : 0,
              borderBottomRightRadius: i === 3 ? corner : 0,
            },
            style,
          ]}
        />
      ))}
      <Animated.View style={[{ position: "absolute", left: 0, top: 0 }, glyphStyle]}>
        <IconTile name={icon} tone={tone} size={S} />
      </Animated.View>
    </View>
  );
}

/** Text that types itself out, a letter at a time, after `delay`. */
function Typed({ text, style, delay = 0 }: { text: string; style: object; delay?: number }) {
  const reduce = useReducedMotion();
  const [n, setN] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (reduce) return setN(text.length);
    setN(0);
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      i += 1;
      setN(i);
      if (i < text.length) timer = setTimeout(next, 45);
    };
    timer = setTimeout(next, delay);
    return () => clearTimeout(timer);
  }, [text, delay, reduce]);
  return <Text style={style}>{text.slice(0, n) || " "}</Text>;
}

/** A line that glimmers while something is being made, instead of a spinner. */
function Glimmer({ text }: { text: string }) {
  const glow = useSharedValue(0.35);
  useEffect(() => {
    glow.value = withRepeat(withSequence(withTiming(1, { duration: 650 }), withTiming(0.35, { duration: 650 })), -1);
  }, [glow]);
  const style = useAnimatedStyle(() => ({ opacity: glow.value }));
  return <Animated.Text style={[styles.glimmer, style]}>{text}</Animated.Text>;
}

const styles = StyleSheet.create({
  glimmer: { ...type.body, color: colors.now },
  heading: { ...type.title, color: colors.ink, paddingTop: space.s2 },
  sub: { ...type.sub, color: colors.inkDim },
  label: { ...type.meta, fontWeight: "600", color: colors.inkMute, paddingTop: space.s3 },
  meta: { ...type.meta, color: colors.inkMute, flex: 1 },

  micWrap: { alignItems: "center", gap: space.s2, paddingVertical: space.s4 },
  mic: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.nowWash,
    alignItems: "center",
    justifyContent: "center",
  },
  micOn: { backgroundColor: colors.now },
  micLabel: { ...type.sub, color: colors.inkDim },
  heard: { ...type.sub, color: colors.now, textAlign: "center" },

  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
    minHeight: 96,
    textAlignVertical: "top",
  },
  example: { flexDirection: "row", gap: space.s2, alignItems: "flex-start", paddingVertical: space.s2 },
  exampleText: { ...type.sub, color: colors.inkDim, flex: 1 },
  error: { ...type.meta, color: colors.stop },
  making: { flexDirection: "row", alignItems: "center", gap: space.s2, paddingTop: space.s3 },

  preview: {
    flexDirection: "row",
    gap: space.s3,
    alignItems: "center",
    backgroundColor: colors.wash,
    borderRadius: radius.tile,
    padding: space.s4,
  },
  name: { ...type.lead, color: colors.ink },
  about: { ...type.sub, color: colors.inkDim, marginTop: 2 },
  quote: { ...type.body, color: colors.ink },
  instructions: { ...type.sub, color: colors.inkDim },
  usage: { flexDirection: "row", gap: 6, alignItems: "center", paddingTop: space.s2 },
  buttons: { gap: space.s2, alignItems: "flex-start", paddingTop: space.s3 },
});
