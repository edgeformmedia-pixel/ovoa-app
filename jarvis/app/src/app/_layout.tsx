import { Stack, usePathname, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppDrawer } from "../components/Drawer";
import { Earcons } from "../components/Earcons";
import { ExpandOverlay } from "../components/Expand";
import { NagOverlay } from "../components/NagOverlay";
import { Tour } from "../components/Tour";
import { AgentProvider } from "../lib/agent";
import { AssistantProvider } from "../lib/assistant";
import { AuthProvider, useAuth } from "../lib/auth";
import { PlanProvider, usePlan } from "../lib/plan";
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
import { colors, space, type } from "../lib/theme";

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
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.paper }}
      contentContainerStyle={{ padding: space.s6, paddingTop: 80, gap: space.s3 }}
    >
      <Text style={{ ...type.title, color: colors.ink }}>Something broke</Text>
      <Text selectable style={{ ...type.body, color: colors.ink }}>
        {error.message}
      </Text>
      <Text selectable style={{ ...type.meta, color: colors.inkMute }}>
        {error.stack}
      </Text>
      <Pressable
        onPress={retry}
        style={{ marginTop: space.s5, padding: 14, borderRadius: 22, backgroundColor: colors.now }}
      >
        <Text style={{ ...type.body, color: colors.paper, textAlign: "center", fontWeight: "600" }}>Try again</Text>
      </Pressable>
    </ScrollView>
  );
}

function RootStack() {
  const { loading, user, onboarding } = useAuth();
  // Setup (connect Google, then the setup conversation) is the assistant
  // getting to know you, and the free plan has no assistant: a free person goes
  // straight to their day. If they join later, setup is waiting for them.
  const { free, ready } = usePlan();
  const googleStep = onboarding && !free;
  const setupStep = user?.onboarded === false && !free;
  // The one predicate the signed-in screens are guarded by, named once so the
  // providers below and the guard inside the Stack can't drift apart again.
  const signedIn = !!user && !googleStep && !setupStep;

  // Which of the four states the app is in. A crash report that doesn't say
  // whether anyone was signed in costs a round trip to the phone to find out.
  useEffect(() => {
    devlog("log", `session: ${loading ? "loading" : signedIn ? "signed in" : user ? "onboarding" : "signed out"}`);
  }, [loading, signedIn, user]);

  // Right after signing up the plan isn't known yet, and it decides whether
  // setup comes first: wait the moment it takes rather than flash setup at a free account.
  const waitingForPlan = !!user && (onboarding || user.onboarded === false) && !ready;

  if (loading || waitingForPlan) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.paper, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.now} />
      </View>
    );
  }

  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper } }}>
      {/* Older servers don't send `onboarded`; only an explicit false shows setup. */}
      <Stack.Protected guard={!!user && !googleStep && setupStep}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        {/* These carry a header because they are pushed over a screen and the
            back arrow is how you leave them; the drawer screens have a
            hamburger of their own instead. */}
        <Stack.Screen name="dev-tools" options={{ ...pushed, title: "Dev tools" }} />
        <Stack.Screen name="es100" options={{ ...pushed, title: "ES100" }} />
        <Stack.Screen name="motion-lab" options={{ ...pushed, title: "Motion lab" }} />
        <Stack.Screen name="transcripts" options={{ ...pushed, title: "Transcripts" }} />
        <Stack.Screen name="live" options={{ ...pushed, title: "Live" }} />
        <Stack.Screen name="claude" options={{ ...pushed, title: "Ask Claude" }} />
        <Stack.Screen name="create" options={{ ...pushed, title: "Create an app" }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user && googleStep}>
        <Stack.Screen name="connect-google" />
      </Stack.Protected>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      {/* Outside every guard: a crash before sign-in is the one most worth hearing about. */}
      <Stack.Screen name="report-bug" options={{ ...pushed, title: "Report a problem" }} />
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
          {/* The drawer is inside the providers because its rows read from them,
              and outside the Stack because it has to sit over every route. */}
          <AppDrawer>
            {stack}
            {/* Once, the first time the app opens past setup: a spoken walk
                through the menu. Inside the drawer so it can open it and
                point at its rows, and drawn over it. */}
            <Tour />
            {/* Over the drawer and every screen: a card growing into its app. */}
            <ExpandOverlay />
          </AppDrawer>
          {/* After the drawer, so an alarm going off covers the menu too. */}
          <NagOverlay />
          <Earcons />
        </AssistantProvider>
      </AgentProvider>
    </SafetyProvider>
  );
}

/** Shared by the screens that are pushed over another one rather than opened from the menu. */
const pushed = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.paper },
  headerTintColor: colors.ink,
  headerShadowVisible: false,
  headerTitleStyle: { ...type.head, color: colors.ink },
} as const;

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
    // Gesture Handler needs its root at the very top: swiping approval cards uses it.
    <GestureHandlerRootView style={{ flex: 1 }}>
    <SafeAreaProvider>
      <AuthProvider>
        {/* Dark glyphs: the app is white now. */}
        <StatusBar style="dark" />
        <PlanProvider>
          <RootStack />
        </PlanProvider>
        <RouteWatch />
      </AuthProvider>
    </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
