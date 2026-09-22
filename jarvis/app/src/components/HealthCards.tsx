import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { devlog } from "../lib/devlog";
import { HEART_WINDOW_HOURS, healthAvailable, healthPermission, todayHealth, type TodayHealth } from "../lib/health";
import { colors, mono, numeric, radius, space, type } from "../lib/theme";
import { Btn, GroupLabel, IconTile, Tile, Tiles, text } from "./ui";

// Apple Health on the Activity screen: heart, sleep, energy and today's
// workouts. Everything is optional — a phone with no watch has steps and little
// else — so each tile hides itself when Health has nothing for it rather than
// showing a row of dashes.

/**
 * HealthKit hands back an XPC failure when its privacy daemon is busy or the
 * phone is locked ("Apple Health couldn't be read … HealthPrivacyService",
 * device_logs 2026-09-21). It rights itself, so it gets one more go before the
 * user is shown an error. The raw message is logged either way: the pattern
 * below is the only one seen so far, and the next one has to be readable.
 */
async function readToday() {
  try {
    return await todayHealth();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!/HealthPrivacyService|Connection invalidated|Code=4097/.test(why)) throw err;
    devlog("warn", "Apple Health was busy; asking once more", why);
    await new Promise((r) => setTimeout(r, 800));
    return todayHealth();
  }
}

export function HealthCards() {
  const [health, setHealth] = useState<TodayHealth | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unavailable" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (alive: () => boolean = () => true) => {
    if (!healthAvailable) {
      setState("unavailable");
      return;
    }
    try {
      const started = Date.now();
      if ((await healthPermission()) !== "ok") {
        if (alive()) setState("unavailable");
        return;
      }
      const data = await readToday();
      if (!alive()) return;
      devlog(
        "log",
        `Apple Health read in ${Date.now() - started} ms`,
        `${data.heart.length} heart readings, ${data.workouts.length} workouts`,
      );
      setHealth(data);
      setState("ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      devlog("err", "Apple Health couldn't be read", message);
      if (!alive()) return;
      setError(message);
      setState("error");
    }
  }, []);

  // Reload on every visit: heart rate is only interesting if it's current.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load(() => !cancelled);
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  if (state === "unavailable") {
    return (
      <>
        <GroupLabel>Heart &amp; sleep</GroupLabel>
        <Text style={text.sub}>
          Apple Health needs the installed OVOA app (a development build). In Expo Go only steps are available.
        </Text>
      </>
    );
  }

  if (state === "error") {
    return (
      <>
        <GroupLabel>Heart &amp; sleep</GroupLabel>
        <Text style={text.sub}>{error}</Text>
        <Btn label="Try again" onPress={() => void load()} style={{ alignSelf: "flex-start" }} />
      </>
    );
  }

  if (state === "loading" || !health) {
    return <ActivityIndicator color={colors.now} style={{ marginVertical: space.s6 }} />;
  }

  const { heartRate, heart, restingHeartRate, heartRateMin, heartRateMax } = health;
  const nothing =
    !heartRate && !restingHeartRate && !health.sleepHours && !health.activeEnergyKcal && !health.workouts.length;

  if (nothing) {
    return (
      <>
        <GroupLabel>Heart &amp; sleep</GroupLabel>
        <Text style={text.sub}>
          Apple Health has nothing for today yet. Wear a watch or band that writes to Health, and allow OVOA to read
          Heart Rate and Sleep in Settings → Health → Data Access.
        </Text>
        <Btn label="Refresh" onPress={() => void load()} style={{ alignSelf: "flex-start" }} />
      </>
    );
  }

  return (
    <>
      <GroupLabel>Heart &amp; sleep</GroupLabel>
      <Tiles>
        {!!heartRate && (
          <Tile icon="heart-outline" tone="coral" label={`Heart · ${ago(heartRate.at)}`} value={`${heartRate.bpm}`} suffix=" bpm">
            {heart.length > 1 && <HeartGraph points={heart} />}
          </Tile>
        )}
        {!!restingHeartRate && <Tile icon="bed-outline" tone="violet" label="Resting" value={`${restingHeartRate}`} suffix=" bpm" />}
        {health.sleepHours !== undefined && <Tile icon="moon-outline" tone="blue" label="Sleep" value={`${health.sleepHours}`} suffix=" h" />}
        {health.activeEnergyKcal !== undefined && (
          <Tile icon="flame-outline" tone="amber" label="Active" value={`${Math.round(health.activeEnergyKcal)}`} suffix=" kcal" />
        )}
        {health.exerciseMinutes !== undefined && (
          <Tile icon="timer-outline" tone="green" label="Exercise" value={`${Math.round(health.exerciseMinutes)}`} suffix=" min" />
        )}
        {health.hrvMs !== undefined && <Tile icon="analytics-outline" tone="pink" label="HRV (SDNN)" value={`${Math.round(health.hrvMs)}`} suffix=" ms" />}
        {health.standHours !== undefined && <Tile icon="walk-outline" tone="teal" label="Stand" value={`${Math.round(health.standHours)}`} suffix=" h" />}
      </Tiles>
      {heart.length > 1 && (
        <Text style={styles.foot}>
          {`last ${HEART_WINDOW_HOURS} h · ${heart.length} readings`}
          {heartRateMin && heartRateMax ? ` · today ${heartRateMin}–${heartRateMax} bpm` : ""}
        </Text>
      )}

      {health.workouts.length > 0 && (
        <>
          <GroupLabel>Today&apos;s workouts</GroupLabel>
          {health.workouts.map((w) => (
            <Workout key={w.start} workout={w} heart={heart} />
          ))}
        </>
      )}
    </>
  );
}

/**
 * One workout, with its own slice of the heart-rate readings under it.
 *
 * The design has a smooth bpm line and a "where you were" address. Neither is
 * in the data: HealthKit workout samples here carry no route, and nothing draws
 * a polyline without react-native-svg, which would be a new native dependency.
 * So the trace is the readings that fall inside the workout, as bars — the same
 * shape the app has always drawn heart rate in.
 */
function Workout({
  workout,
  heart,
}: {
  workout: TodayHealth["workouts"][number];
  heart: TodayHealth["heart"];
}) {
  const start = workout.start;
  const end = start + (workout.minutes ?? 0) * 60_000;
  const during = workout.minutes ? heart.filter((p) => p.at >= start && p.at <= end) : [];
  const peak = during.length ? Math.max(...during.map((p) => p.bpm)) : null;

  return (
    <View style={styles.workout}>
      <View style={styles.workoutHead}>
        <IconTile name="barbell-outline" tone="coral" />
        <Text style={[text.body, { flex: 1, fontWeight: "600" }]} numberOfLines={1}>
          {spaced(workout.type)}
        </Text>
        <Text style={styles.stamp}>
          {clock(start)}
          {workout.minutes ? ` – ${clock(end)}` : ""}
        </Text>
      </View>
      {during.length > 1 && <HeartGraph points={during} />}
      <View style={styles.workoutFoot}>
        {workout.minutes !== undefined && <Stat value={`${workout.minutes}`} unit="min" />}
        {!!workout.energy && <Stat value={workout.energy} unit="" />}
        {!!workout.distance && <Stat value={workout.distance} unit="" />}
        {peak !== null && <Stat value={`${peak}`} unit="peak" />}
      </View>
    </View>
  );
}

const Stat = ({ value, unit }: { value: string; unit: string }) => (
  <Text style={styles.stat}>
    <Text style={styles.statValue}>{value}</Text>
    {unit ? ` ${unit}` : ""}
  </Text>
);

/** The readings as bars, scaled to the range they cover plus a little room. */
function HeartGraph({ points }: { points: { at: number; bpm: number }[] }) {
  const values = points.map((p) => p.bpm);
  const low = Math.max(30, Math.min(...values) - 5);
  const high = Math.max(...values) + 5;
  const span = Math.max(1, high - low);
  return (
    <View style={styles.graph}>
      {points.map((p, i) => (
        <View
          key={`${p.at}-${i}`}
          style={[
            styles.graphBar,
            {
              height: `${Math.max(6, ((p.bpm - low) / span) * 100)}%`,
              // The newest reading is the one being read as "now".
              backgroundColor: i === points.length - 1 ? colors.stop : colors.wash2,
            },
          ]}
        />
      ))}
    </View>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** "12 min ago", for how fresh a reading is. */
function ago(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : clock(at);
}

/** HealthKit names workouts in camel case ("functionalStrengthTraining"). */
const spaced = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

const styles = StyleSheet.create({
  foot: { ...type.meta, ...mono, color: colors.inkMute, ...numeric },

  workout: { backgroundColor: colors.wash, borderRadius: radius.tile, padding: space.s4, gap: space.s2 },
  workoutHead: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  stamp: { ...type.micro, ...mono, ...numeric, color: colors.inkMute, letterSpacing: 0 },
  workoutFoot: { flexDirection: "row", gap: space.s5, flexWrap: "wrap" },
  stat: { ...type.meta, color: colors.inkDim, ...numeric },
  statValue: { color: colors.ink, fontWeight: "600" },

  graph: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 46, marginTop: space.s2 },
  graphBar: { flex: 1, minHeight: 2, borderRadius: 2 },
});
