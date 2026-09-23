import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Btn, GroupLabel, Row, Screen, Tile, Tiles, TopBar, text } from "../../components/ui";
import { api, type SafetyEvent } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { logFail } from "../../lib/devlog";
import { EMERGENCY_NUMBER, useSafety } from "../../lib/safety";
import { colors, radius, space, type } from "../../lib/theme";

export default function Safety() {
  const { token } = useSession();
  const { contacts, setContacts, sos } = useSafety();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [events, setEvents] = useState<SafetyEvent[]>([]);

  useFocusEffect(
    useCallback(() => {
      api
        .safetyEvents(token)
        .then((r) => setEvents(r.events))
        .catch(logFail("safety: setEvents"));
    }, [token]),
  );

  const lastAlert = events[0];

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
          await api.deleteContact(token, id).catch(logFail("safety: api.deleteContact"));
          setContacts((contacts ?? []).filter((c) => c.id !== id));
        },
      },
    ]);

  return (
    <View style={styles.page}>
      {/* SOS can only reach someone once there's a contact to text. */}
      <TopBar title="Safety" when={contacts === null ? undefined : contacts.length ? "Ready" : "No contacts"} />
      <Screen keyboardShouldPersistTaps="handled">
        <Tiles>
          <Tile
            icon="shield-checkmark-outline"
            tone="green"
            label="Last alert"
            value={lastAlert ? stamp(lastAlert.created_at) : "—"}
            small
          />
          <Tile icon="people-outline" tone="coral" label="Contacts" value={`${contacts?.length ?? 0}`} />
        </Tiles>

        <GroupLabel>Emergency contacts</GroupLabel>
        <Text style={text.sub}>
          They get a text with your location when you press SOS. Your phone opens the message; tap Send.
        </Text>
        {contacts?.map((c, i) => (
          <Row
            key={c.id}
            icon="person-outline"
            tone="pink"
            title={c.name}
            value={c.phone}
            first={i === 0}
            right={
              <Pressable onPress={() => removeContact(c.id)} hitSlop={10}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            }
          />
        ))}
        <TextInput
          style={styles.input}
          placeholder="Name"
          placeholderTextColor={colors.inkMute}
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={styles.input}
          placeholder="Phone number"
          placeholderTextColor={colors.inkMute}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
        />
        <Btn
          label={adding ? "Adding…" : "Add contact"}
          onPress={addContact}
          disabled={!name.trim() || !phone.trim() || adding}
          style={{ alignSelf: "flex-start" }}
        />

        {events.length > 0 && (
          <>
            <GroupLabel>Recent alerts</GroupLabel>
            {/* Rows from before Safety was SOS-only can still be kind "fall"; the
                server's 14-day purge (retention.ts) clears the last of them. */}
            {events.slice(0, 5).map((e, i) => (
              <Row
                key={e.id}
                title={e.kind === "sos" ? "SOS" : "Possible fall"}
                value={`${e.status === "alerted" ? "Contacts alerted" : "Marked OK"} · ${stamp(e.created_at)}`}
                first={i === 0}
              />
            ))}
          </>
        )}

        {/* Pinned to the end of the screen, and the one thing on it that is
            allowed to shout. Press and hold, so a pocket cannot fire it. */}
        <Pressable
          onLongPress={sos}
          delayLongPress={1500}
          style={({ pressed }) => [styles.sos, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          accessibilityLabel="Press and hold to alert your contacts"
        >
          <Text style={styles.sosText}>Call for help</Text>
          <Text style={styles.sosHint}>Press and hold to alert your contacts</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL(`tel:${EMERGENCY_NUMBER}`)} hitSlop={8} style={styles.dial}>
          <Text style={styles.dialText}>Call {EMERGENCY_NUMBER}</Text>
        </Pressable>
      </Screen>
    </View>
  );
}

const stamp = (at: number) =>
  new Date(at).toLocaleDateString("en-CA") === new Date().toLocaleDateString("en-CA")
    ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  remove: { ...type.meta, fontWeight: "600", color: colors.stop },
  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },

  sos: {
    marginTop: space.s8,
    borderRadius: radius.pill,
    paddingVertical: space.s4,
    alignItems: "center",
    gap: 2,
    backgroundColor: colors.stopWash,
  },
  sosText: { ...type.body, fontWeight: "600", color: colors.stop },
  sosHint: { ...type.meta, color: colors.stop, opacity: 0.8 },
  dial: { alignSelf: "center", paddingVertical: space.s3 },
  dialText: { ...type.sub, fontWeight: "600", color: colors.inkDim },
});
