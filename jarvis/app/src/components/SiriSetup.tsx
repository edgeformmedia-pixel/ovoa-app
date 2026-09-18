import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { api } from "../lib/api";
import { colors } from "../lib/theme";

/**
 * Siri works through an "Ask OVOA" shortcut the user builds in the Shortcuts
 * app. It posts what they said to /siri with a long-lived key, and Siri reads
 * the reply aloud.
 */
export function SiriSetup({ token }: { token: string }) {
  const [setup, setSetup] = useState<{ key: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      setSetup(await api.createSiriKey(token));
    } catch (err) {
      Alert.alert("Couldn't set up Siri", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = () =>
    Alert.alert("Turn off Siri?", "Your Ask OVOA shortcut will stop working.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Turn off",
        style: "destructive",
        onPress: async () => {
          await api.deleteSiriKey(token).catch(() => {});
          setSetup(null);
        },
      },
    ]);

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied");
  };

  if (!setup) {
    return (
      <View style={{ gap: 10 }}>
        <Text style={styles.meta}>
          Say "Hey Siri, Ask OVOA" to talk to your assistant hands-free. It can answer, use Google, and prepare
          phone actions for you to approve in the app.
        </Text>
        <Pressable style={styles.button} onPress={create} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.buttonText}>Set up Siri</Text>}
        </Pressable>
        <Pressable onPress={revoke} hitSlop={8}>
          <Text style={styles.link}>Turn off an existing shortcut</Text>
        </Pressable>
      </View>
    );
  }

  const header = `Bearer ${setup.key}`;
  return (
    <View style={{ gap: 10 }}>
      <Text style={styles.meta}>
        Build the shortcut once. This key is shown only now; setting up again replaces it.
      </Text>
      <Step n={1}>Open Shortcuts, tap +, and name the shortcut "Ask OVOA".</Step>
      <Step n={2}>Add the "Dictate Text" action.</Step>
      <Step n={3}>
        Add "Get Contents of URL". Paste the URL, set Method to POST, add a header named Authorization with the
        key below, and set Request Body to JSON with a text field named message set to Dictated Text.
      </Step>
      <Step n={4}>Add "Speak Text" and set it to Contents of URL.</Step>
      <Step n={5}>Say "Hey Siri, Ask OVOA".</Step>

      <CopyRow label="URL" value={setup.url} onCopy={() => copy(setup.url)} />
      <CopyRow label="Authorization header" value={`Bearer ${setup.key.slice(0, 6)}…`} onCopy={() => copy(header)} />

      <Pressable style={styles.button} onPress={() => Linking.openURL("shortcuts://create-shortcut")}>
        <Text style={styles.buttonText}>Open Shortcuts</Text>
      </Pressable>
      <Pressable onPress={revoke} hitSlop={8}>
        <Text style={[styles.link, { color: colors.danger }]}>Turn off Siri</Text>
      </Pressable>
    </View>
  );
}

function Step({ n, children }: { n: number; children: string }) {
  return (
    <View style={styles.step}>
      <Text style={styles.stepNumber}>{n}</Text>
      <Text style={styles.stepText}>{children}</Text>
    </View>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <View style={styles.copyRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.meta}>{label}</Text>
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Pressable onPress={onCopy} hitSlop={8}>
        <Text style={styles.link}>Copy</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  step: { flexDirection: "row", gap: 10 },
  stepNumber: { color: colors.accent, fontWeight: "700", width: 14 },
  stepText: { color: colors.text, fontSize: 14, lineHeight: 20, flex: 1 },
  copyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surfaceHigh,
    borderRadius: 10,
    padding: 10,
  },
  value: { color: colors.text, fontSize: 14, marginTop: 2 },
  link: { color: colors.accent, fontWeight: "600" },
  button: { backgroundColor: colors.surfaceHigh, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: colors.accent, fontWeight: "600", fontSize: 15 },
});
