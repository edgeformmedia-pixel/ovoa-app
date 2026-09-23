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
import { usePlan } from "../../lib/plan";
import { colors } from "../../lib/theme";

export default function TabsLayout() {
  const { token, user } = useAuth();
  // Routines, alarms, places and the spoken fillers belong to the assistant
  // (Base, api/src/plans.ts). On the free plan they aren't started at all,
  // rather than asked for every few minutes and told no.
  const { free } = usePlan();
  const assistant = token && !free ? token : null;

  // Reconnect to the ES100 as soon as the app is open, not only once Record is visited.
  useEffect(() => startClip(), []);
  // What this phone has (band, Health, location), so the server picks how to reach it.
  useEffect(() => (token ? startDeviceReports(token) : undefined), [token]);
  useEffect(() => void registerBackgroundPush(), []);
  // Routines and medications: mirror Reminders, schedule the next two days on the phone.
  useEffect(() => (assistant ? startRoutineSync(assistant) : undefined), [assistant]);
  // Heart rate from the band every few minutes, and from Health; places, when the timeline is on.
  useEffect(() => (token ? startHeartRate(token) : undefined), [token]);
  useEffect(() => (assistant ? startLocationTimeline(assistant) : undefined), [assistant]);
  // Tonight's alarms: kept awake for, and set to go off here even with no network.
  useEffect(() => (assistant ? startAlarmSync(assistant, user?.name ?? "") : undefined), [assistant, user?.name]);
  // "One second while I get that": voiced once, kept on the phone, played instantly.
  useEffect(() => {
    if (!assistant) return;
    void prepareFillers(assistant);
    return watchVoiceForFillers(assistant);
  }, [assistant]);
  // Anything recorded but not yet in the timeline gets filed, while it's on.
  useAutoCapture();

  // Still a tab navigator, and deliberately so: every screen here keeps its own
  // state when you leave it, and the drawer can never stack two copies of one.
  // It just doesn't draw a bar any more — navigation is the drawer, and each
  // screen carries its own TopBar with the hamburger in it. The drawer lists
  // only Talk, Apps, Account and Settings; the rest are opened from Apps.
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
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="chat" options={{ title: "Talk" }} />
      <Tabs.Screen name="apps" options={{ title: "Apps" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
      <Tabs.Screen name="activity" options={{ title: "Activity" }} />
      <Tabs.Screen name="brief" options={{ title: "Brief" }} />
      <Tabs.Screen name="day" options={{ title: "Day" }} />
      <Tabs.Screen name="record" options={{ title: "Record" }} />
      <Tabs.Screen name="safety" options={{ title: "Safety" }} />
      <Tabs.Screen name="agent" options={{ title: "Background work" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}
