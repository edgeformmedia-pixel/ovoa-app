import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

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
      <StatusBar style="light" />
      <RootStack />
    </AuthProvider>
  );
}
