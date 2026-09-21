import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApprovalCard } from "../../components/ApprovalCard";
import { DevLogPanel } from "../../components/DevLogPanel";
import { useAssistant } from "../../lib/assistant";
import { useSession } from "../../lib/auth";
import { colors, shadow } from "../../lib/theme";
import type { VoicePhase } from "../../lib/voice";

/** The assistant, by voice only. Listening itself runs in AssistantProvider. */
export default function Assistant() {
  const { user } = useSession();
  const a = useAssistant();
  const [showLogs, setShowLogs] = useState(false);
  const assistantName = user?.settings.assistantName ?? "OVOA";
  const on = a.alwaysListen || !!a.enabled;
  // Map roughly -60..-10 dBFS onto the halo while listening.
  const loudness = a.phase === "listening" ? Math.max(0, Math.min(1, (a.level + 60) / 50)) : 0;

  const onOrb = () => {
    if (a.phase === "speaking") a.interrupt();
    // Always listen is always one tap from off.
    else if (a.alwaysListen) a.setAlwaysListen(false);
    else a.toggleEnabled();
  };

  return (
    <View style={styles.screen}>
      <Pressable style={styles.logsToggle} hitSlop={10} onPress={() => setShowLogs((s) => !s)}>
        <Ionicons name="terminal-outline" size={16} color={showLogs ? colors.accent : colors.textDim} />
        <Text style={[styles.logsText, showLogs && { color: colors.accent }]}>Logs</Text>
      </Pressable>

      {a.alwaysListen && (
        <Pressable style={styles.alwaysBar} onPress={() => a.setAlwaysListen(false)}>
          <Ionicons name="ear" size={16} color={colors.bg} />
          <Text style={styles.alwaysText}>Always listen is on · tap to turn off</Text>
        </Pressable>
      )}

      <View style={styles.center}>
        <Pressable
          onPress={onOrb}
          disabled={a.enabled === null}
          style={[styles.orbWrap, showLogs && styles.orbWrapSmall]}
          accessibilityRole="button"
          accessibilityLabel={on ? `Stop listening to ${assistantName}` : `Start listening to ${assistantName}`}
        >
          {on && (
            <View
              style={[
                styles.halo,
                a.phase === "speaking" && { backgroundColor: colors.success },
                { transform: [{ scale: 1 + loudness * 0.35 }], opacity: 0.12 + loudness * 0.35 },
              ]}
            />
          )}
          {/* The logo's white ring is the orb; the glow behind it shows what it's doing. */}
          <View style={[styles.orb, !on && styles.orbOff]}>
            <Image source={require("../../../assets/orb-ring.png")} style={styles.ring} resizeMode="cover" />
            <View style={styles.orbIcon}>
              {a.phase === "thinking" ? (
                <ActivityIndicator size="large" color={colors.accent} />
              ) : (
                <Ionicons
                  name={!on ? "mic-off" : a.phase === "speaking" ? "volume-high" : "mic"}
                  size={34}
                  color={!on ? colors.textDim : a.phase === "speaking" ? colors.success : colors.accent}
                />
              )}
            </View>
          </View>
        </Pressable>
        <Text style={styles.label}>{label(on, a.phase, a.status)}</Text>
        {!!a.words && (
          <Text style={styles.words} numberOfLines={4}>
            {a.words}
          </Text>
        )}
        <Text style={styles.hint}>{hint(on, a.alwaysListen, a.phase)}</Text>
        {a.error && <Text style={styles.error}>{a.error}</Text>}
      </View>

      {(a.approvals.length > 0 || a.autoRunning) && (
        <ScrollView style={styles.cards} contentContainerStyle={{ paddingBottom: 8 }}>
          {a.autoRunning && (
            <View style={styles.autoRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={styles.hint}>Doing it for you…</Text>
            </View>
          )}
          {a.approvals.map((action) => (
            <ApprovalCard
              key={action.id}
              action={action}
              onApprove={(approval) => a.approve(action, approval)}
              onCancel={() => a.cancel(action.id)}
            />
          ))}
        </ScrollView>
      )}

      {showLogs && (
        <DevLogPanel
          live={`${on ? a.phase : "off"} · mic ${a.phase === "listening" ? `${Math.round(a.level)} dB` : "—"}${a.alwaysListen ? " · always listen" : ""}`}
          onClose={() => setShowLogs(false)}
        />
      )}
    </View>
  );
}

function label(on: boolean, phase: VoicePhase, status: string | null) {
  if (!on) return "Tap to start listening";
  if (phase === "thinking") return status ?? "Thinking…";
  if (phase === "speaking") return "Speaking";
  return "Listening";
}

function hint(on: boolean, always: boolean, phase: VoicePhase) {
  if (!on) return "";
  if (always) return phase === "speaking" ? "Talk or tap to interrupt" : "Always listen is on · tap the orb to turn it off";
  return phase === "speaking" ? "Tap to interrupt" : "Tap to stop listening";
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  logsToggle: {
    position: "absolute",
    top: 10,
    right: 14,
    zIndex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  logsText: { color: colors.textDim, fontSize: 13, fontWeight: "600" },
  alwaysBar: {
    position: "absolute",
    top: 10,
    left: 14,
    zIndex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.danger,
  },
  alwaysText: { color: colors.bg, fontSize: 13, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 24 },
  orbWrap: { width: 240, height: 240, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  orbWrapSmall: { transform: [{ scale: 0.6 }], marginVertical: -60 },
  halo: { position: "absolute", width: 210, height: 210, borderRadius: 105, backgroundColor: colors.accent },
  orb: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    ...shadow,
  },
  orbOff: { opacity: 0.55 },
  ring: { position: "absolute", width: 180, height: 180, borderRadius: 90 },
  orbIcon: { alignItems: "center", justifyContent: "center" },
  label: { color: colors.text, fontSize: 22, fontWeight: "300", letterSpacing: 1 },
  hint: { color: colors.textDim, fontSize: 14 },
  words: { color: colors.text, fontSize: 18, lineHeight: 25, textAlign: "center", opacity: 0.85 },
  error: { color: colors.danger, textAlign: "center", marginTop: 8 },
  cards: { maxHeight: "45%", flexGrow: 0 },
  autoRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
});
