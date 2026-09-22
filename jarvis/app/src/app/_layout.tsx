import { Stack, usePathname, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { NagOverlay } from "../components/NagOverlay";
import { AgentProvider } from "../lib/agent";
import { AssistantProvider } from "../lib/assistant";
import { AuthProvider, useAuth } from "../lib/auth";
// For its side effect: the background push task has to be defined before anything mounts.
import "../lib/background";
// Likewise the Done / Snooze handler: a tap on a locked phone can start the app just for it.
import "../lib/routines";
// And the location and geofence tasks, which iOS runs with the app closed.
import "../lib/location";
// And alarms and urgent reminders, which must go off with the app in the background.
import "../lib/nag";
import { devlog, setLogContext } from "../lib/devlog";
import { sendBugReport, startRemoteLog } from "../lib/remoteLog";
import { SafetyProvider } from "../lib/safety";
import { colors } from "../lib/theme";

// Release builds close the app on an uncaught JS error; show it instead so it
// can be reported. React Native's own handler still runs afterwards: it is what
// hands the crash to iOS (ExceptionsManager → NativeExceptionsManager), and
// replacing it rather than wrapping it is why none of these ever showed up
// anywhere but the phone's screen.
const errorUtils = (
  globalThis as {
    ErrorUtils?: {
      getGlobalHandler(): (e: Error, fatal?: boolean) => void;
      setGlobalHandler(h: (e: Error, fatal?: boolean) => void): void;
    };
  }
).ErrorUtils;
if (errorUtils && !__DEV__) {
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, fatal) => {
    Alert.alert(fatal ? "OVOA crashed" : "OVOA error", `${error?.message}\n\n${error?.stack?.slice(0, 600) ?? ""}`, [
      { text: "Close", style: "cancel" },
      { text: "Report it", onPress: () => void sendBugReport(`Crash: ${error?.message ?? "unknown"}`) },
    ]);
    previous(error, fatal);
  });
}

// After the handler above, which it wraps, so errors also reach the server log.
startRemoteLog();

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  // React only console.errors what a boundary catches, which reached the server
  // log as a bare message with no stack and no screen (the /agent provider crash,
  // device_logs 2026-09-21). Log it here, where both are in hand.
  useEffect(() => devlog("err", `screen crashed: ${error.message}`, error.stack), [error]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
      <Text style={{ color: colors.text, fontSize: 20, fontWeight: "600", marginBottom: 12 }}>Something broke</Text>
      <Text selectable style={{ color: colors.text, marginBottom: 12 }}>
        {error.message}
      </Text>
      <Text selectable style={{ color: colors.textDim, fontSize: 12 }}>
        {error.stack}
      </Text>
      <Pressable onPress={retry} style={{ marginTop: 24, padding: 14, borderRadius: 10, backgroundColor: colors.accent }}>
        <Text style={{ color: colors.bg, textAlign: "center", fontWeight: "600" }}>Try again</Text>
      </Pressable>
    </ScrollView>
  );
}

function RootStack() {
  const { loading, user, onboarding } = useAuth();
  // The one predicate the signed-in screens are guarded by, named once so the
  // providers below and the guard inside the Stack can't drift apart again.
  const signedIn = !!user && !onboarding && user.onboarded !== false;

  // Which of the four states the app is in. A crash report that doesn't say
  // whether anyone was signed in costs a round trip to the phone to find out.
  useEffect(() => {
    devlog("log", `session: ${loading ? "loading" : signedIn ? "signed in" : user ? "onboarding" : "signed out"}`);
  }, [loading, signedIn, user]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      {/* Older servers don't send `onboarded`; only an explicit false shows setup. */}
      <Stack.Protected guard={!!user && !onboarding && user.onboarded === false}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="dev-tools" options={{ headerShown: true, title: "Dev tools" }} />
        <Stack.Screen name="es100" options={{ headerShown: true, title: "ES100" }} />
        <Stack.Screen name="motion-lab" options={{ headerShown: true, title: "Motion lab" }} />
        <Stack.Screen name="agent" options={{ headerShown: true, title: "Background work" }} />
        <Stack.Screen name="transcripts" options={{ headerShown: true, title: "Transcripts" }} />
        <Stack.Screen name="live" options={{ headerShown: true, title: "Live" }} />
        <Stack.Screen name="claude" options={{ headerShown: true, title: "Ask Claude" }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user && onboarding}>
        <Stack.Screen name="connect-google" />
      </Stack.Protected>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      {/* Outside every guard: a crash before sign-in is the one most worth hearing about. */}
      <Stack.Screen name="report-bug" options={{ headerShown: true, title: "Report a problem" }} />
    </Stack>
  );

  // Every screen behind the sign-in guard needs these, not only the tabs. They
  // used to be mounted in (tabs)/_layout, but agent, transcripts, live, claude,
  // dev-tools, es100 and motion-lab are siblings of (tabs) in this stack rather
  // than children of it, so /agent rendered outside AgentProvider and threw
  // "useAgent must be used inside AgentProvider" every time it was opened
  // (device_logs, 2026-09-21). Wrapping the whole Stack here is the only
  // placement that covers every route. The guard keeps the old mount timing
  // exactly: these still come up only once there is a session, so nothing asks
  // for the microphone, the band or notifications any earlier than it did before.
  if (!signedIn) return stack;

  return (
    <SafetyProvider>
      <AgentProvider>
        <AssistantProvider>
          {stack}
          {/* The alarm overlay was stuck inside the tabs too: one going off
              while Transcripts or Background work was open had nowhere to show. */}
          <NagOverlay />
        </AssistantProvider>
      </AgentProvider>
    </SafetyProvider>
  );
}

/**
 * Every screen change in the log, and on every row written from then on. Nothing
 * recorded the route before, so the /agent crashes couldn't be placed on a screen
 * without reading the JS stack. Its own component, so a navigation re-renders
 * this and not the whole Stack.
 */
function RouteWatch() {
  const pathname = usePathname();
  useEffect(() => {
    // Three lines that must never be the reason the app fails to mount.
    try {
      setLogContext({ route: pathname });
      devlog("nav", `screen: ${pathname}`);
    } catch {}
  }, [pathname]);
  return null;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootStack />
      <RouteWatch />
    </AuthProvider>
  );
}
