import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApprovalCard } from "../../components/ApprovalCard";
import { DevLogPanel } from "../../components/DevLogPanel";
import { PartOfPlan } from "../../components/Plan";
import { TopBar } from "../../components/ui";
import { useAssistant } from "../../lib/assistant";
import { useSession } from "../../lib/auth";
import { usePlan } from "../../lib/plan";
import { colors, lift, space, type } from "../../lib/theme";
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
    <View style={styles.page}>
      <TopBar
        right={
          <Pressable style={styles.logs} hitSlop={10} onPress={() => setShowLogs((s) => !s)}>
            <Ionicons name="terminal-outline" size={15} color={showLogs ? colors.ink : colors.inkMute} />
            <Text style={[styles.logsText, showLogs && { color: colors.ink }]}>Logs</Text>
          </Pressable>
        }
      />

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
          {on && (
            <View
              style={[
                styles.halo,
                { transform: [{ scale: 1 + loudness * 0.3 }], opacity: 0.35 + loudness * 0.5 },
                a.phase === "speaking" && { backgroundColor: colors.agentWash },
              ]}
            />
          )}
          <View style={[styles.orb, !on && styles.orbOff]}>
            <Ring spinning={a.phase === "thinking"} lit={on} />
            <Ionicons
              name={!on ? "mic-off-outline" : a.phase === "speaking" ? "volume-high" : "mic-outline"}
              size={40}
              color={on ? colors.ink : colors.inkMute}
            />
          </View>
        </Pressable>

        <Text style={styles.phase}>{label(on, a.phase, a.status)}</Text>
        <Text style={styles.words} numberOfLines={4}>
          {a.words || " "}
        </Text>
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

      {showLogs && (
        <DevLogPanel
          live={`${on ? a.phase : "off"} · mic ${a.phase === "listening" ? `${Math.round(a.level)} dB` : "—"}${a.alwaysListen ? " · always listen" : ""}`}
          onClose={() => setShowLogs(false)}
        />
      )}
    </View>
  );
}

/**
 * The orb's ring. Two arcs rather than the study's conic gradient — nothing
 * here draws one without react-native-svg, and a border gives the two colours
 * that matter and can be spun, which is what Thinking needs it to do.
 */
function Ring({ spinning, lit }: { spinning: boolean; lit: boolean }) {
  const turn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!spinning) {
      turn.stopAnimation();
      turn.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spinning, turn]);

  return (
    <Animated.View
      style={[
        styles.ring,
        !lit && { borderColor: colors.line, borderTopColor: colors.line, borderRightColor: colors.line },
        { transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] },
      ]}
    />
  );
}

function label(on: boolean, phase: VoicePhase, status: string | null) {
  if (!on) return "Tap to talk";
  if (phase === "thinking") return status ?? "Thinking…";
  if (phase === "speaking") return "Speaking";
  // Parked: iOS won't open a microphone for an app that isn't on screen, so it
  // is waiting for this one. Saying "Listening" there was simply untrue.
  if (phase === "waiting") return "Waiting for you to open the app";
  return "Listening";
}

function hint(on: boolean, always: boolean, phase: VoicePhase) {
  if (!on) return "";
  if (always) return phase === "speaking" ? "Talk or tap to interrupt" : "Tap the orb to turn it off";
  return phase === "speaking" ? "Tap to interrupt" : "Tap to stop listening";
}

const ORB = 172;
const HALO = 208;

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

  voice: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.s3, paddingHorizontal: space.s5 },
  voiceSmall: { flex: 0, paddingVertical: space.s5, gap: space.s2 },

  orbWrap: { width: HALO, height: HALO, alignItems: "center", justifyContent: "center", marginBottom: space.s3 },
  halo: { position: "absolute", width: HALO, height: HALO, borderRadius: HALO / 2, backgroundColor: colors.nowWash },
  orb: {
    width: ORB,
    height: ORB,
    borderRadius: ORB / 2,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
    ...lift,
  },
  orbOff: { opacity: 0.6 },
  ring: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: ORB / 2,
    borderWidth: 3,
    // Teal into violet, the two ends of the study's gradient.
    borderColor: colors.agent,
    borderTopColor: colors.now,
    borderRightColor: colors.now,
  },

  phase: { ...type.phase, color: colors.ink },
  words: { ...type.body, color: colors.inkDim, textAlign: "center", minHeight: 48, maxWidth: 320 },
  hint: { ...type.sub, color: colors.inkMute },
  error: { ...type.meta, color: colors.stop, textAlign: "center" },

  answers: { maxHeight: "45%", flexGrow: 0 },
  autoRow: { paddingHorizontal: space.s5, paddingBottom: space.s2 },
});
