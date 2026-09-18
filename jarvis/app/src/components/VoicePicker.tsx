import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAssistant } from "../lib/assistant";
import { colors } from "../lib/theme";
import { createSpeaker, voicePref, VOICES, type VoiceId } from "../lib/voice";

/** Picks the assistant's speaking voice and plays a short sample of it. */
export function VoicePicker({ token }: { token: string }) {
  const [selected, setSelected] = useState<VoiceId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const speaker = useRef(createSpeaker(token));
  const { hold } = useAssistant();

  useEffect(() => {
    voicePref.get().then(setSelected);
    speaker.current = createSpeaker(token);
    return () => speaker.current.stop();
  }, [token]);

  const choose = async (id: VoiceId, label: string) => {
    setSelected(id);
    setError(null);
    await voicePref.set(id);
    // Pause listening so Always listen doesn't hear the sample as a question.
    hold(() => speaker.current.speak(`Hi, I'm ${label}. This is how I'll sound when we talk.`))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't play a sample"));
  };

  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.meta}>How the assistant sounds. Tap a voice to hear it.</Text>
      {VOICES.map((v) => (
        <Pressable key={v.id} style={styles.row} onPress={() => choose(v.id, v.label)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{v.label}</Text>
            <Text style={styles.meta}>{v.note}</Text>
          </View>
          {selected === v.id && <Ionicons name="checkmark" size={20} color={colors.accent} />}
        </Pressable>
      ))}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  label: { color: colors.text, fontSize: 15 },
  meta: { color: colors.textDim, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
});
