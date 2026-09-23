import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAssistant } from "../lib/assistant";
import { useSession } from "../lib/auth";
import { colors } from "../lib/theme";
import { createSpeaker, voicePref, VOICES, type VoiceId } from "../lib/voice";

/** Engines with voices of their own, and how to say so. */
const ONE_VOICE: Record<string, string> = {
  device: "The assistant is using your iPhone's own voice right now. Your choice here picks the one that sounds closest.",
};

/** Picks the assistant's speaking voice and plays a short sample of it. */
export function VoicePicker({ token }: { token: string }) {
  const [selected, setSelected] = useState<VoiceId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const speaker = useRef(createSpeaker(token));
  const { hold } = useAssistant();
  const { user } = useSession();
  const note = ONE_VOICE[user?.ttsEngine ?? ""];

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
      {note && <Text style={styles.meta}>{note}</Text>}
      {VOICES.map((v) => (
        <Pressable key={v.id} style={styles.row} onPress={() => choose(v.id, v.label)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{v.label}</Text>
            <Text style={styles.meta}>{v.note}</Text>
          </View>
          {selected === v.id && <Ionicons name="checkmark" size={20} color={colors.now} />}
        </Pressable>
      ))}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  label: { color: colors.ink, fontSize: 15 },
  meta: { color: colors.inkMute, fontSize: 13 },
  error: { color: colors.stop, fontSize: 13 },
});
