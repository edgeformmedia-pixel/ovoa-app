import Ionicons from "@expo/vector-icons/Ionicons";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { answerNag, useNags } from "../lib/nag";
import { colors } from "../lib/theme";

// What's going off right now, full screen: an alarm ("I'm awake"), a hard alarm
// (a step counter, no button), or an urgent reminder ("Done"). Saying it to OVOA
// works as well as tapping — "I'm awake", "I took my pill".

const HARD_STEPS = 20;

export function NagOverlay() {
  const nags = useNags();
  const top = nags[0];
  if (!top) return null;
  const alarm = top.kind === "alarm";
  return (
    <Modal visible animationType="fade" transparent={false} onRequestClose={() => {}}>
      <View style={styles.screen}>
        <Ionicons name={alarm ? "alarm" : "medkit"} size={72} color={colors.now} />
        <Text style={styles.title}>{alarm ? `Morning${top.name ? `, ${top.name}` : ""}` : "Don't forget"}</Text>
        <Text style={styles.label}>{top.label}</Text>

        {top.hard ? (
          <>
            <Text style={styles.steps}>
              {Math.min(top.steps, HARD_STEPS)} / {HARD_STEPS}
            </Text>
            <Text style={styles.hint}>steps — get up and walk. It stops at {HARD_STEPS}.</Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(1, top.steps / HARD_STEPS) * 100}%` }]} />
            </View>
          </>
        ) : (
          <>
            <Pressable style={styles.button} onPress={() => answerNag(top)}>
              <Text style={styles.buttonText}>{alarm ? "I'm awake" : "Done"}</Text>
            </Pressable>
            <Text style={styles.hint}>{alarm ? 'Or say "Hey OVOA, I\'m awake."' : 'Or say "Hey OVOA, I did it."'}</Text>
          </>
        )}
        {nags.length > 1 && <Text style={styles.hint}>{nags.length - 1} more waiting</Text>}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  title: { color: colors.ink, fontSize: 34, fontWeight: "800", textAlign: "center" },
  label: { color: colors.inkMute, fontSize: 18, textAlign: "center" },
  steps: { color: colors.now, fontSize: 64, fontWeight: "800", fontVariant: ["tabular-nums"] },
  hint: { color: colors.inkMute, fontSize: 14, textAlign: "center" },
  track: { alignSelf: "stretch", height: 12, borderRadius: 6, backgroundColor: colors.wash2, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: colors.done },
  button: { backgroundColor: colors.now, borderRadius: 16, paddingVertical: 18, paddingHorizontal: 48, marginTop: 12 },
  buttonText: { color: colors.paper, fontSize: 20, fontWeight: "800" },
});
