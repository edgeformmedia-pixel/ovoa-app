import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import type { HealthDay, SleepNight } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog, logFail } from "../lib/devlog";
import {
  healthAvailable,
  healthPermission,
  lockedHealthError,
  todayHealth,
  type HeartPoint,
  type TodayHealth,
} from "../lib/health";
import { healthStatus, onHealthStatus, syncHealth } from "../lib/healthSync";
import {
  bodyFromPhone,
  bodyFromServer,
  clock,
  hasBody,
  healthHint,
  hoursMinutes,
  stageBar,
  weekAverages,
  type Body,
} from "../lib/healthView";
import { dayKey } from "../lib/steps";
import { colors, mono, numeric, radius, space, type } from "../lib/theme";
import { Figures, HeartCard } from "./HeartCard";
import { DrawnLine, Skeleton } from "./motion";
import { Btn, GroupLabel, IconTile, Tile, Tiles, text, toneInk } from "./ui";

// Health on the Activity screen and the free plan's home (FreeToday): heart
// rate first (HeartCard, read from the server, so the Band's readings show
// without a watch), then Apple Health's sleep, the body's numbers, energy and
// today's workouts. Everything here is optional — a phone with no watch has
// active energy and little else — so each tile hides itself when there's
// nothing for it, and at most one line says what is missing and why, rather
// than a hint on every tile.

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

type State = "loading" | "phone" | "locked" | "unavailable" | "error";

type Props = {
  /** GET /health/days from the screen (activity.tsx); without it there are no resting bars, week row or locked-phone copy. */
  week?: HealthDay[] | null;
  /**
   * Activity's alone: each visit syncs Apple Health now, past the sync's
   * 15-minute wait, so what the Health sheet just allowed goes up at once. The
   * free home is visited far more often and leaves syncing to the timers in
   * lib/healthSync.ts: every forced run is a HealthKit read, maybe two uploads
   * and a device_logs row.
   */
  syncOnFocus?: boolean;
};

/**
 * Heart rate and the rest of health together, so every screen that shows
 * health shows both: splitting heart rate out into its own card had left the
 * free home, which renders this alone, with no heart rate at all (2026-09-23).
 */
export function HealthCards({ week = null, syncOnFocus = false }: Props) {
  return (
    <>
      <HeartCard week={week} />
      <SleepAndBody week={week} syncOnFocus={syncOnFocus} />
    </>
  );
}

function SleepAndBody({ week, syncOnFocus }: Required<Props>) {
  const { token } = useSession();
  const [phone, setPhone] = useState<TodayHealth | null>(null);
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<string | null>(null);
  // Whether reading Health looks switched off is worked out by the sync (healthSync.ts reads).
  const [reads, setReads] = useState(healthStatus().reads);
  useEffect(() => onHealthStatus(() => setReads(healthStatus().reads)), []);

  const load = useCallback(
    async (alive: () => boolean = () => true) => {
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
        if (syncOnFocus) syncHealth(token, { force: true }).catch(logFail("health cards: syncHealth"));
        const data = await readToday();
        if (!alive()) return;
        devlog(
          "log",
          `Apple Health read in ${Date.now() - started} ms`,
          `${data.heart.length} heart readings, ${data.workouts.length} workouts`,
        );
        setPhone(data);
        setState("phone");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (lockedHealthError(err)) {
          devlog("log", "Apple Health is locked; showing the server's copy", message);
          if (alive()) setState("locked");
          return;
        }
        devlog("err", "Apple Health couldn't be read", message);
        if (!alive()) return;
        setError(message);
        setState("error");
      }
    },
    [token, syncOnFocus],
  );

  // Reload on every visit; it asks for Health access the first time, where it's needed.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load(() => !cancelled);
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  if (state === "loading") {
    // The tiles' shape while Health answers, rather than a spinner.
    return (
      <>
        <GroupLabel>Sleep &amp; body</GroupLabel>
        <Tiles>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.skelTile}>
              <Skeleton width={30} height={30} radius={9} />
              <Skeleton width="55%" height={11} />
              <Skeleton width="40%" height={20} />
            </View>
          ))}
        </Tiles>
      </>
    );
  }

  if (state === "error") {
    return (
      <>
        <GroupLabel>Sleep &amp; body</GroupLabel>
        <Text style={text.sub}>{error}</Text>
        <Btn label="Try again" onPress={() => void load()} style={{ alignSelf: "flex-start" }} />
      </>
    );
  }

  const today = dayKey(new Date());
  // When Health can't be read here, the day as the phone last sent it stands in (GET /health/days).
  const sent = week?.find((d) => d.day === today);
  const body = state === "phone" && phone ? bodyFromPhone(phone) : sent ? bodyFromServer(sent) : null;
  const averages = weekAverages(week ?? [], today);
  const lastWeek: { label: string; value: string }[] = [];
  if (averages.sleepMin !== null) lastWeek.push({ label: "Sleep", value: hoursMinutes(averages.sleepMin) });
  if (averages.restingBpm !== null) lastWeek.push({ label: "Resting", value: `${averages.restingBpm} bpm` });
  if (averages.steps !== null) lastWeek.push({ label: "Steps", value: averages.steps.toLocaleString() });

  if (!body || (state !== "phone" && !hasBody(body))) {
    return (
      <>
        <GroupLabel>Sleep &amp; body</GroupLabel>
        <Text style={text.sub}>
          {state === "locked"
            ? "Apple Health can't be read while your iPhone is locked. Unlock it to refresh."
            : "Apple Health isn't available here: it needs the OVOA app on an iPhone."}
        </Text>
        <LastWeek items={lastWeek} />
      </>
    );
  }

  const hint = healthHint(body, reads === "off");
  const heart = state === "phone" && phone ? phone.heart : [];

  return (
    <>
      <GroupLabel>Sleep &amp; body</GroupLabel>
      {state !== "phone" && !!sent?.updatedAt && (
        <Text style={text.meta}>
          From {clock(sent.updatedAt)}.{state === "locked" ? " Unlock your iPhone to refresh." : ""}
        </Text>
      )}
      {hasBody(body) && <BodyTiles body={body} />}

      {hint === "cant_read" && (
        <>
          <Text style={text.sub}>
            OVOA can&apos;t read Apple Health. Open Health, tap your picture, then Apps → OVOA → Turn On All.
          </Text>
          <Btn
            label="Open Health"
            onPress={() => void Linking.openURL("x-apple-health://").catch(logFail("health cards: opening Health"))}
            style={{ alignSelf: "flex-start" }}
          />
        </>
      )}
      {hint === "watch" && (
        <Text style={text.meta}>
          Sleep, HRV and blood oxygen show up here when an Apple Watch or another tracker saves them to Apple Health.
        </Text>
      )}

      <LastWeek items={lastWeek} />

      {body.workouts.length > 0 && (
        <>
          <GroupLabel>Today&apos;s workouts</GroupLabel>
          {body.workouts.map((w) => (
            <Workout key={w.start} workout={w} heart={heart} />
          ))}
        </>
      )}
    </>
  );
}

const round1 = (n: number) => `${Math.round(n * 10) / 10}`;

function BodyTiles({ body }: { body: Body }) {
  return (
    <Tiles>
      {!!body.sleep && <SleepTile sleep={body.sleep} />}
      {body.hrvMs !== undefined && <Tile icon="analytics-outline" tone="pink" label="HRV" value={`${Math.round(body.hrvMs)}`} suffix=" ms" />}
      {body.spo2Pct !== undefined && (
        <Tile icon="water-outline" tone="coral" label="Blood oxygen" value={`${Math.round(body.spo2Pct)}`} suffix=" %" />
      )}
      {body.respRate !== undefined && <Tile icon="leaf-outline" tone="teal" label="Breathing" value={round1(body.respRate)} suffix=" /min" />}
      {body.weightKg !== undefined && <Tile icon="scale-outline" tone="violet" label="Weight" value={round1(body.weightKg)} suffix=" kg" />}
      {body.activeKcal !== undefined && (
        <Tile icon="flame-outline" tone="amber" label="Active" value={`${Math.round(body.activeKcal)}`} count={Math.round(body.activeKcal)} suffix=" kcal" />
      )}
      {body.exerciseMin !== undefined && (
        <Tile icon="timer-outline" tone="green" label="Exercise" value={`${Math.round(body.exerciseMin)}`} count={Math.round(body.exerciseMin)} suffix=" min" />
      )}
      {body.standHours !== undefined && <Tile icon="walk-outline" tone="teal" label="Stand" value={`${Math.round(body.standHours)}`} suffix=" h" />}
    </Tiles>
  );
}

/**
 * Last night: time asleep, bed to wake, and the stages when something recorded
 * them. Time in bed alone (an iPhone's Sleep schedule) is shown as "In bed" and
 * never called sleep.
 */
function SleepTile({ sleep }: { sleep: SleepNight }) {
  const asleep = sleep.asleepMin > 0;
  const stages = asleep ? stageBar(sleep.stages) : [];
  const deep = stages.find((s) => s.stage === "deep");
  const rem = stages.find((s) => s.stage === "rem");
  return (
    <Tile icon="moon-outline" tone="blue" label={asleep ? "Sleep" : "In bed"} value={hoursMinutes(asleep ? sleep.asleepMin : sleep.inBedMin ?? 0)} small>
      <Text style={styles.tileNote}>
        {clock(sleep.start)}–{clock(sleep.end)}
      </Text>
      {stages.length > 0 && (
        <>
          <View style={styles.stages}>
            {stages.map((s) => (
              <View key={s.stage} style={{ flex: s.share, backgroundColor: toneInk("blue"), opacity: STAGE_SHADE[s.stage] }} />
            ))}
          </View>
          <Text style={styles.tileNote}>
            {[deep && `Deep ${hoursMinutes(deep.min)}`, rem && `REM ${hoursMinutes(rem.min)}`].filter(Boolean).join(" · ")}
          </Text>
        </>
      )}
    </Tile>
  );
}

/** One colour, the sleep tile's own: deep sleep darkest, awake palest. */
const STAGE_SHADE = { deep: 1, core: 0.6, rem: 0.35, awake: 0.12 } as const;

function LastWeek({ items }: { items: { label: string; value: string }[] }) {
  if (!items.length) return null;
  return (
    <>
      <Text style={styles.caption}>Last 7 days, on average</Text>
      <Figures items={items} />
    </>
  );
}

/**
 * One workout, with its own slice of the heart-rate readings under it.
 *
 * The design has a smooth bpm line and a "where you were" address. Neither is
 * in the data: HealthKit workout samples here carry no route. So the trace is
 * the Health readings that fall inside the workout (the Band's included, since
 * OVOA saves them to Health); from the server's copy there are no readings, only
 * the average it worked out.
 */
function Workout({ workout, heart }: { workout: Body["workouts"][number]; heart: HeartPoint[] }) {
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
        {workout.avgBpm !== undefined && <Stat value={`${workout.avgBpm}`} unit="avg bpm" />}
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

/** The workout's readings as a line that draws itself in, the newest pulsing at its end. */
function HeartGraph({ points }: { points: HeartPoint[] }) {
  const [width, setWidth] = useState(0);
  return (
    <View style={styles.graph} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      {width > 0 && <DrawnLine values={points.map((p) => p.bpm)} width={width} height={styles.graph.height} />}
    </View>
  );
}

/** HealthKit names workouts in camel case ("functionalStrengthTraining"). */
const spaced = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

const styles = StyleSheet.create({
  tileNote: { ...type.meta, color: colors.inkMute, ...numeric },
  stages: { flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", gap: 1, marginTop: space.s1 },
  caption: { ...type.meta, color: colors.inkMute, paddingTop: space.s3 },

  workout: { backgroundColor: colors.wash, borderRadius: radius.tile, padding: space.s4, gap: space.s2 },
  workoutHead: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  stamp: { ...type.micro, ...mono, ...numeric, color: colors.inkMute, letterSpacing: 0 },
  workoutFoot: { flexDirection: "row", gap: space.s5, flexWrap: "wrap" },
  stat: { ...type.meta, color: colors.inkDim, ...numeric },
  statValue: { color: colors.ink, fontWeight: "600" },

  graph: { height: 46, marginTop: space.s2 },
  skelTile: { flexBasis: "47%", flexGrow: 1, backgroundColor: colors.wash, borderRadius: radius.tile, padding: space.s4, gap: space.s2 },
});
