import Ionicons from "@expo/vector-icons/Ionicons";
import { logFail } from "../lib/devlog";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/auth";
import { colors } from "../lib/theme";
import { createSpeaker } from "../lib/voice";

// Ask Claude directly (server: api/src/claude.ts). OVOA's own replies come from
// another model; this sends the prompt straight to Claude and shows its answer.
// By voice: "OVOA, ask Claude …".

type Exchange = { prompt: string; answer?: string; error?: string };

export default function AskClaude() {
  const { token } = useSession();
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt("");
    setBusy(true);
    setHistory((h) => [{ prompt: text }, ...h]);
    try {
      const { answer } = await api.askClaude(token, text);
      setHistory((h) => [{ prompt: text, answer }, ...h.slice(1)]);
    } catch (err) {
      const error = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      setHistory((h) => [{ prompt: text, error }, ...h.slice(1)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.paper }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Ask Claude anything"
          placeholderTextColor={colors.inkMute}
          multiline
        />
        <Pressable style={[styles.send, (!prompt.trim() || busy) && { opacity: 0.5 }]} onPress={send} disabled={!prompt.trim() || busy}>
          {busy ? <ActivityIndicator color={colors.paper} /> : <Ionicons name="arrow-up" size={20} color={colors.paper} />}
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {!history.length && <Text style={styles.dim}>Answers come from Claude (Anthropic), not OVOA's everyday model.</Text>}
        {history.map((x, i) => (
          <View key={i} style={styles.card}>
            <Text style={styles.prompt}>{x.prompt}</Text>
            {x.answer ? (
              <>
                <Text style={styles.answer} selectable>
                  {x.answer}
                </Text>
                <Pressable style={styles.speak} onPress={() => createSpeaker(token).speak(x.answer!).catch(logFail("claude: speak"))}>
                  <Ionicons name="volume-high" size={16} color={colors.now} />
                  <Text style={styles.speakText}>Read it out</Text>
                </Pressable>
              </>
            ) : x.error ? (
              <Text style={styles.error}>{x.error}</Text>
            ) : (
              <ActivityIndicator color={colors.now} style={{ alignSelf: "flex-start" }} />
            )}
          </View>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 16 },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 160,
    color: colors.ink,
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingTop: 13,
    paddingBottom: 13,
    fontSize: 16,
  },
  send: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.now, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, paddingTop: 0, gap: 12, paddingBottom: 40 },
  card: { backgroundColor: colors.wash, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 },
  prompt: { color: colors.now, fontSize: 15, fontWeight: "600" },
  answer: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  dim: { color: colors.inkMute, fontSize: 14, textAlign: "center", marginTop: 24 },
  error: { color: colors.stop },
  speak: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  speakText: { color: colors.now, fontWeight: "600" },
});
