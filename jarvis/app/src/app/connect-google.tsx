import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSession } from "../lib/auth";
import { connectGoogle, GOOGLE_APPS } from "../lib/google";
import { colors } from "../lib/theme";

// Shown once, right after sign-up.
export default function ConnectGoogle() {
  const { token, user, finishOnboarding } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assistant = user?.settings.assistantName ?? "OVOA";

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectGoogle(token);
      if (result.ok) return finishOnboarding();
      if (!result.cancelled) setError(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect to Google");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        <Ionicons name="logo-google" size={48} color={colors.text} />
        <Text style={styles.title}>Connect your Google account</Text>
        <Text style={styles.text}>
          Let {assistant} work with your Google apps: read and send email, manage your calendar, and edit your
          files.
        </Text>
        <View style={styles.apps}>
          {GOOGLE_APPS.map((app) => (
            <View key={app} style={styles.chip}>
              <Text style={styles.chipText}>{app}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.note}>
          {assistant} always asks before sending email, deleting anything, or inviting people. You can disconnect
          any time in Settings.
        </Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={[styles.primary, busy && { opacity: 0.6 }]} onPress={connect} disabled={busy}>
        {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>Continue with Google</Text>}
      </Pressable>
      <Pressable style={styles.skip} onPress={finishOnboarding} disabled={busy}>
        <Text style={styles.skipText}>Skip for now</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 24 },
  body: { flex: 1, justifyContent: "center", alignItems: "center", gap: 16 },
  title: { color: colors.text, fontSize: 26, fontWeight: "700", textAlign: "center" },
  text: { color: colors.textDim, fontSize: 16, lineHeight: 23, textAlign: "center" },
  apps: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginVertical: 4 },
  chip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: colors.text, fontSize: 13 },
  note: { color: colors.textDim, fontSize: 13, lineHeight: 19, textAlign: "center" },
  error: { color: colors.danger, textAlign: "center", marginBottom: 12 },
  primary: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 16, alignItems: "center" },
  primaryText: { color: colors.bg, fontSize: 16, fontWeight: "700" },
  skip: { alignItems: "center", paddingVertical: 16 },
  skipText: { color: colors.textDim, fontSize: 15 },
});
