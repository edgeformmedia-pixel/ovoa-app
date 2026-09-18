import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { api, type SafetyEvent } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { EMERGENCY_NUMBER, useSafety, type DetectorStatus } from "../../lib/safety";
import { colors } from "../../lib/theme";

const DETECTOR_TEXT: Record<DetectorStatus, string> = {
  off: "Off",
  starting: "Starting…",
  on: "Watching for falls while the app is open.",
  unavailable: "This device has no motion sensor.",
  denied: "Allow Motion & Fitness access in the Settings app.",
};

export default function Safety() {
  const { token, user, setUser } = useSession();
  const { contacts, setContacts, trigger, detectorStatus } = useSafety();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [events, setEvents] = useState<SafetyEvent[]>([]);

  useFocusEffect(
    useCallback(() => {
      api.safetyEvents(token).then((r) => setEvents(r.events)).catch(() => {});
    }, [token]),
  );

  const fallOn = !!user?.settings.fallDetection;

  const toggleFall = async (fallDetection: boolean) => {
    try {
      setUser((await api.updateMe(token, { fallDetection })).user);
    } catch (err) {
      Alert.alert("Couldn't update", (err as Error).message);
    }
  };

  const addContact = async () => {
    setAdding(true);
    try {
      const { contact } = await api.addContact(token, name.trim(), phone.trim());
      setContacts([...(contacts ?? []), contact]);
      setName("");
      setPhone("");
    } catch (err) {
      Alert.alert("Couldn't add contact", (err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const removeContact = (id: string) =>
    Alert.alert("Remove contact?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          await api.deleteContact(token, id).catch(() => {});
          setContacts((contacts ?? []).filter((c) => c.id !== id));
        },
      },
    ]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable
        onLongPress={() => trigger("sos")}
        delayLongPress={1500}
        style={({ pressed }) => [styles.sos, pressed && styles.sosPressed]}
      >
        <Text style={styles.sosText}>SOS</Text>
        <Text style={styles.sosHint}>Press and hold to alert your contacts</Text>
      </Pressable>

      <Pressable style={styles.call} onPress={() => Linking.openURL(`tel:${EMERGENCY_NUMBER}`)}>
        <Text style={styles.callText}>Call {EMERGENCY_NUMBER}</Text>
      </Pressable>

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.label}>Fall detection</Text>
            <Text style={styles.dim}>{DETECTOR_TEXT[detectorStatus]}</Text>
          </View>
          <Switch
            value={fallOn}
            onValueChange={toggleFall}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>
        <Text style={styles.warn}>
          Fall detection only works while OVOA is open on screen. It is not a medical device. Don't rely on it
          alone.
        </Text>
        <Pressable style={styles.secondary} onPress={() => trigger("fall")}>
          <Text style={styles.secondaryText}>Test the fall alert</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Emergency contacts</Text>
        <Text style={styles.dim}>
          They get a text with your location when you press SOS or don't respond after a fall. Your phone opens
          the message; tap Send.
        </Text>

        {contacts?.map((c) => (
          <View key={c.id} style={styles.contact}>
            <View style={{ flex: 1 }}>
              <Text style={styles.contactName}>{c.name}</Text>
              <Text style={styles.dim}>{c.phone}</Text>
            </View>
            <Pressable onPress={() => removeContact(c.id)} hitSlop={10}>
              <Text style={styles.remove}>Remove</Text>
            </Pressable>
          </View>
        ))}

        <TextInput
          style={styles.input}
          placeholder="Name"
          placeholderTextColor={colors.textDim}
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={styles.input}
          placeholder="Phone number"
          placeholderTextColor={colors.textDim}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
        />
        <Pressable
          style={[styles.secondary, (!name.trim() || !phone.trim() || adding) && { opacity: 0.4 }]}
          disabled={!name.trim() || !phone.trim() || adding}
          onPress={addContact}
        >
          <Text style={styles.secondaryText}>{adding ? "Adding…" : "Add contact"}</Text>
        </Pressable>
      </View>

      {events.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>Recent alerts</Text>
          {events.slice(0, 5).map((e) => (
            <View key={e.id} style={styles.contact}>
              <Text style={styles.contactName}>{e.kind === "sos" ? "SOS" : "Possible fall"}</Text>
              <Text style={[styles.dim, { flex: 1, textAlign: "right" }]}>
                {e.status === "alerted" ? "Contacts alerted" : "Marked OK"} ·{" "}
                {new Date(e.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  sos: {
    alignSelf: "center",
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 12,
    shadowColor: colors.danger,
    shadowOpacity: 0.6,
    shadowRadius: 24,
  },
  sosPressed: { transform: [{ scale: 0.95 }], opacity: 0.85 },
  sosText: { color: "#fff", fontSize: 44, fontWeight: "900", letterSpacing: 2 },
  sosHint: { color: "#fff", fontSize: 11, textAlign: "center", paddingHorizontal: 20, marginTop: 2 },
  call: {
    borderColor: colors.danger,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  callText: { color: colors.danger, fontSize: 16, fontWeight: "700" },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  label: { color: colors.text, fontSize: 16, fontWeight: "600" },
  dim: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  warn: { color: "#f5c26b", fontSize: 12, lineHeight: 17 },
  contact: { flexDirection: "row", alignItems: "center", gap: 12 },
  contactName: { color: colors.text, fontSize: 15 },
  remove: { color: colors.danger, fontSize: 13 },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondary: { backgroundColor: colors.surfaceHigh, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  secondaryText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
});
