import * as Clipboard from "expo-clipboard";
import * as MailComposer from "expo-mail-composer";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatDevLog, logFail, recentLog } from "../lib/devlog";
import { logSnapshot, logStatus, sendBugReport } from "../lib/remoteLog";
import { colors } from "../lib/theme";

// One tap between "it did something odd" and a row in device_logs that can be
// found with `WHERE text LIKE 'BUG REPORT%'`. Before this, a tester who wasn't
// the developer had no way to say anything at all, and the developer had to
// guess which of 90,000 rows to read.

/** How much of the log the screen shows. All of it still goes with the report. */
const PREVIEW_LINES = 40;

export default function ReportBug() {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const status = logStatus();
  const entries = recentLog();

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const { ok, detail } = await sendBugReport(note);
      setResult(detail);
      if (ok) setTimeout(() => router.back(), 1200);
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const email = async () => {
    const body = `${note.trim()}\n\n${logSnapshot()}`;
    if (!(await MailComposer.isAvailableAsync().catch(() => false))) {
      await Clipboard.setStringAsync(body);
      setResult("No mail account on this phone, so it's on the clipboard instead.");
      return;
    }
    await MailComposer.composeAsync({ subject: `OVOA problem — ${status.build}`, body }).catch(
      logFail("report: MailComposer.composeAsync"),
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.lead}>What happened? Even one line helps — "asked for the weather, it said nothing".</Text>
        <TextInput
          style={styles.input}
          value={note}
          onChangeText={setNote}
          multiline
          autoFocus
          placeholder="What you did, and what it did instead"
          placeholderTextColor={colors.inkMute}
        />

        <Pressable style={[styles.send, sending && { opacity: 0.6 }]} disabled={sending} onPress={send}>
          {sending ? <ActivityIndicator color={colors.paper} /> : <Text style={styles.sendText}>Send report</Text>}
        </Pressable>
        {!!result && <Text style={styles.result}>{result}</Text>}

        <View style={styles.row}>
          <Pressable
            style={styles.button}
            onPress={() => {
              Clipboard.setStringAsync(logSnapshot()).catch(logFail("report: Clipboard.setStringAsync"));
              setResult("Copied.");
            }}
          >
            <Text style={styles.buttonText}>Copy everything</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={() => void email()}>
            <Text style={styles.buttonText}>Email it</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>What gets sent</Text>
        <View style={styles.card}>
          <Row label="build" value={status.build} />
          <Row label="phone" value={`${status.state} · net ${status.net} · ${status.diskMB ?? "?"} MB free`} />
          <Row label="signed in" value={status.signedIn ? "yes" : "no"} />
          <Row label="waiting to upload" value={`${status.queued} lines${status.droppedTotal ? ` · ${status.droppedTotal} dropped` : ""}`} />
          <Row label="log lines" value={String(entries.length)} />
          <Text style={styles.hint}>
            The last {entries.length} lines of what the app did, the events leading up to any error, and the numbers
            above. No passwords, no sign-in tokens, and email addresses are shortened.
          </Text>
        </View>

        <Text style={styles.section}>The last {Math.min(PREVIEW_LINES, entries.length)} lines</Text>
        <Text style={styles.log} selectable>
          {formatDevLog(entries.slice(-PREVIEW_LINES)) || "Nothing yet."}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.dataRow}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={styles.value} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  body: { padding: 16, paddingBottom: 48, gap: 12 },
  lead: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  input: {
    backgroundColor: colors.wash2,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 110,
    padding: 12,
    textAlignVertical: "top",
  },
  send: { backgroundColor: colors.now, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  sendText: { color: colors.paper, fontSize: 15, fontWeight: "700" },
  result: { color: colors.done, fontSize: 13 },
  row: { flexDirection: "row", gap: 8 },
  button: { flex: 1, backgroundColor: colors.wash2, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: colors.now, fontSize: 14, fontWeight: "600" },
  section: { color: colors.inkMute, fontSize: 12, fontWeight: "600", letterSpacing: 1, marginTop: 14 },
  card: { backgroundColor: colors.wash, borderColor: colors.line, borderWidth: 1, borderRadius: 12, padding: 14, gap: 4 },
  dataRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, paddingVertical: 2 },
  dim: { color: colors.inkMute, fontSize: 13 },
  value: { color: colors.ink, fontSize: 13, flexShrink: 1 },
  hint: { color: colors.inkMute, fontSize: 12, marginTop: 8, lineHeight: 17 },
  log: { color: colors.inkMute, fontFamily: "Menlo", fontSize: 10, lineHeight: 14 },
});
