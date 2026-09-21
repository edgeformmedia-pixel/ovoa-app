import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { api, type OnboardingStep } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog, logFail } from "../lib/devlog";
import { syncRoutines } from "../lib/routines";
import { colors } from "../lib/theme";

// Getting to know someone: nine short questions, answered in their own words
// (the keyboard's microphone works for talking instead of typing). Each answer
// is read on the server into times, routines and contacts, and what it
// understood is shown back straight away so a misreading gets caught here, not
// at 8am tomorrow. Every question can be skipped; "Finish later" stops asking.

type Line = { from: "ovoa" | "you"; text: string };

export default function Onboarding() {
  const { token, user, setUser } = useSession();
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const assistant = user?.settings.assistantName ?? "OVOA";

  const say = (line: Line) => setLines((l) => [...l, line]);

  const done = async () => {
    // Medications from setup go into Apple Reminders now, asking for Reminders access
    // at the moment it makes sense rather than on some later screen.
    await syncRoutines(token, { ask: true }).catch(logFail("onboarding: syncRoutines"));
    const { user } = await api.me(token);
    setUser(user);
  };

  const show = async (next: Awaited<ReturnType<typeof api.onboarding>>) => {
    if (next.done) return done();
    setStep(next);
    say({ from: "ovoa", text: next.question });
  };

  useEffect(() => {
    api
      .onboarding(token)
      .then((next) => {
        if (!next.done && next.index === 0) {
          say({
            from: "ovoa",
            text: `Hi, I'm ${assistant}. A few quick questions so I can plan around your day — skip anything you like.`,
          });
        }
        return show(next);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);

  useEffect(() => {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [lines.length]);

  const act = async (fn: () => Promise<{ understood: string | null; next: Awaited<ReturnType<typeof api.onboarding>> }>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (res.understood) say({ from: "ovoa", text: res.understood });
      await show(res.next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      devlog("err", "onboarding answer failed", message);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const answer = text.trim();
    if (!answer || !step || busy) return;
    say({ from: "you", text: answer });
    setText("");
    void act(() => api.onboardingAnswer(token, step.step, answer));
  };

  const skip = () => step && !busy && act(() => api.onboardingSkip(token, step.step));

  const later = async () => {
    setBusy(true);
    await api.onboardingFinish(token).catch(logFail("onboarding: api.onboardingFinish"));
    await done().catch(logFail("onboarding: done"));
    setBusy(false);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.head}>
        <Text style={styles.title}>Getting started</Text>
        {step && (
          <Text style={styles.dim}>
            {step.index + 1} of {step.total}
          </Text>
        )}
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={styles.lines}>
          {lines.map((line, i) => (
            <View key={i} style={[styles.bubble, line.from === "you" ? styles.you : styles.ovoa]}>
              <Text style={[styles.bubbleText, line.from === "you" && { color: colors.bg }]}>{line.text}</Text>
            </View>
          ))}
          {busy && <ActivityIndicator color={colors.accent} style={{ alignSelf: "flex-start", margin: 8 }} />}
          {error && <Text style={styles.error}>{error}</Text>}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type or use the keyboard's mic…"
            placeholderTextColor={colors.textDim}
            onSubmitEditing={send}
            returnKeyType="send"
            editable={!busy && !!step}
            multiline
          />
          <Pressable style={styles.send} onPress={send} disabled={busy || !text.trim()} accessibilityLabel="Send">
            <Ionicons name="arrow-up" size={20} color={colors.bg} />
          </Pressable>
        </View>
        <View style={styles.actions}>
          <Pressable onPress={skip} disabled={busy || !step}>
            <Text style={styles.link}>Skip this one</Text>
          </Pressable>
          <Pressable onPress={later} disabled={busy}>
            <Text style={styles.link}>Finish later</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", paddingVertical: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700" },
  dim: { color: colors.textDim, fontSize: 14 },
  lines: { gap: 10, paddingVertical: 8 },
  bubble: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  ovoa: { alignSelf: "flex-start", backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  you: { alignSelf: "flex-end", backgroundColor: colors.accent },
  bubbleText: { color: colors.text, fontSize: 16, lineHeight: 22 },
  error: { color: colors.danger, marginTop: 6 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingTop: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    color: colors.text,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 16,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12 },
  link: { color: colors.textDim, fontSize: 15 },
});
