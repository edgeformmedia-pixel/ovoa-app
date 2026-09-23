import Ionicons from "@expo/vector-icons/Ionicons";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import {
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
import type { OrbMode } from "../components/Orb";
import { OrbView } from "../components/OrbView";
import { Btn } from "../components/ui";
import { VoiceList } from "../components/VoicePicker";
import { installedAddons } from "../lib/addons";
import { api, isNeedsConsent, isNeedsPlan, type OnboardingAnswer, type OnboardingStep } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog, logFail } from "../lib/devlog";
import { myApps } from "../lib/myApps";
import { syncRoutines } from "../lib/routines";
import { colors } from "../lib/theme";
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
//
// It comes the first time someone has Base, after they've agreed to AI
// (app/consent.tsx; app/_layout.tsx puts the steps in order), and starts with
// picking OVOA's voice, the current one ticked, before the call rings. One of
// the questions is about goals: the server makes an app for each (api/src/
// onboarding.ts), which this screen reads into the list of apps, and an eating
// goal turns on Calorie, which it adds to the menu. The tour follows, if it
// hasn't been seen (components/Tour.tsx).

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
  const [calling, setCallingState] = useState(false);
  const [introSpeaking, setIntroSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Picking the voice comes first, on a setup that's starting from the beginning. */
  const [pickingVoice, setPickingVoice] = useState(false);
  // Read from the voice loop's callback, which keeps the render it was made in.
  const callingRef = useRef(false);
  const typingRef = useRef(false);
  typingRef.current = typing;
  const setCalling = (on: boolean) => {
    callingRef.current = on;
    setCallingState(on);
  };
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

  /** What an answer set up besides the profile: apps made for their goals, and Calorie for an eating one. */
  const took = (res: OnboardingAnswer) => {
    if (res.addons?.includes("calorie")) void installedAddons.install("calorie");
    if (res.apps?.length) void myApps.refresh(token).catch(logFail("onboarding: reading the apps it made"));
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
      took(res);
      if (res.understood) say({ from: "ovoa", text: res.understood });
      if (res.next.done) {
        setCurrent(null);
        // Said before the screen goes, not after: returned to the loop, it was
        // never heard (the screen had already gone) or, typed, it talked over the tour.
        convo.end();
        const bye = "That's everything I need. Thanks, I'll take it from here.";
        say({ from: "ovoa", text: bye });
        if (callingRef.current) await speakIntro([res.understood, bye].filter(Boolean).join(" "));
        await finish();
        return null;
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

  // wake false: Talk's wake word ear waits for "OVOA" before anything counts,
  // so setup heard every answer as room talk and never replied. And no "Let me
  // look into that" fillers: the reply here is the next question, not a search.
  // answers: a one-word answer ("Seven.", "Skip.") is not taken for the question's echo (turnGate.ts).
  const convo = useConversation(token, answer, { interruptible: true, wake: false, fillers: false, answers: true });
  // The hook's own speaker belongs to the loop; the greeting happens before the
  // loop starts, so it gets one of its own and finishes before start() is called.
  const intro = useRef(createSpeaker(token));
  /** A line said outside the loop (the greeting, a question after Skip): the globe shows it speaking. */
  const speakIntro = async (line: string) => {
    setIntroSpeaking(true);
    try {
      await intro.current.speak(line, { filler: false });
    } catch (err) {
      logFail("onboarding: speaking")(err);
    } finally {
      setIntroSpeaking(false);
    }
  };

  /** Rings: the greeting and the first question out loud, then the voice loop listens. */
  const cancelledRef = useRef(false);
  const ring = async (next: OnboardingStep) => {
    const greeting =
      next.index === 0
        ? `Hi, I'm ${assistant}. A few quick questions so I can plan around your day. Just answer out loud, and say skip for any you'd rather not.`
        : "Picking up where we left off.";
    say({ from: "ovoa", text: greeting });
    say({ from: "ovoa", text: next.question });
    // Microphone access asked for first: asked after the greeting, the prompt
    // came up just as they started answering, and that first answer was lost.
    await requestRecordingPermissionsAsync().catch(logFail("onboarding: microphone permission"));
    if (cancelledRef.current) return;
    setCalling(true);
    await speakIntro(`${greeting} ${next.question}`);
    if (!cancelledRef.current && !typingRef.current) await convo.start();
  };

  useEffect(() => {
    cancelledRef.current = false;
    api
      .onboarding(token)
      .then(async (next) => {
        if (cancelledRef.current) return;
        if (next.done) return finish();
        setCurrent(next);
        // From the beginning: their voice first, then the call. Picking up
        // where they left off: straight back into it.
        if (next.index === 0) setPickingVoice(true);
        else await ring(next);
      })
      // Setup is part of the assistant. On the free plan the answer is needs_plan,
      // which already moved the plan to free, and the free app opens instead of
      // this; without consent (taken back on another phone, say) the consent
      // state moves the same way, and setup waits for it.
      .catch((err) => !isNeedsPlan(err) && !isNeedsConsent(err) && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelledRef.current = true;
      intro.current.stop();
    };
  }, [token]);

  const voicePicked = () => {
    setPickingVoice(false);
    const next = stepRef.current;
    if (next) void ring(next);
  };

  useEffect(() => {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [lines.length]);

  const skip = async () => {
    const current = stepRef.current;
    if (!current || busy) return;
    // The microphone closes while the next question is read, and opens again
    // after: left open, it heard the question and sent it as the next answer.
    const listening = callingRef.current && !typingRef.current;
    convo.end();
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
      setBusy(false);
      if (callingRef.current) await speakIntro(res.next.question);
      if (listening && !typingRef.current) void convo.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (listening) void convo.start();
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
      if (reply && callingRef.current) await speakIntro(reply);
    });
  };

  if (pickingVoice) {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.voicePage}>
          <Text style={styles.who}>How should I sound?</Text>
          <Text style={styles.voiceLead}>Pick a voice for {assistant}. You can change it any time in Settings.</Text>
          <VoiceList token={token} />
          <Btn label="Continue" kind="go" onPress={voicePicked} style={{ marginTop: 12 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  const talking = convo.phase === "listening";
  // Map roughly -60..-10 dBFS onto the halo, the same as the assistant's orb.
  const loudness = talking ? Math.max(0, Math.min(1, (convo.level + 60) / 50)) : 0;
  const phase = busy ? "thinking" : introSpeaking ? "speaking" : convo.phase;

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
          {/* The same particle globe as Talk; smaller while the keyboard is up. */}
          <OrbView mode={orbMode(calling, phase)} level={loudness} size={typing ? 72 : 170} />

          {/* The question, big, because it's the thing being answered; smaller
              with the keyboard up, so the box and its send button stay on screen. */}
          <Text style={[styles.question, typing && styles.questionSmall]} numberOfLines={typing ? 4 : undefined}>
            {step?.question ?? (busy ? "One moment…" : "")}
          </Text>
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
        {/* Last, right above the keyboard: nothing can sit between the box and it. */}
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
              submitBehavior="submit"
              // Not tied to `busy`: taking the box away mid-send closed the keyboard after every answer.
              editable={!!step}
              autoFocus
              // No AutoFill: iOS offered passwords and contacts over the send
              // button, straight after the sign-in screen.
              textContentType="none"
              autoComplete="off"
              importantForAutofill="no"
            />
            <Pressable style={styles.send} onPress={sendTyped} disabled={busy || !text.trim()} accessibilityLabel="Send">
              <Ionicons name="arrow-up" size={20} color={colors.paper} />
            </Pressable>
          </View>
        )}

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

function orbMode(calling: boolean, phase: string): OrbMode {
  if (!calling) return "off";
  if (phase === "listening" || phase === "thinking" || phase === "speaking") return phase;
  return "idle";
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

  stage: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 12 },
  voicePage: { paddingTop: 24, paddingBottom: 32, gap: 10 },
  voiceLead: { color: colors.inkMute, fontSize: 15, lineHeight: 21 },
  question: { color: colors.ink, fontSize: 21, lineHeight: 28, textAlign: "center", paddingHorizontal: 8 },
  questionSmall: { fontSize: 17, lineHeight: 23 },
  heard: { color: colors.now, fontSize: 16, lineHeight: 22, textAlign: "center", opacity: 0.9 },
  error: { color: colors.stop, textAlign: "center" },

  transcript: { flex: 1 },
  lines: { gap: 8, paddingVertical: 8 },
  bubble: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  ovoa: { alignSelf: "flex-start", backgroundColor: colors.wash, borderColor: colors.line, borderWidth: 1 },
  you: { alignSelf: "flex-end", backgroundColor: colors.now },
  bubbleText: { color: colors.ink, fontSize: 15, lineHeight: 21 },

  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingTop: 4, paddingBottom: 8 },
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
