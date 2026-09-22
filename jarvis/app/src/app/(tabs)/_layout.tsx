import { Tabs } from "expo-router";
import { useEffect } from "react";
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
import { colors } from "../../lib/theme";

export default function TabsLayout() {
  const { token } = useAuth();

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

  // Still a tab navigator, and deliberately so: every screen here keeps its own
  // state when you leave it, and the drawer can never stack two copies of one.
  // It just doesn't draw a bar any more — navigation is the drawer, and each
  // screen carries its own TopBar with the hamburger in it.
  //
  // SafetyProvider, AgentProvider, AssistantProvider and NagOverlay live in
  // app/_layout.tsx: /agent, /transcripts, /live, /claude, /dev-tools, /es100
  // and /motion-lab are siblings of (tabs) in the root stack rather than
  // children, so from here they sat outside the providers and /agent threw on
  // every open (device_logs, 2026-09-21).
  return (
    <Tabs
      tabBar={() => null}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.paper },
        // Without this the vendored tab bar still reserves its height.
        tabBarStyle: { display: "none" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Activity" }} />
      <Tabs.Screen name="chat" options={{ title: "Talk" }} />
      <Tabs.Screen name="brief" options={{ title: "Brief" }} />
      <Tabs.Screen name="day" options={{ title: "Day" }} />
      <Tabs.Screen name="record" options={{ title: "Record" }} />
      <Tabs.Screen name="safety" options={{ title: "Safety" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}
