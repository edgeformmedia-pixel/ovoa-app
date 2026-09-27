import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View, type TextStyle } from "react-native";
import { api, type MicrosoftStatus } from "../lib/api";
import { connectMicrosoft } from "../lib/google";
import { colors } from "../lib/theme";

/**
 * Outlook / Microsoft 365 mail and calendar (api/src/microsoft.ts). Renders
 * nothing until the server is set up for Microsoft, so today's builds look the
 * same as before.
 */
export function MicrosoftConnection({ token, headerStyle }: { token: string; headerStyle?: TextStyle }) {
  const [status, setStatus] = useState<MicrosoftStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api
      .microsoftStatus(token)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [token]);
  useFocusEffect(refresh);

  if (!status?.available) return null;

  const connect = async () => {
    setBusy(true);
    try {
      const result = await connectMicrosoft(token);
      if (!result.ok && !result.cancelled) Alert.alert("Couldn't connect", result.message);
    } catch (err) {
      Alert.alert("Couldn't connect", (err as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const disconnect = () =>
    Alert.alert("Disconnect Outlook?", "The assistant will lose access to your Outlook mail and calendar.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await api.microsoftDisconnect(token).catch(() => {});
          refresh();
        },
      },
    ]);

  return (
    <>
      <Text style={headerStyle}>Outlook / Microsoft 365</Text>
      <View style={styles.wrap}>
        {status.connected ? (
          <View style={styles.card}>
            <Text style={styles.label}>{status.email}</Text>
            <View style={styles.actions}>
              <Pressable onPress={connect} hitSlop={8} disabled={busy}>
                <Text style={styles.action}>Reconnect</Text>
              </Pressable>
              <Pressable onPress={disconnect} hitSlop={8}>
                <Text style={[styles.action, { color: colors.stop }]}>Disconnect</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <Text style={styles.meta}>
              Connect to let the assistant read and send your Outlook mail and manage your Outlook calendar. It asks
              before sending anything or inviting anyone.
            </Text>
            <Pressable style={[styles.button, styles.primary]} onPress={connect} disabled={busy}>
              <Text style={[styles.buttonText, { color: colors.paper }]}>{busy ? "Opening Microsoft..." : "Connect Outlook"}</Text>
            </Pressable>
          </>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  card: { backgroundColor: colors.wash2, borderRadius: 12, padding: 14, gap: 6 },
  label: { color: colors.ink, fontSize: 15 },
  meta: { color: colors.inkMute, fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: "row", gap: 18, flexWrap: "wrap", marginTop: 4 },
  action: { color: colors.now, fontSize: 14, fontWeight: "600" },
  button: { backgroundColor: colors.wash2, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  primary: { backgroundColor: colors.now },
  buttonText: { color: colors.now, fontSize: 15, fontWeight: "600" },
});
