import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { devlog } from "../lib/devlog";
import { HEART_WINDOW_HOURS, healthAvailable, healthPermission, todayHealth, type TodayHealth } from "../lib/health";
import { colors } from "../lib/theme";

// Apple Health on the Activity tab: heart rate (with the last few hours as a
// graph), sleep, energy, exercise and today's workouts. Everything is optional —
// a phone with no watch has steps and little else, so each card hides itself
// when Health has nothing for it, rather than showing a row of dashes.

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
      <View style={styles.card}>
        <Text style={styles.label}>HEART & SLEEP</Text>
        <Text style={styles.dim}>
          Apple Health needs the installed OVOA app (a development build). In Expo Go only steps are available.
        </Text>
      </View>
    );
  }

  if (state === "error") {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>HEART & SLEEP</Text>
        <Text style={styles.dim}>{error}</Text>
        <Pressable style={styles.retry} onPress={() => void load()}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (state === "loading" || !health) {
    return (
      <View style={[styles.card, { alignItems: "center" }]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.dim}>Reading Apple Health…</Text>
      </View>
    );
  }

  const { heartRate, heart, restingHeartRate, heartRateMin, heartRateMax } = health;
  const nothing =
    !heartRate && !restingHeartRate && !health.sleepHours && !health.activeEnergyKcal && !health.workouts.length;

  if (nothing) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>HEART & SLEEP</Text>
        <Text style={styles.dim}>
          Apple Health has nothing for today yet. Wear a watch or band that writes to Health, and allow OVOA to read
          Heart Rate and Sleep in Settings → Health → Data Access.
        </Text>
        <Pressable style={styles.retry} onPress={() => void load()}>
          <Text style={styles.retryText}>Refresh</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      {(heartRate || restingHeartRate) && (
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.label}>HEART RATE</Text>
            {!!heartRate && <Text style={styles.dim}>{ago(heartRate.at)}</Text>}
          </View>
          <View style={styles.bpmRow}>
            <Text style={styles.bpm}>{heartRate ? heartRate.bpm : "—"}</Text>
            <Text style={styles.bpmUnit}>bpm</Text>
            {!!restingHeartRate && (
              <View style={styles.resting}>
                <Text style={styles.restingValue}>{restingHeartRate}</Text>
                <Text style={styles.dimSmall}>resting</Text>
              </View>
            )}
          </View>
          {heart.length > 1 ? (
            <>
              <HeartGraph points={heart} />
              <View style={styles.cardHead}>
                <Text style={styles.dimSmall}>
                  {`last ${HEART_WINDOW_HOURS} h · ${heart.length} readings`}
                </Text>
                <Text style={styles.dimSmall}>
                  {heartRateMin && heartRateMax ? `today ${heartRateMin}–${heartRateMax} bpm` : ""}
                </Text>
              </View>
            </>
          ) : (
            <Text style={styles.dimSmall}>Not enough readings today to draw a graph.</Text>
          )}
        </View>
      )}

      <View style={styles.row}>
        <Tile label="Sleep" value={health.sleepHours !== undefined ? `${health.sleepHours} h` : "—"} />
        <Tile
          label="Active"
          value={health.activeEnergyKcal !== undefined ? `${Math.round(health.activeEnergyKcal)} kcal` : "—"}
        />
        <Tile
          label="Exercise"
          value={health.exerciseMinutes !== undefined ? `${Math.round(health.exerciseMinutes)} min` : "—"}
        />
      </View>

      {(health.hrvMs !== undefined || health.standHours !== undefined) && (
        <View style={styles.row}>
          {health.hrvMs !== undefined && <Tile label="HRV (SDNN)" value={`${Math.round(health.hrvMs)} ms`} />}
          {health.standHours !== undefined && <Tile label="Stand" value={`${Math.round(health.standHours)} h`} />}
        </View>
      )}

      {health.workouts.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>TODAY'S WORKOUTS</Text>
          {health.workouts.map((w) => (
            <View key={w.start} style={styles.workout}>
              <Text style={styles.workoutName}>{spaced(w.type)}</Text>
              <Text style={styles.dimSmall}>
                {[
                  new Date(w.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
                  w.minutes !== undefined ? `${w.minutes} min` : null,
                  w.energy,
                  w.distance,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

/** The heart-rate readings as bars, scaled to the range they cover (plus a little room). */
function HeartGraph({ points }: { points: { at: number; bpm: number }[] }) {
  const values = points.map((p) => p.bpm);
  const low = Math.max(30, Math.min(...values) - 5);
  const high = Math.max(...values) + 5;
  const span = Math.max(1, high - low);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <>
      <View style={styles.graph}>
        {points.map((p, i) => (
          <View
            key={`${p.at}-${i}`}
            style={[
              styles.graphBar,
              {
                height: `${Math.max(4, ((p.bpm - low) / span) * 100)}%`,
                // The newest reading is the one being read as "now".
                backgroundColor: i === points.length - 1 ? colors.accent : colors.danger,
                opacity: i === points.length - 1 ? 1 : 0.55,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.cardHead}>
        <Text style={styles.dimSmall}>{clock(first.at)}</Text>
        <Text style={styles.dimSmall}>{`${Math.round(low)}–${Math.round(high)} bpm`}</Text>
        <Text style={styles.dimSmall}>{clock(last.at)}</Text>
      </View>
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={[styles.card, styles.tile]}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.dimSmall}>{label}</Text>
    </View>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 6,
  },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: colors.textDim, fontSize: 12, fontWeight: "600", letterSpacing: 1 },
  dim: { color: colors.textDim, fontSize: 14 },
  dimSmall: { color: colors.textDim, fontSize: 11 },
  bpmRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  bpm: { color: colors.text, fontSize: 44, fontWeight: "800", fontVariant: ["tabular-nums"] },
  bpmUnit: { color: colors.textDim, fontSize: 16, paddingBottom: 8 },
  resting: { marginLeft: "auto", alignItems: "flex-end" },
  restingValue: { color: colors.text, fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] },
  graph: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 64, marginTop: 10 },
  graphBar: { flex: 1, minHeight: 2, borderRadius: 2 },
  row: { flexDirection: "row", gap: 12 },
  tile: { flex: 1, alignItems: "center", paddingHorizontal: 8 },
  tileValue: { color: colors.text, fontSize: 18, fontWeight: "700" },
  workout: { paddingVertical: 6, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
  workoutName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  retry: { alignSelf: "flex-start", paddingVertical: 8 },
  retryText: { color: colors.accent, fontWeight: "600" },
});
