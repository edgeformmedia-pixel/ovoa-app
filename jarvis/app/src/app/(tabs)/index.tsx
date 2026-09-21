import { useFocusEffect } from "expo-router";
import { Pedometer } from "expo-sensors";
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { Feed } from "../../components/Feed";
import { HealthCards } from "../../components/HealthCards";
import { api, type StepDay } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { kcalForSteps, kmForSteps, lastSevenDays, stepPermission } from "../../lib/steps";
import { colors } from "../../lib/theme";

const GOALS = [5000, 8000, 10000, 12000, 15000];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Live metrics and Ask Claude, one tap from the home screen. */
function Shortcuts() {
  const router = useRouter();
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <Pressable style={[styles.card, styles.shortcut]} onPress={() => router.push("/live" as Href)}>
        <Ionicons name="pulse" size={22} color={colors.danger} />
        <Text style={styles.shortcutText}>Live</Text>
      </Pressable>
      <Pressable style={[styles.card, styles.shortcut]} onPress={() => router.push("/claude" as Href)}>
        <Ionicons name="sparkles" size={22} color={colors.accent} />
        <Text style={styles.shortcutText}>Ask Claude</Text>
      </Pressable>
    </View>
  );
}

export default function Activity() {
  const { token, user, setUser } = useSession();
  const [status, setStatus] = useState<"loading" | "ok" | "denied" | "unavailable">("loading");
  const [days, setDays] = useState<StepDay[]>([]);
  const [liveExtra, setLiveExtra] = useState(0);

  const goal = user?.settings.stepGoal ?? 8000;

  // Reload history whenever the tab is opened, and keep the server copy in sync.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const perm = await stepPermission();
        if (cancelled) return;
        setStatus(perm);
        if (perm !== "ok") return;
        const history = await lastSevenDays();
        if (cancelled) return;
        setDays(history);
        setLiveExtra(0);
        if (history.length) api.syncSteps(token, history).catch(() => {});
      })();
      return () => {
        cancelled = true;
      };
    }, [token]),
  );

  // Live updates while the screen is open.
  useEffect(() => {
    if (status !== "ok" || Platform.OS === "web") return;
    const sub = Pedometer.watchStepCount((r) => setLiveExtra(r.steps));
    return () => sub.remove();
  }, [status, days]);

  const today = (days.at(-1)?.steps ?? 0) + liveExtra;
  const progress = Math.min(today / goal, 1);
  const maxBar = Math.max(goal, ...days.map((d) => d.steps), today);
  const streak = countStreak(days, goal);

  const setGoal = async (stepGoal: number) => {
    try {
      setUser((await api.updateMe(token, { stepGoal })).user);
    } catch {}
  };

  // No step counter (or no permission) doesn't mean no Activity tab: heart rate,
  // sleep and workouts come from Apple Health and stand on their own.
  if (status === "denied" || status === "unavailable") {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Shortcuts />
        <Feed />
        <View style={[styles.card, { alignItems: "center", gap: 10 }]}>
          <Text style={styles.title}>Step tracking is off</Text>
          <Text style={styles.dim}>
            {status === "denied"
              ? "Allow Motion & Fitness access in the Settings app to count your steps."
              : "This device doesn't have a step counter."}
          </Text>
          {status === "denied" && (
            <Pressable style={styles.button} onPress={() => Linking.openSettings()}>
              <Text style={styles.buttonText}>Open Settings</Text>
            </Pressable>
          )}
        </View>
        <HealthCards />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Shortcuts />
      <Feed />
      <View style={[styles.card, styles.todayCard]}>
        <Text style={styles.label}>TODAY</Text>
        <Text style={styles.big}>{today.toLocaleString()}</Text>
        <Text style={styles.dim}>of {goal.toLocaleString()} steps</Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }, progress >= 1 && styles.fillDone]} />
        </View>
        <Text style={[styles.dim, progress >= 1 && { color: colors.success }]}>
          {progress >= 1 ? "Goal reached. Nice work!" : `${(goal - today).toLocaleString()} to go`}
        </Text>
      </View>

      <View style={styles.row}>
        <Stat label="Distance" value={`${kmForSteps(today).toFixed(1)} km`} />
        <Stat label="Calories" value={`${Math.round(kcalForSteps(today))}`} />
        <Stat label="Streak" value={`${streak} ${streak === 1 ? "day" : "days"}`} />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>LAST 7 DAYS</Text>
        <View style={styles.chart}>
          {days.map((d, i) => {
            const steps = i === days.length - 1 ? today : d.steps;
            const hit = steps >= goal;
            return (
              <View key={d.day} style={styles.barCol}>
                <Text style={styles.barValue}>{steps >= 1000 ? `${(steps / 1000).toFixed(1)}k` : steps}</Text>
                <View style={styles.barTrack}>
                  <View
                    style={[styles.bar, { height: `${(steps / maxBar) * 100}%` }, hit && styles.fillDone]}
                  />
                </View>
                <Text style={styles.barDay}>
                  {i === days.length - 1 ? "Today" : WEEKDAY[new Date(`${d.day}T12:00:00`).getDay()]}
                </Text>
              </View>
            );
          })}
        </View>
        {status === "loading" && <Text style={styles.dim}>Loading…</Text>}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>DAILY GOAL</Text>
        <View style={styles.chips}>
          {GOALS.map((g) => (
            <Pressable key={g} onPress={() => setGoal(g)} style={[styles.chip, g === goal && styles.chipOn]}>
              <Text style={[styles.chipText, g === goal && { color: colors.bg }]}>{g / 1000}k</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <HealthCards />

      <Text style={styles.footnote}>Distance and calories are estimates based on average stride.</Text>
    </ScrollView>
  );
}

function countStreak(days: StepDay[], goal: number) {
  let streak = 0;
  // Today counts only once reached; otherwise start from yesterday.
  const list = [...days].reverse();
  const start = list[0] && list[0].steps >= goal ? 0 : 1;
  for (let i = start; i < list.length && list[i].steps >= goal; i++) streak++;
  return streak;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={[styles.card, styles.stat]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.dim}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 6,
  },
  todayCard: { alignItems: "center" },
  label: { color: colors.textDim, fontSize: 12, fontWeight: "600", letterSpacing: 1 },
  big: { color: colors.text, fontSize: 52, fontWeight: "800", fontVariant: ["tabular-nums"] },
  dim: { color: colors.textDim, fontSize: 14, textAlign: "center" },
  track: {
    alignSelf: "stretch",
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.surfaceHigh,
    overflow: "hidden",
    marginVertical: 8,
  },
  fill: { height: "100%", borderRadius: 6, backgroundColor: colors.accent },
  fillDone: { backgroundColor: colors.success },
  row: { flexDirection: "row", gap: 12 },
  stat: { flex: 1, alignItems: "center", paddingHorizontal: 8 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: "700" },
  chart: { flexDirection: "row", gap: 6, height: 170, marginTop: 8 },
  barCol: { flex: 1, alignItems: "center", gap: 4 },
  barValue: { color: colors.textDim, fontSize: 10 },
  barTrack: { flex: 1, width: "70%", justifyContent: "flex-end" },
  bar: { width: "100%", minHeight: 2, borderRadius: 4, backgroundColor: colors.accent },
  barDay: { color: colors.textDim, fontSize: 11 },
  chips: { flexDirection: "row", gap: 8, marginTop: 4 },
  chip: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.surfaceHigh,
  },
  chipOn: { backgroundColor: colors.accent },
  chipText: { color: colors.text, fontWeight: "600" },
  button: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 20 },
  buttonText: { color: colors.bg, fontWeight: "700" },
  footnote: { color: colors.textDim, fontSize: 12, textAlign: "center" },
  shortcut: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14 },
  shortcutText: { color: colors.text, fontSize: 16, fontWeight: "700" },
});
