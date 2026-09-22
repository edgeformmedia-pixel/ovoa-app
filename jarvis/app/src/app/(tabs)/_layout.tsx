import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import { useEffect, type ComponentProps } from "react";
import { Image, View } from "react-native";
import { useAutoCapture } from "../../lib/capture";
import { startClip } from "../../lib/clip";
import { useAuth } from "../../lib/auth";
import { registerBackgroundPush } from "../../lib/background";
import { startDeviceReports } from "../../lib/device";
import { startRoutineSync } from "../../lib/routines";
import { startHeartRate } from "../../lib/heart";
import { startLocationTimeline } from "../../lib/location";
import { prepareFillers, watchVoiceForFillers } from "../../lib/fillers";
import { startAlarmSync } from "../../lib/nag";
import { NotesBadge } from "../../components/NotesBadge";
import { colors } from "../../lib/theme";

type IconProps = ComponentProps<typeof Ionicons>;

const icon =
  (name: IconProps["name"]) =>
  ({ color, size }: { color: IconProps["color"]; size: number }) => <Ionicons name={name} color={color} size={size} />;

export default function TabsLayout() {
  const { user, token } = useAuth();

  // Reconnect to the ES100 as soon as the app is open, not only once Record is visited.
  useEffect(() => startClip(), []);
  // What this phone has (band, Health, location), so the server picks how to reach it.
  useEffect(() => (token ? startDeviceReports(token) : undefined), [token]);
  useEffect(() => void registerBackgroundPush(), []);
  // Routines and medications: mirror Reminders, schedule the next two days on the phone.
  useEffect(() => (token ? startRoutineSync(token) : undefined), [token]);
  // Heart rate from the band every few minutes, and from Health; places, when the timeline is on.
  useEffect(() => (token ? startHeartRate(token) : undefined), [token]);
  useEffect(() => (token ? startLocationTimeline(token) : undefined), [token]);
  // Tonight's alarms: kept awake for, and set to go off here even with no network.
  useEffect(() => (token ? startAlarmSync(token) : undefined), [token]);
  // "One second while I get that": voiced once, kept on the phone, played instantly.
  useEffect(() => {
    if (!token) return;
    void prepareFillers(token);
    return watchVoiceForFillers(token);
  }, [token]);
  // Anything recorded but not yet in the timeline gets filed, while it's on.
  useAutoCapture();

  // SafetyProvider, AgentProvider, AssistantProvider and NagOverlay used to wrap
  // these tabs. They live in app/_layout.tsx now: /agent, /transcripts, /live,
  // /claude, /dev-tools, /es100 and /motion-lab are siblings of (tabs) in the
  // root stack rather than children, so from here they sat outside the providers
  // and /agent threw on every open (device_logs, 2026-09-21).
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { fontWeight: "600", letterSpacing: 0.5 },
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textDim,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Activity", tabBarIcon: icon("walk") }} />
      <Tabs.Screen
        name="chat"
        options={{
          title: user?.settings.assistantName ?? "OVOA",
          tabBarIcon: icon("mic"),
          headerTitle: () => (
            <Image
              source={require("../../../assets/logo-wordmark.png")}
              style={{ width: 110, height: 30 }}
              resizeMode="contain"
              accessibilityLabel="OVOA"
            />
          ),
        }}
      />
      <Tabs.Screen name="record" options={{ title: "Record", tabBarIcon: icon("radio-button-on") }} />
      <Tabs.Screen
        name="journal"
        options={{
          title: "Journal",
          // The badge counts what OVOA said while the app was closed.
          tabBarIcon: ({ color, size }) => (
            <View>
              <Ionicons name="book-outline" color={color} size={size} />
              <NotesBadge />
            </View>
          ),
        }}
      />
      <Tabs.Screen name="safety" options={{ title: "Safety", tabBarIcon: icon("shield-checkmark") }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: icon("settings") }} />
    </Tabs>
  );
}
