import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import { Image } from "react-native";
import { AssistantProvider } from "../../lib/assistant";
import { useAuth } from "../../lib/auth";
import { SafetyProvider } from "../../lib/safety";
import { colors } from "../../lib/theme";

type IconProps = ComponentProps<typeof Ionicons>;

const icon =
  (name: IconProps["name"]) =>
  ({ color, size }: { color: IconProps["color"]; size: number }) => <Ionicons name={name} color={color} size={size} />;

export default function TabsLayout() {
  const { user } = useAuth();

  return (
    <SafetyProvider>
      <AssistantProvider>
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
          <Tabs.Screen name="safety" options={{ title: "Safety", tabBarIcon: icon("shield-checkmark") }} />
          <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: icon("settings") }} />
        </Tabs>
      </AssistantProvider>
    </SafetyProvider>
  );
}
