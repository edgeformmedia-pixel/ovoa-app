import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Btn, GroupLabel, Row, Screen, Tile, Tiles, Toggle, TopBar, text } from "../../components/ui";
import { api, type SafetyEvent } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { logFail } from "../../lib/devlog";
import { EMERGENCY_NUMBER, useSafety, type DetectorStatus } from "../../lib/safety";
import { colors, radius, space, type } from "../../lib/theme";

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
      api
        .safetyEvents(token)
        .then((r) => setEvents(r.events))
        .catch(logFail("safety: setEvents"));
    }, [token]),
  );

  const fallOn = !!user?.settings.fallDetection;
  const lastCheck = events[0];

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
          await api.deleteContact(token, id).catch(logFail("safety: api.deleteContact"));
          setContacts((contacts ?? []).filter((c) => c.id !== id));
        },
      },
    ]);

  return (
    <View style={styles.page}>
      <TopBar title="Safety" when={fallOn ? "Armed" : "Off"} />
      <Screen keyboardShouldPersistTaps="handled">
        <Tiles>
          <Tile
            icon="shield-checkmark-outline"
            tone="green"
            label="Last check"
            value={lastCheck ? stamp(lastCheck.created_at) : "—"}
            small
          />
          <Tile
            icon="alert-circle-outline"
            tone="coral"
            label="Falls"
            value={`${events.filter((e) => e.kind === "fall").length}`}
          />
        </Tiles>

        <GroupLabel>Watching</GroupLabel>
        <Row
          icon="trending-down-outline"
          tone="amber"
          title="Fall detection"
          first
          right={<Toggle value={fallOn} onValueChange={toggleFall} label="Fall detection" />}
        />
        <Text style={text.meta}>{DETECTOR_TEXT[detectorStatus]}</Text>
        <Text style={styles.warn}>
          Fall detection only works while OVOA is open on screen. It is not a medical device. Don&apos;t rely on it
          alone.
        </Text>
        <Btn label="Test the fall alert" onPress={() => trigger("fall")} style={{ alignSelf: "flex-start" }} />

        <GroupLabel>Emergency contacts</GroupLabel>
        <Text style={text.sub}>
          They get a text with your location when you press SOS or don&apos;t respond after a fall. Your phone opens the
          message; tap Send.
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
          onLongPress={() => trigger("sos")}
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
  warn: { ...type.meta, color: colors.late },
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
