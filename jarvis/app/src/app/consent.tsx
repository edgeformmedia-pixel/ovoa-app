import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Btn, IconTile, type IconName, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/auth";
import { CONSENT_VERSION } from "../lib/consent";
import { devlog } from "../lib/devlog";
import { firstOpen } from "../lib/firstOpen";
import { SPEECH_PROMISE } from "../lib/onDeviceTranscribe";
import { colors, space, type } from "../lib/theme";

// Agreeing to AI (the v1 release, decisions 1 and 4).
//
// Before anything goes to an AI company, the person agrees here, having read
// in plain words where their data goes. Shown once, before any AI call: to
// someone new when they first have Base (before setup), and to everyone on
// Base at their first open of this version (app/_layout.tsx). "Not now" goes on
// to the app with AI locked ("Agree to use AI", components/Plan.tsx), and setup
// waits until they agree; the locked places and Settings → AI and your data
// open this screen again, and there it also shows how to take it back.
//
// The server records the answer (api/src/consent.ts) and refuses every model
// call, every turn and OVOA's voice without it. CONSENT_VERSION is this
// wording: change the words, bump it (and the server's AI_CONSENT_VERSION),
// and everyone is asked again.

type Part = { icon: IconName; tone: Tone; title: string; body: string };

const PARTS: Part[] = [
  {
    icon: "chatbubbles-outline",
    tone: "violet",
    title: "Replies",
    body: "What you say, and the data needed to answer it (health numbers, your calendar, emails you ask about), goes to Z.ai (GLM) to write replies, and to Google Gemini when GLM is down or for web searches.",
  },
  {
    icon: "volume-high-outline",
    tone: "teal",
    title: "OVOA's voice",
    body: "Replies are turned into speech by Deepgram, which gets the text only.",
  },
  {
    icon: "mic-outline",
    tone: "green",
    title: "Your voice",
    body: SPEECH_PROMISE,
  },
];

export default function Consent() {
  const router = useRouter();
  const { token, user, refreshUser } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agreed = !!user.aiConsent?.given;
  const agreedOn = user.aiConsent?.at ? new Date(user.aiConsent.at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : null;

  /**
   * Opened from a locked screen or Settings: back there. Shown as a step: the
   * next step comes up by itself once GET /me says so (app/_layout.tsx).
   */
  const leave = () => {
    if (router.canGoBack()) router.back();
  };

  const agree = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.agreeToAi(token, CONSENT_VERSION);
      devlog("log", `consent: agreed to version ${CONSENT_VERSION}`);
      // Closed before /me is read again: agreeing can bring setup up next, and
      // this screen left open underneath it came back when setup was done.
      leave();
      await refreshUser();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const notNow = () => {
    devlog("log", "consent: not now");
    firstOpen.consentLater(user.id);
    leave();
  };

  const withdraw = () =>
    Alert.alert("Stop using AI?", "Talking to OVOA, setup, making apps and everything else that uses AI stops until you agree again. Your notes, health and the apps that don't use AI keep working.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop using AI",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await api.withdrawAi(token);
            devlog("log", "consent: taken back");
            firstOpen.consentLater(user.id);
            await refreshUser();
            leave();
          } catch (err) {
            setError(err instanceof Error ? err.message : "That didn't go through. Try again.");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.title}>{agreed ? "AI and your data" : "Before OVOA uses AI"}</Text>
        <Text style={styles.lead}>
          {agreed
            ? `You agreed${agreedOn ? ` on ${agreedOn}` : ""}. This is where what you say goes.`
            : "OVOA uses AI companies to answer you. Nothing goes to them until you agree. Here's what goes where."}
        </Text>
        {PARTS.map((p) => (
          <View key={p.title} style={styles.row}>
            <IconTile name={p.icon} tone={p.tone} size={38} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rowTitle}>{p.title}</Text>
              <Text style={styles.rowBody}>{p.body}</Text>
            </View>
          </View>
        ))}
        <View style={styles.note}>
          <Ionicons name="shield-checkmark-outline" size={16} color={colors.inkMute} />
          <Text style={styles.noteText}>You can take this back any time in Settings, under AI and your data.</Text>
        </View>
        {error && <Text style={styles.error}>{error}</Text>}
        {agreed ? (
          <>
            <Btn
              label="Done"
              kind="go"
              // Only ever shown in the app itself, so Talk is there to go to when there's nothing to go back to.
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/chat" as Href))}
              disabled={busy}
              style={{ marginTop: space.s4 }}
            />
            <Btn label="Stop using AI" kind="danger" onPress={withdraw} busy={busy} />
          </>
        ) : (
          <>
            <Btn label="Agree" kind="go" onPress={() => void agree()} busy={busy} style={{ marginTop: space.s4 }} />
            <Btn label="Not now" kind="quiet" onPress={notNow} disabled={busy} />
          </>
        )}
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
  rowBody: { ...type.meta, color: colors.inkDim },
  note: { flexDirection: "row", alignItems: "center", gap: space.s2 },
  noteText: { ...type.meta, color: colors.inkMute, flex: 1 },
  error: { color: colors.stop, textAlign: "center" },
});
