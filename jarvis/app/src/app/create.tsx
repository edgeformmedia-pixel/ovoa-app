import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
} from "react-native-reanimated";
import { AppEditor } from "../components/AppEditor";
import { Glimmer, Rise, SPRING } from "../components/motion";
import { PartOfPlan } from "../components/Plan";
import { Btn, IconTile, Screen, toneWash, type IconName, type Tone } from "../components/ui";
import { cue } from "../lib/cues";
import { api, type AppDraft } from "../lib/api";
import { missingFrom } from "../lib/appKit";
import { useSession } from "../lib/auth";
import { useDictation } from "../lib/dictation";
import { logFail } from "../lib/devlog";
import { myApps } from "../lib/myApps";
import { usePlan } from "../lib/plan";
import { colors, radius, space, type } from "../lib/theme";

// Apps → Create: say or type what you want, and OVOA makes it an app.
//
// Three moments: describing it (the microphone or the keyboard, whichever is
// easier where they are), OVOA making it, and seeing what it made before it's
// theirs, in the editor (components/AppEditor.tsx): a preview of its screen,
// and every part of it theirs to change, by hand or by saying so. The app is
// instructions for the assistant plus a screen of its own (api/src/myapps.ts),
// and it opens on that screen (app/made/[id].tsx).
//
// OVOA making it is a model call, so Create is for Base users: on the free plan
// it opens on the locked state, and nothing is sent (api.ts stops the request
// too). Saving and editing an app by hand are free on the server.

const EXAMPLES = [
  "A grocery helper that asks what I'm out of and adds it to my shopping list",
  "A study buddy that quizzes me on Spanish words",
  "A workout coach that plans today's workout from how I slept",
  "A bedtime wind-down that reminds me what's on tomorrow",
];

export default function Create() {
  const { can } = usePlan();
  if (!can.chat) {
    return (
      <PartOfPlan
        title="Create"
        bar={false}
        what="Say or type what you want, like a grocery helper or a study buddy, and OVOA makes it into an app with its own screen."
      />
    );
  }
  return <MakeApp />;
}

function MakeApp() {
  const router = useRouter();
  const { token, user } = useSession();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<AppDraft | null>(null);
  const [making, setMaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One sentence at a time, added to what's in the box. Talk's own listening is
  // held off meanwhile (lib/dictation.ts), Always listen included.
  const dictation = useDictation(token, (said) => setText((t) => (t.trim() ? `${t.trim()} ${said}` : said)));
  const listening = dictation.listening;

  const mic = () => {
    if (listening) return dictation.stop();
    setError(null);
    void dictation.start();
  };

  const make = async () => {
    const description = text.trim();
    if (description.length < 3 || making) return;
    dictation.stop();
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
    const missing = missingFrom(draft);
    if (missing) return Alert.alert("Not yet", missing);
    setSaving(true);
    try {
      const app = await myApps.save(token, draft);
      cue("created");
      // Straight into its own screen, in place of Create.
      if (open) router.replace({ pathname: "/made/[id]", params: { id: app.id } } as unknown as Href);
      else router.back();
    } catch (err) {
      Alert.alert("Couldn't add it", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // ---------- what OVOA made ----------
  if (draft) {
    return (
      <Screen keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
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

        {/* The add buttons sit up top, so nobody backs out and loses the app
            before scrolling down to them. */}
        <View style={styles.buttons}>
          <Btn label="Add and open" kind="go" onPress={() => void add(true)} busy={saving} />
          <Btn label="Add to my apps" onPress={() => void add(false)} disabled={saving} />
        </View>

        <Rise index={18}>
          <Text style={styles.sub}>
            Everything below is yours to change: how it looks, what's on its screen, and how it behaves. Or just say what to change.
          </Text>
        </Rise>

        <AppEditor draft={draft} onChange={setDraft} token={token} assistant={user?.settings.assistantName || "OVOA"} />

        <View style={styles.usage}>
          <Ionicons name="flash-outline" size={14} color={colors.inkMute} />
          <Text style={styles.meta}>Uses some daily usage · each thing you ask it counts as a reply. Ticking its lists and counting are free.</Text>
        </View>

        <View style={styles.buttons}>
          <Btn label="Start over" kind="quiet" onPress={() => setDraft(null)} disabled={saving} />
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
        {listening && !!dictation.words && <Text style={styles.heard}>{dictation.words}</Text>}
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
        // Return makes the app, so the keyboard never has to be got out of the way first.
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={() => void make().catch(logFail("create: make"))}
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

      {(error || dictation.error) && <Text style={styles.error}>{error ?? dictation.error}</Text>}
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

const styles = StyleSheet.create({
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
    maxHeight: 160,
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
  usage: { flexDirection: "row", gap: 6, alignItems: "center", paddingTop: space.s2 },
  buttons: { gap: space.s2, alignItems: "flex-start", paddingTop: space.s3 },
});
