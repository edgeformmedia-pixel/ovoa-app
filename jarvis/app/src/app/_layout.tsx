import { Stack, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { devlog } from "../lib/devlog";
import { startRemoteLog } from "../lib/remoteLog";
import { colors } from "../lib/theme";

// Release builds close the app on an uncaught JS error; show it instead so it can be reported.
const errorUtils = (globalThis as { ErrorUtils?: { setGlobalHandler(h: (e: Error, fatal?: boolean) => void): void } })
  .ErrorUtils;
if (errorUtils && !__DEV__) {
  errorUtils.setGlobalHandler((error, fatal) => {
    Alert.alert(fatal ? "OVOA crashed" : "OVOA error", `${error?.message}\n\n${error?.stack?.slice(0, 800) ?? ""}`);
  });
}

// After the handler above, which it wraps, so errors also reach the server log.
startRemoteLog(devlog);

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
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

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!!user && !onboarding}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="dev-tools" options={{ headerShown: true, title: "Dev tools" }} />
        <Stack.Screen name="es100" options={{ headerShown: true, title: "ES100" }} />
        <Stack.Screen name="motion-lab" options={{ headerShown: true, title: "Motion lab" }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user && onboarding}>
        <Stack.Screen name="connect-google" />
      </Stack.Protected>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <RootStack />
    </AuthProvider>
  );
}
