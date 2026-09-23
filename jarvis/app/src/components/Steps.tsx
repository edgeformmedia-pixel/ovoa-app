import { useFocusEffect } from "expo-router";
import { Pedometer } from "expo-sensors";
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, StyleSheet, Text, View } from "react-native";
import { api, type StepDay } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { kmForSteps, lastSevenDays, stepPermission } from "../lib/steps";
import { colors, mono, numeric, space, type } from "../lib/theme";
import { CountUp, PressScale, Ring } from "./motion";
import { Btn, GroupLabel, text } from "./ui";

// Today's steps against the goal, the week behind it, and the goal itself.
// Moved out of the Activity screen so the free plan's home can show it too.

const GOALS = [5000, 8000, 10000, 12000, 15000];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Steps() {
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
        if (history.length) api.syncSteps(token, history).catch(logFail("steps: api.syncSteps"));
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

  const counting = status === "ok" || status === "loading";

  return counting ? (
    <>
      {/* Today against the goal as a ring that sweeps round, the count rolling up beside it. */}
      <View style={styles.hero}>
        <Ring progress={progress} size={132} stroke={14} color={progress >= 1 ? colors.done : colors.now}>
          <Text style={styles.pct}>{Math.round(progress * 100)}%</Text>
        </Ring>
        <View style={styles.heroText}>
          <CountUp value={today} style={styles.big} />
          <Text style={styles.ofText}>of {goal.toLocaleString()} steps</Text>
          <CountUp value={kmForSteps(today)} format={(n) => `${n.toFixed(1)} km`} style={styles.ofText} />
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
          <PressScale key={g} sink={0.92} onPress={() => setGoal(g)} style={[styles.chip, g === goal && styles.chipOn]}>
            <Text style={[styles.chipText, g === goal && styles.chipTextOn]}>{g / 1000}k</Text>
          </PressScale>
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
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "center", gap: space.s5, paddingBottom: space.s5 },
  heroText: { flex: 1, gap: 2 },
  big: { ...type.display, color: colors.ink, ...numeric },
  pct: { ...type.head, color: colors.ink, ...numeric },
  ofText: { ...type.meta, color: colors.inkDim, ...numeric },

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
});
