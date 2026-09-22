import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useClip } from "../lib/clip";
import { probeMinutes, runProbe, stopProbe, useProbe, type StepResult, type Verdict } from "../lib/motionProbe";
import { colors } from "../lib/theme";

// Tries every way the ES100 might report motion, one at a time, and uploads what each did
// (device_logs, kind "probe"). See lib/motionProbe.ts.

const VERDICT_COLORS: Record<Verdict, string> = {
  WIN: colors.done,
  FLAT: colors.late,
  SLOW: colors.late,
  "ONE-SHOT": colors.stop,
  SILENT: colors.inkMute,
  SKIPPED: colors.inkMute,
};

export default function MotionLab() {
  const clipState = useClip();
  const probe = useProbe();
  const connected = clipState.phase === "connected";
  const twisting = probe.instruction?.startsWith("Twist");

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.dim}>
          Tries the ways the clip might report motion faster, one at a time: the gyroscope's stream, the gyroscope read
          on request (1, 2 and 3 times a second) and one more accelerometer variant. For each one: rest your forearm and
          hold still, then twist back and forth when the phone buzzes, until it says stop. Between them it waits for the
          clip to answer again. Takes about {probeMinutes} minutes, longer if the clip stalls. Keep the app open; results
          upload to the logs as they finish.
        </Text>

        {probe.running ? (
          <View style={[styles.card, twisting && styles.cardTwist]}>
            <Text style={styles.dim}>
              {probe.step + 1} of {probe.total}
            </Text>
            <Text style={styles.what}>{probe.what}</Text>
            <Text style={[styles.instruction, twisting && { color: colors.blue }]}>{probe.instruction}</Text>
            <Text style={styles.mono}>
              {probe.samples} samples · {probe.raw} raw packets
            </Text>
            <Pressable style={[styles.button, styles.stop]} onPress={stopProbe}>
              <Text style={[styles.buttonText, { color: colors.stop }]}>Stop</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Pressable style={[styles.button, !connected && styles.disabled]} disabled={!connected} onPress={runProbe}>
              <Text style={styles.buttonText}>{probe.finishedAt ? "Run again" : "Run motion probe"}</Text>
            </Pressable>
            {!connected && <Text style={styles.dim}>Connect the clip first (Dev tools → ES100 recorder).</Text>}
          </>
        )}

        {probe.error && <Text style={styles.error}>{probe.error}</Text>}

        {!probe.running && probe.finishedAt && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Result</Text>
            <Text style={styles.value}>
              {probe.winner
                ? `${probe.winner.what}: ${probe.winner.hz} readings/s, twisting moves ${probe.winner.channel} (score ${probe.winner.score}). ` +
                  (probe.winner.source === "gyro3"
                    ? "Twist to listen already uses it."
                    : "Twist to listen will try it first; calibrate the twist again in Dev tools.")
                : "No source beat the default: twist to listen keeps using the gyroscope test (gyro3). The results are in the logs."}
            </Text>
          </View>
        )}

        {probe.results.length > 0 && <Text style={styles.section}>Sources</Text>}
        {probe.results.map((r) => (
          <ResultRow key={r.id} result={r} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function ResultRow({ result: r }: { result: StepResult }) {
  return (
    <View style={styles.card}>
      <View style={styles.rowHead}>
        <Text style={styles.cardTitle}>{r.id}</Text>
        <Text style={[styles.badge, { color: VERDICT_COLORS[r.verdict] }]}>
          {r.verdict}
          {r.breaks ? " · BREAKS CLIP" : ""}
        </Text>
      </View>
      <Text style={styles.dim}>{r.what}</Text>
      <Text style={styles.mono}>
        {r.counts.still + r.counts.twist} readings ({r.distinct} different) · {r.hz}/s · score {r.score}
        {r.channel ? ` (${r.channel})` : ""}
      </Text>
      <Text style={styles.mono}>
        first after {r.firstMs === null ? "—" : `${(r.firstMs / 1000).toFixed(1)} s`} · raw {r.raw.still}→{r.raw.twist}
        {r.recoveredMs ? ` · clip back after ${Math.round(r.recoveredMs / 1000)} s` : r.recoveredMs === null ? " · clip didn't come back" : ""}
      </Text>
      {!!r.note && <Text style={styles.dim}>{r.note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  body: { padding: 20, gap: 10, paddingBottom: 48 },
  section: { color: colors.ink, fontSize: 17, fontWeight: "600", marginTop: 12 },
  dim: { color: colors.inkMute, fontSize: 13, lineHeight: 18 },
  error: { color: colors.stop, fontSize: 13 },
  card: {
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  cardTwist: { borderColor: colors.blue, backgroundColor: colors.nowWash },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  badge: { fontSize: 13, fontWeight: "700" },
  what: { color: colors.ink, fontSize: 15, fontWeight: "600", marginTop: 2 },
  instruction: { color: colors.ink, fontSize: 24, fontWeight: "700", marginVertical: 10 },
  value: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  mono: { color: colors.ink, fontFamily: "Menlo", fontSize: 12 },
  button: {
    backgroundColor: colors.nowWash,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  stop: { backgroundColor: colors.paper, borderColor: colors.stop, borderWidth: 1 },
  disabled: { opacity: 0.5 },
  buttonText: { color: colors.blue, fontWeight: "600", fontSize: 15 },
});
