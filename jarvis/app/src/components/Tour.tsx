import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../lib/auth";
import { usePlan } from "../lib/plan";
import { tourPref, useTourSeen } from "../lib/tour";
import { colors, lift, radius, space, type } from "../lib/theme";
import { Btn, IconTile, type IconName, type Tone } from "./ui";

// The quick tour: what the four rows of the menu are, and that everything else
// is an app you add. Shown once (lib/tour.ts), over whatever screen is open,
// straight after the setup conversation. A card at a time, skippable at any
// point, and never more than a few sentences each.

type Step = { icon: IconName; tone: Tone; title: string; body: string };

function steps(assistant: string, free: boolean): Step[] {
  return [
    {
      icon: "sparkles-outline",
      tone: "violet",
      title: free ? "Welcome to OVOA" : `${assistant} is ready`,
      body: free
        ? "Here's how to get around. It takes half a minute."
        : "You're set up. Here's how to get around — it takes half a minute.",
    },
    {
      icon: "menu",
      tone: "blue",
      title: "The menu",
      body: "Tap ☰ at the top left of any screen, or swipe in from the left edge. It has four things in it, and that's all.",
    },
    free
      ? {
          icon: "time-outline",
          tone: "teal",
          title: "Today",
          body: "Your notes and your health for the day. With a plan, this is where you'd talk to OVOA.",
        }
      : {
          icon: "mic",
          tone: "teal",
          title: "Talk",
          body: `Where the app opens. Tap the orb and speak, or type. Ask ${assistant} to remind you, plan your day, or text someone.`,
        },
    {
      icon: "apps-outline",
      tone: "violet",
      title: "Apps",
      body: "Everything else — your Morning Brief, Day, Activity, Record, Safety and more — is an app you add onto OVOA. Search for one, tap Install, and it's in Your apps. Each says how much of your daily usage it uses. Press and hold one to remove it.",
    },
    {
      icon: "person-circle-outline",
      tone: "blue",
      title: "Account",
      body: "Your plan, your name and email, your password, and signing out.",
    },
    {
      icon: "settings-outline",
      tone: "amber",
      title: "Settings",
      body: free
        ? "Report a problem, and switches for this phone."
        : `How ${assistant} sounds and listens, what it remembers, and what it may do on its own.`,
    },
  ];
}

export function Tour() {
  const seen = useTourSeen();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { free } = usePlan();
  const [at, setAt] = useState(0);

  if (seen !== false) return null;

  const all = steps(user?.settings.assistantName || "OVOA", free);
  const step = all[at];
  const last = at === all.length - 1;

  const finish = (go?: Href) => {
    tourPref.done();
    setAt(0);
    if (go) router.navigate(go);
  };

  return (
    <View style={styles.scrim}>
      <View style={[styles.card, { marginBottom: insets.bottom + space.s4 }]}>
        <View style={styles.top}>
          <Text style={styles.count}>
            {at + 1} of {all.length}
          </Text>
          <Pressable onPress={() => finish()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Skip the tour">
            <Text style={styles.skip}>Skip</Text>
          </Pressable>
        </View>

        <IconTile name={step.icon} tone={step.tone} size={56} />
        <Text style={styles.title}>{step.title}</Text>
        <Text style={styles.body}>{step.body}</Text>

        <View style={styles.dots}>
          {all.map((_, i) => (
            <View key={i} style={[styles.dot, i === at && styles.dotOn]} />
          ))}
        </View>

        <View style={styles.actions}>
          {at > 0 ? (
            <Pressable onPress={() => setAt(at - 1)} hitSlop={8} style={styles.back} accessibilityLabel="Back">
              <Ionicons name="chevron-back" size={20} color={colors.ink} />
            </Pressable>
          ) : (
            <View />
          )}
          {last ? (
            <Btn
              label={free ? "Got it" : "Start talking"}
              kind="go"
              onPress={() => finish(free ? "/" : "/chat")}
            />
          ) : (
            <Btn label="Next" kind="go" onPress={() => setAt(at + 1)} />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    backgroundColor: "rgba(12,14,18,0.45)",
    justifyContent: "flex-end",
    paddingHorizontal: space.s4,
  },
  card: {
    backgroundColor: colors.paper,
    borderRadius: radius.sheet,
    padding: space.s6,
    gap: space.s3,
    ...lift,
  },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.s2 },
  count: { ...type.meta, color: colors.inkMute },
  skip: { ...type.meta, fontWeight: "600", color: colors.inkMute },
  title: { ...type.title, color: colors.ink, marginTop: space.s2 },
  body: { ...type.sub, color: colors.inkDim },
  dots: { flexDirection: "row", gap: 6, paddingTop: space.s2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.wash2 },
  dotOn: { backgroundColor: colors.ink, width: 18 },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: space.s3 },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.wash,
    alignItems: "center",
    justifyContent: "center",
  },
});
