import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useClip } from "../lib/clip";
import { probeMinutes, runProbe, stopProbe, useProbe, type StepResult, type Verdict } from "../lib/motionProbe";
import { colors } from "../lib/theme";

// Tries every way the ES100 might report motion, one at a time, and uploads what each did
// (device_logs, kind "probe"). See lib/motionProbe.ts.

const VERDICT_COLORS: Record<Verdict, string> = {
  WIN: colors.success,
  FLAT: colors.warning,
  SLOW: colors.warning,
  "ONE-SHOT": colors.danger,
  SILENT: colors.textDim,
  SKIPPED: colors.textDim,
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
          Tries each way the clip might report motion, one at a time. For each one: hold still, then twist when the
          phone buzzes. Takes about {probeMinutes} minutes. Keep the app open; results upload to the logs as they
          finish.
        </Text>

        {probe.running ? (
          <View style={[styles.card, twisting && styles.cardTwist]}>
            <Text style={styles.dim}>
              {probe.step + 1} of {probe.total}
            </Text>
            <Text style={styles.what}>{probe.what}</Text>
            <Text style={[styles.instruction, twisting && { color: colors.accent }]}>{probe.instruction}</Text>
            <Text style={styles.mono}>
              {probe.samples} samples · {probe.raw} raw packets
            </Text>
            <Pressable style={[styles.button, styles.stop]} onPress={stopProbe}>
              <Text style={[styles.buttonText, { color: colors.danger }]}>Stop</Text>
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
                ? `${probe.winner.what}: ${probe.winner.hz} samples/s, twist moves value ${probe.winner.channel} (score ${probe.winner.score}). Twist to listen will try it first; calibrate again in Dev tools.`
                : "No source sent motion that twisting moved. The results are in the logs."}
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
        {r.counts.still + r.counts.twist} samples · {r.hz}/s · score {r.score} · raw {r.raw.still}→{r.raw.twist}
      </Text>
      {!!r.note && <Text style={styles.dim}>{r.note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 20, gap: 10, paddingBottom: 48 },
  section: { color: colors.text, fontSize: 17, fontWeight: "600", marginTop: 12 },
  dim: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  cardTwist: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  badge: { fontSize: 13, fontWeight: "700" },
  what: { color: colors.text, fontSize: 15, fontWeight: "600", marginTop: 2 },
  instruction: { color: colors.text, fontSize: 24, fontWeight: "700", marginVertical: 10 },
  value: { color: colors.text, fontSize: 14, lineHeight: 20 },
  mono: { color: colors.text, fontFamily: "Menlo", fontSize: 12 },
  button: {
    backgroundColor: colors.accentDim,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  stop: { backgroundColor: colors.bg, borderColor: colors.danger, borderWidth: 1 },
  disabled: { opacity: 0.5 },
  buttonText: { color: colors.accent, fontWeight: "600", fontSize: 15 },
});
