import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, isNeedsPlan, type OnboardingStep } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog, logFail } from "../lib/devlog";
import { syncRoutines } from "../lib/routines";
import { colors, lift } from "../lib/theme";
import { createSpeaker, useConversation } from "../lib/voice";

// Setup, as a phone call.
//
// The old version asked nine questions and waited for them to be typed, which
// is a strange first impression for something whose whole point is that you
// talk to it. So OVOA rings, asks out loud, and listens — the same voice loop
// that runs the assistant, pointed at the setup questions. The user's hands
// stay down and the thing introduces itself by doing the thing it does.
//
// What's on screen is what a call shows: who's talking, what was just said, and
// the buttons to skip, type instead, or hang up. The running transcript is kept
// underneath, because a spoken answer that was misheard has to be visible to be
// caught — every answer comes back with what OVOA understood, and that belongs
// in front of someone's eyes, not only in their ear.
//
// The keyboard never goes away: a noisy room, a quiet carriage, or simply not
// wanting to talk are all ordinary, and every question can still be typed.

type Line = { from: "ovoa" | "you"; text: string };

/** Between a spoken answer and the next question, so it isn't one long stream of talk. */
const BEAT_MS = 250;

export default function Onboarding() {
  const { token, user, setUser } = useSession();
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [calling, setCalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const assistant = user?.settings.assistantName ?? "OVOA";

  // The voice loop hands answers to a callback that never changes identity, so
  // the current question has to be readable from inside it.
  const stepRef = useRef<OnboardingStep | null>(null);
  const setCurrent = (next: OnboardingStep | null) => {
    stepRef.current = next;
    setStep(next);
  };

  const say = (line: Line) => setLines((l) => [...l, line]);

  const finish = async () => {
    // Medications from setup go into Apple Reminders now, asking for Reminders access
    // at the moment it makes sense rather than on some later screen.
    await syncRoutines(token, { ask: true }).catch(logFail("onboarding: syncRoutines"));
    const { user } = await api.me(token);
    setUser(user);
  };

  /** One answer, spoken or typed: record it, show what was understood, move on. */
  const answer = async (said: string): Promise<string | null> => {
    const current = stepRef.current;
    if (!current) return null;
    say({ from: "you", text: said });
    setBusy(true);
    setError(null);
    try {
      const res = await api.onboardingAnswer(token, current.step, said);
      if (res.understood) say({ from: "ovoa", text: res.understood });
      if (res.next.done) {
        setCurrent(null);
        await finish();
        return "That's everything I need. Thanks — I'll take it from here.";
      }
      setCurrent(res.next);
      say({ from: "ovoa", text: res.next.question });
      await new Promise((r) => setTimeout(r, BEAT_MS));
      // Spoken back to back: what it understood, then the next question.
      return [res.understood, res.next.question].filter(Boolean).join(" ");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      devlog("err", "onboarding answer failed", message);
      setError(message);
      return "Sorry — I didn't get that saved. Say it once more?";
    } finally {
      setBusy(false);
    }
  };

  const convo = useConversation(token, answer, { interruptible: true });
  // The hook's own speaker belongs to the loop; the greeting happens before the
  // loop starts, so it gets one of its own and finishes before start() is called.
  const intro = useRef(createSpeaker(token));

  useEffect(() => {
    let cancelled = false;
    api
      .onboarding(token)
      .then(async (next) => {
        if (cancelled) return;
        if (next.done) return finish();
        setCurrent(next);
        const greeting =
          next.index === 0
            ? `Hi, I'm ${assistant}. A few quick questions so I can plan around your day. Just answer out loud, and say skip for any you'd rather not.`
            : "Picking up where we left off.";
        say({ from: "ovoa", text: greeting });
        say({ from: "ovoa", text: next.question });
        setCalling(true);
        await intro.current.speak(`${greeting} ${next.question}`).catch(logFail("onboarding: greeting"));
        if (!cancelled) await convo.start();
      })
      // Setup is part of the assistant. On the free plan the answer is needs_plan,
      // which already moved the plan to free, and the free app opens instead of this.
      .catch((err) => !isNeedsPlan(err) && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      intro.current.stop();
    };
  }, [token]);

  useEffect(() => {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [lines.length]);

  const skip = async () => {
    const current = stepRef.current;
    if (!current || busy) return;
    setBusy(true);
    try {
      const res = await api.onboardingSkip(token, current.step);
      if (res.next.done) {
        setCurrent(null);
        await finish();
        return;
      }
      setCurrent(res.next);
      say({ from: "ovoa", text: res.next.question });
      if (calling) await intro.current.speak(res.next.question).catch(logFail("onboarding: next question"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const hangUp = async () => {
    convo.end();
    intro.current.stop();
    setCalling(false);
    setBusy(true);
    await api.onboardingFinish(token).catch(logFail("onboarding: api.onboardingFinish"));
    await finish().catch(logFail("onboarding: finish"));
    setBusy(false);
  };

  const sendTyped = () => {
    const said = text.trim();
    if (!said || busy || !stepRef.current) return;
    setText("");
    void answer(said).then(async (reply) => {
      // Typed answers are read back only while the call is live; someone who
      // switched to the keyboard is probably somewhere they can't listen either.
      if (reply && calling) await intro.current.speak(reply).catch(logFail("onboarding: reply"));
    });
  };

  const talking = convo.phase === "listening";
  // Map roughly -60..-10 dBFS onto the halo, the same as the assistant's orb.
  const loudness = talking ? Math.max(0, Math.min(1, (convo.level + 60) / 50)) : 0;
  const phase = busy ? "thinking" : convo.phase;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.head}>
        <View>
          <Text style={styles.who}>{assistant}</Text>
          <Text style={styles.status}>{statusLine(calling, phase, busy)}</Text>
        </View>
        {step && (
          <Text style={styles.count}>
            {step.index + 1} / {step.total}
          </Text>
        )}
      </View>
      {step && (
        <View style={styles.track}>
          <View style={[styles.trackFill, { width: `${(step.index / step.total) * 100}%` }]} />
        </View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.stage}>
          <View style={styles.orbWrap}>
            {calling && (
              <View
                style={[
                  styles.halo,
                  phase === "speaking" && { backgroundColor: colors.done },
                  { transform: [{ scale: 1 + loudness * 0.35 }], opacity: 0.12 + loudness * 0.35 },
                ]}
              />
            )}
            <View style={[styles.orb, !calling && styles.orbOff]}>
              <Image source={require("../../assets/orb-ring.png")} style={styles.ring} resizeMode="cover" />
              {phase === "thinking" ? (
                <ActivityIndicator size="large" color={colors.now} />
              ) : (
                <Ionicons
                  name={!calling ? "call-outline" : phase === "speaking" ? "volume-high" : "mic"}
                  size={30}
                  color={!calling ? colors.inkMute : phase === "speaking" ? colors.done : colors.now}
                />
              )}
            </View>
          </View>

          {/* The question, big, because it's the thing being answered. */}
          <Text style={styles.question}>{step?.question ?? (busy ? "One moment…" : "")}</Text>
          {!!convo.words && (
            <Text style={styles.heard} numberOfLines={3}>
              {convo.words}
            </Text>
          )}
          {(error || convo.error) && <Text style={styles.error}>{error ?? convo.error}</Text>}
        </View>

        <ScrollView ref={scroll} style={styles.transcript} contentContainerStyle={styles.lines}>
          {lines.map((line, i) => (
            <View key={i} style={[styles.bubble, line.from === "you" ? styles.you : styles.ovoa]}>
              <Text style={[styles.bubbleText, line.from === "you" && { color: colors.paper }]}>{line.text}</Text>
            </View>
          ))}
        </ScrollView>

        {typing && (
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Type your answer…"
              placeholderTextColor={colors.inkMute}
              onSubmitEditing={sendTyped}
              returnKeyType="send"
              editable={!busy && !!step}
              autoFocus
              multiline
            />
            <Pressable style={styles.send} onPress={sendTyped} disabled={busy || !text.trim()} accessibilityLabel="Send">
              <Ionicons name="arrow-up" size={20} color={colors.paper} />
            </Pressable>
          </View>
        )}

        <View style={styles.controls}>
          <CallButton
            icon={typing ? "mic" : "keypad"}
            label={typing ? "Talk" : "Type"}
            onPress={() => {
              setTyping((t) => !t);
              // Typing and listening at once means the mic hears the room while
              // they think; the call resumes when they switch back.
              if (!typing) convo.end();
              else void convo.start();
            }}
          />
          <CallButton icon="play-skip-forward" label="Skip" onPress={skip} disabled={busy || !step} />
          <CallButton icon="call" label="Later" tone="danger" onPress={hangUp} disabled={busy} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function CallButton({
  icon,
  label,
  onPress,
  disabled,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.control, disabled && { opacity: 0.4 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.controlCircle, tone === "danger" && styles.controlDanger]}>
        <Ionicons
          name={icon}
          size={22}
          color={tone === "danger" ? colors.paper : colors.ink}
          // A hang-up icon is the call icon, turned over.
          style={tone === "danger" ? { transform: [{ rotate: "135deg" }] } : undefined}
        />
      </View>
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

function statusLine(calling: boolean, phase: string, busy: boolean) {
  if (busy) return "One moment…";
  if (!calling) return "Setup";
  if (phase === "speaking") return "Speaking";
  if (phase === "listening") return "Listening…";
  return "Connected";
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper, paddingHorizontal: 16 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 8, paddingBottom: 10 },
  who: { color: colors.ink, fontSize: 24, fontWeight: "700" },
  status: { color: colors.now, fontSize: 14, marginTop: 2 },
  count: { color: colors.inkMute, fontSize: 14, fontVariant: ["tabular-nums"] },
  track: { height: 3, borderRadius: 2, backgroundColor: colors.wash, overflow: "hidden" },
  trackFill: { height: 3, backgroundColor: colors.now },

  stage: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 18 },
  orbWrap: { width: 160, height: 160, alignItems: "center", justifyContent: "center" },
  halo: { position: "absolute", width: 150, height: 150, borderRadius: 75, backgroundColor: colors.now },
  orb: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
    ...lift,
  },
  orbOff: { opacity: 0.55 },
  ring: { position: "absolute", width: 130, height: 130, borderRadius: 65 },
  question: { color: colors.ink, fontSize: 21, lineHeight: 28, textAlign: "center", paddingHorizontal: 8 },
  heard: { color: colors.now, fontSize: 16, lineHeight: 22, textAlign: "center", opacity: 0.9 },
  error: { color: colors.stop, textAlign: "center" },

  transcript: { flex: 1 },
  lines: { gap: 8, paddingVertical: 8 },
  bubble: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  ovoa: { alignSelf: "flex-start", backgroundColor: colors.wash, borderColor: colors.line, borderWidth: 1 },
  you: { alignSelf: "flex-end", backgroundColor: colors.now },
  bubbleText: { color: colors.ink, fontSize: 15, lineHeight: 21 },

  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingTop: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    color: colors.ink,
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.now, alignItems: "center", justifyContent: "center" },

  controls: { flexDirection: "row", justifyContent: "space-evenly", alignItems: "flex-start", paddingTop: 12, paddingBottom: 8 },
  control: { alignItems: "center", gap: 6, width: 78 },
  controlCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.wash2,
    borderColor: colors.line,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  controlDanger: { backgroundColor: colors.stop, borderColor: colors.stop },
  controlLabel: { color: colors.inkMute, fontSize: 13 },
});
