import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApprovalCard } from "../../components/ApprovalCard";
import { DevLogPanel } from "../../components/DevLogPanel";
import { WordsIn } from "../../components/motion";
import { OrbView, type OrbMode } from "../../components/OrbView";
import { PartOfPlan } from "../../components/Plan";
import { TopBar } from "../../components/ui";
import { setOpenApp, useOpenApp } from "../../lib/activeApp";
import { useAssistant } from "../../lib/assistant";
import { useSession } from "../../lib/auth";
import { useDevMode } from "../../lib/devMode";
import { usePlan } from "../../lib/plan";
import { colors, space, type } from "../../lib/theme";
import type { VoicePhase } from "../../lib/voice";

// The assistant, by voice only. Listening itself runs in AssistantProvider.
// One thing on the screen at a time: the orb, the word for what it is doing,
// and what it heard. Anything that needs an answer comes in underneath with a
// teal rail, the same way a moment on the spine does.

export default function Assistant() {
  const { can } = usePlan();
  if (!can.voice) {
    return (
      <PartOfPlan
        title="Talk"
        needs="base"
        what="Talk to OVOA and it answers out loud: your calendar, reminders, email, money, and what it remembers about you."
      />
    );
  }
  return <Talk />;
}

function Talk() {
  const { user } = useSession();
  const a = useAssistant();
  // One of their own apps, opened from Apps: what they say now follows its instructions.
  const openApp = useOpenApp();
  const [showLogs, setShowLogs] = useState(false);
  const devMode = useDevMode();
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
    <View style={styles.page}>
      <TopBar
        right={
          devMode ? (
            <Pressable style={styles.logs} hitSlop={10} onPress={() => setShowLogs((s) => !s)}>
              <Ionicons name="terminal-outline" size={15} color={showLogs ? colors.ink : colors.inkMute} />
              <Text style={[styles.logsText, showLogs && { color: colors.ink }]}>Logs</Text>
            </Pressable>
          ) : undefined
        }
      />

      {openApp && (
        <View style={styles.appBar}>
          <Ionicons name="apps-outline" size={16} color={colors.agent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.appName} numberOfLines={1}>
              Using {openApp.name}
            </Text>
            {!!openApp.opener && (
              <Text style={styles.appOpener} numberOfLines={2}>
                {openApp.opener}
              </Text>
            )}
          </View>
          <Pressable onPress={() => setOpenApp(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Close ${openApp.name}`}>
            <Ionicons name="close" size={18} color={colors.inkMute} />
          </Pressable>
        </View>
      )}

      {a.alwaysListen && (
        <Pressable style={styles.alwaysBar} onPress={() => a.setAlwaysListen(false)}>
          <Ionicons name="ear" size={16} color={colors.stop} />
          <Text style={styles.alwaysText}>Always listen is on · tap to turn off</Text>
        </Pressable>
      )}

      <View style={[styles.voice, showLogs && styles.voiceSmall]}>
        <Pressable
          onPress={onOrb}
          disabled={a.enabled === null}
          style={styles.orbWrap}
          accessibilityRole="button"
          accessibilityLabel={on ? `Stop listening to ${assistantName}` : `Start listening to ${assistantName}`}
        >
          <OrbView mode={orbMode(on, a.phase)} level={loudness} size={showLogs ? 150 : ORB} />
        </Pressable>

        <Text style={styles.phase}>{label(on, a.phase, a.status)}</Text>
        <WordsIn text={a.words} style={styles.words} />
        <Text style={styles.hint}>{hint(on, a.alwaysListen, a.phase)}</Text>
        {!!a.error && <Text style={styles.error}>{a.error}</Text>}
      </View>

      {(a.approvals.length > 0 || a.autoRunning) && (
        <ScrollView style={styles.answers} contentContainerStyle={{ paddingBottom: space.s2 }}>
          {a.autoRunning && (
            <View style={styles.autoRow}>
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

      {showLogs && devMode && (
        <DevLogPanel
          live={`${on ? a.phase : "off"} · mic ${a.phase === "listening" ? `${Math.round(a.level)} dB` : "—"}${a.alwaysListen ? " · always listen" : ""}`}
          onClose={() => setShowLogs(false)}
        />
      )}
    </View>
  );
}

/** What the globe shows for where the conversation is (components/Orb.tsx). */
function orbMode(on: boolean, phase: VoicePhase): OrbMode {
  if (!on) return "off";
  if (phase === "listening") return "listening";
  if (phase === "thinking") return "thinking";
  if (phase === "speaking") return "speaking";
  return "idle";
}

function label(on: boolean, phase: VoicePhase, status: string | null) {
  if (!on) return "Tap to talk";
  if (phase === "thinking") return status ?? "Thinking…";
  if (phase === "speaking") return "Speaking";
  // Parked: iOS won't open a microphone for an app that isn't on screen, so it
  // is waiting for this one. Saying "Listening" there was simply untrue.
  if (phase === "waiting") return "Waiting for you to open the app";
  // On, but the microphone isn't open yet, or something else has it for now (the tour).
  if (phase === "off") return "Paused";
  return "Listening";
}

function hint(on: boolean, always: boolean, phase: VoicePhase) {
  if (!on) return "";
  if (always) return phase === "speaking" ? "Talk or tap to interrupt" : "Tap the orb to turn it off";
  return phase === "speaking" ? "Tap to interrupt" : "Tap to stop listening";
}

/** The globe's canvas; the points sit well inside it, and the glow fills the rest. */
const ORB = 240;

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },

  logs: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s1,
    paddingHorizontal: space.s3,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.wash,
  },
  logsText: { ...type.meta, fontWeight: "600", color: colors.inkMute },

  alwaysBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    marginHorizontal: space.s5,
    paddingHorizontal: space.s4,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: colors.stopWash,
  },
  alwaysText: { ...type.meta, fontWeight: "600", color: colors.stop, flex: 1 },

  // Violet: the app is theirs, not something happening now.
  appBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    marginHorizontal: space.s5,
    marginBottom: space.s2,
    paddingHorizontal: space.s4,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: colors.agentWash,
  },
  appName: { ...type.meta, fontWeight: "600", color: colors.agent },
  appOpener: { ...type.meta, color: colors.inkDim },

  voice: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.s3, paddingHorizontal: space.s5 },
  voiceSmall: { flex: 0, paddingVertical: space.s5, gap: space.s2 },

  orbWrap: { alignItems: "center", justifyContent: "center" },

  phase: { ...type.phase, color: colors.ink },
  words: { ...type.body, color: colors.inkDim, textAlign: "center", minHeight: 48, maxWidth: 320 },
  hint: { ...type.sub, color: colors.inkMute },
  error: { ...type.meta, color: colors.stop, textAlign: "center" },

  answers: { maxHeight: "45%", flexGrow: 0 },
  autoRow: { paddingHorizontal: space.s5, paddingBottom: space.s2 },
});
