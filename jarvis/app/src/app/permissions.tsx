import Ionicons from "@expo/vector-icons/Ionicons";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Btn, IconTile, type IconName, type Tone } from "../components/ui";
import { useSession } from "../lib/auth";
import { devlog, logFail } from "../lib/devlog";
import { firstOpen } from "../lib/firstOpen";
import { healthPermission } from "../lib/health";
import { ensureSpeechPermission, SPEECH_PROMISE } from "../lib/onDeviceTranscribe";
import { registerForPush } from "../lib/push";
import { colors, space, type } from "../lib/theme";

// The phone's permissions, once, after sign-up and the emailed code (the v1
// release, first open). One screen that says what each is for, then iOS asks
// for each in turn, in the foreground where it can: Health, the microphone,
// speech recognition and notifications. Bluetooth isn't here: iOS asks for it
// only when a Band is paired (lib/clip.ts).
//
// Nothing here is required: "Not now" goes on, and each is asked again where
// it's first needed (the health cards, Talk, a recording, the agent), as before.
// After this, a free account gets the tour; Base agrees to AI and has setup
// first (app/_layout.tsx).

type Ask = { icon: IconName; tone: Tone; title: string; why: string; run: (token: string) => Promise<unknown> };

const ASKS: Ask[] = [
  {
    icon: "heart-outline",
    tone: "coral",
    title: "Health",
    why: "Your steps, heart rate and sleep, for your day and your trends. Only the numbers you allow.",
    run: () => healthPermission(),
  },
  {
    icon: "mic-outline",
    tone: "teal",
    title: "Microphone",
    why: "To hear you when you tap to talk, record a note, or say its name.",
    run: () => requestRecordingPermissionsAsync(),
  },
  {
    icon: "chatbubble-ellipses-outline",
    tone: "violet",
    title: "Speech recognition",
    why: SPEECH_PROMISE,
    run: () => ensureSpeechPermission({ explained: true }),
  },
  {
    icon: "notifications-outline",
    tone: "amber",
    title: "Notifications",
    why: "Reminders, alarms and medications, even when OVOA is closed.",
    run: (token) => registerForPush(token),
  },
];

export default function Permissions() {
  const { token, finishOnboarding } = useSession();
  const [busy, setBusy] = useState(false);

  const done = () => {
    firstOpen.permissionsDone();
    finishOnboarding();
  };

  const askAll = async () => {
    setBusy(true);
    // One after another: iOS shows one prompt at a time.
    for (const a of ASKS) {
      await a.run(token).catch(logFail(`permissions: ${a.title}`));
    }
    devlog("log", "permissions: asked for all four");
    setBusy(false);
    done();
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.title}>A few permissions</Text>
        <Text style={styles.lead}>Your iPhone asks for each of these next. You can change any of them later in the Settings app.</Text>
        {ASKS.map((a) => (
          <View key={a.title} style={styles.row}>
            <IconTile name={a.icon} tone={a.tone} size={38} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rowTitle}>{a.title}</Text>
              <Text style={styles.rowWhy}>{a.why}</Text>
            </View>
          </View>
        ))}
        <View style={styles.note}>
          <Ionicons name="bluetooth-outline" size={16} color={colors.inkMute} />
          <Text style={styles.noteText}>Bluetooth is asked for when you pair an OVOA Band.</Text>
        </View>
        <Btn label="Continue" kind="go" onPress={() => void askAll()} busy={busy} style={{ marginTop: space.s4 }} />
        <Btn label="Not now" kind="quiet" onPress={done} disabled={busy} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  page: { paddingHorizontal: space.s6, paddingTop: space.s10, paddingBottom: space.s8, gap: space.s4 },
  title: { ...type.title, color: colors.ink },
  lead: { ...type.sub, color: colors.inkDim },
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.s3 },
  rowTitle: { ...type.body, color: colors.ink, fontWeight: "600" },
  rowWhy: { ...type.meta, color: colors.inkDim },
  note: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  noteText: { ...type.meta, color: colors.inkMute, flex: 1 },
});
