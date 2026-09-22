import { useFocusEffect } from "expo-router";
import { Pedometer } from "expo-sensors";
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { HealthCards } from "../../components/HealthCards";
import { Btn, GroupLabel, Screen, TopBar, text } from "../../components/ui";
import { api, type StepDay } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { logFail } from "../../lib/devlog";
import { kmForSteps, lastSevenDays, stepPermission } from "../../lib/steps";
import { colors, mono, numeric, space, type } from "../../lib/theme";

// Health, and only health. What OVOA did, what's due and what slipped used to
// pile up on top of this screen as a stack of cards; all of that is on the
// spine on Day now, in the order it happened.

const GOALS = [5000, 8000, 10000, 12000, 15000];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Activity() {
  const { token, user, setUser } = useSession();
  const [status, setStatus] = useState<"loading" | "ok" | "denied" | "unavailable">("loading");
  const [days, setDays] = useState<StepDay[]>([]);
  const [liveExtra, setLiveExtra] = useState(0);

  const goal = user?.settings.stepGoal ?? 8000;

  // Reload history whenever the screen is opened, and keep the server copy in sync.
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
        if (history.length) api.syncSteps(token, history).catch(logFail("index: api.syncSteps"));
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
  // The goal line is the reference, so the bars are measured against it rather
  // than against whatever the best day happened to be.
  const top = Math.max(goal, ...days.map((d) => d.steps), today) * 1.05;

  const setGoal = async (stepGoal: number) => {
    try {
      setUser((await api.updateMe(token, { stepGoal })).user);
    } catch {}
  };

  const when = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const counting = status === "ok" || status === "loading";

  return (
    <View style={styles.page}>
      <TopBar title="Activity" when={when} />
      <Screen>
        {counting ? (
          <>
            <View style={styles.hero}>
              <Text style={styles.big}>{today.toLocaleString()}</Text>
              <View style={styles.of}>
                <Text style={styles.ofText}>of {goal.toLocaleString()} steps</Text>
                <Text style={styles.ofText}>{kmForSteps(today).toFixed(1)} km</Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${progress * 100}%` }]} />
              </View>
            </View>

            <View style={styles.week}>
              {/* The goal, drawn where it falls. */}
              <View style={[styles.goalLine, { bottom: `${(goal / top) * 100}%` }]} />
              {days.map((d, i) => {
                const steps = i === days.length - 1 ? today : d.steps;
                const isToday = i === days.length - 1;
                return (
                  <View key={d.day} style={styles.col}>
                    <View
                      style={[
                        styles.bar,
                        { height: `${Math.max(2, (steps / top) * 100)}%` },
                        steps >= goal && styles.barHit,
                        // Today is the only bar allowed to be teal.
                        isToday && styles.barToday,
                      ]}
                    />
                  </View>
                );
              })}
            </View>
            <View style={styles.weekRow}>
              {days.map((d, i) => (
                <Text key={d.day} style={[styles.weekDay, i === days.length - 1 && styles.weekToday]}>
                  {i === days.length - 1 ? "Today" : WEEKDAY[new Date(`${d.day}T12:00:00`).getDay()]}
                </Text>
              ))}
            </View>

            <GroupLabel>Daily goal</GroupLabel>
            <View style={styles.chips}>
              {GOALS.map((g) => (
                <Pressable key={g} onPress={() => setGoal(g)} style={[styles.chip, g === goal && styles.chipOn]}>
                  <Text style={[styles.chipText, g === goal && styles.chipTextOn]}>{g / 1000}k</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : (
          <>
            <GroupLabel>Steps</GroupLabel>
            <Text style={text.sub}>
              {status === "denied"
                ? "Allow Motion & Fitness access in the Settings app to count your steps."
                : "This device doesn't have a step counter."}
            </Text>
            {status === "denied" && (
              <Btn label="Open Settings" onPress={() => Linking.openSettings()} style={{ alignSelf: "flex-start" }} />
            )}
          </>
        )}

        <HealthCards />

        <Text style={styles.footnote}>Distance is an estimate based on average stride.</Text>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },

  hero: { gap: space.s2, paddingBottom: space.s4 },
  big: { ...type.display, color: colors.ink, ...numeric },
  of: { flexDirection: "row", justifyContent: "space-between" },
  ofText: { ...type.meta, color: colors.inkDim, ...numeric },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.wash2, overflow: "hidden", marginTop: space.s1 },
  // Not teal: a progress fill is not "now, or your turn".
  fill: { height: "100%", borderRadius: 3, backgroundColor: colors.ink },

  week: { flexDirection: "row", alignItems: "flex-end", gap: 10, height: 64 },
  goalLine: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: colors.rail },
  col: { flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" },
  bar: { width: "60%", borderRadius: 3, backgroundColor: colors.wash2 },
  barHit: { backgroundColor: "#C9CFD8" },
  barToday: { backgroundColor: colors.now },
  weekRow: { flexDirection: "row", gap: 10, paddingTop: space.s2 },
  weekDay: { flex: 1, textAlign: "center", ...type.micro, ...mono, color: colors.inkMute, letterSpacing: 0 },
  weekToday: { color: colors.now },

  chips: { flexDirection: "row", gap: space.s2 },
  chip: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 12, backgroundColor: colors.wash },
  // Ink, not teal: which goal is selected is not urgency.
  chipOn: { backgroundColor: colors.ink },
  chipText: { ...type.sub, fontWeight: "600", color: colors.inkDim, ...numeric },
  chipTextOn: { color: colors.paper },

  footnote: { ...type.meta, color: colors.inkMute, textAlign: "center", paddingTop: space.s4 },
});
