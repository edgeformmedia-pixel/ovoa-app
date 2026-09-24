import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { api, type HealthDay, type HeartDay } from "../lib/api";
import { useSession } from "../lib/auth";
import * as clip from "../lib/clip";
import { devlog } from "../lib/devlog";
import { measureNow, pendingBand } from "../lib/heart";
import {
  ago,
  clock,
  evenOut,
  heartView,
  hoursMinutes,
  plausibleBpm,
  RESTING_FROM,
  restingWeek,
  readingFrom,
  STALE_MIN,
  type Reading,
} from "../lib/healthView";
import { onSignOut } from "../lib/signOut";
import { dayKey } from "../lib/steps";
import { colors, mono, numeric, radius, space, type } from "../lib/theme";
import { CountUp, DrawnLine, Skeleton } from "./motion";
import { Btn, GroupLabel, text } from "./ui";

// Heart rate, at the top of HealthCards (Activity and the free plan's home),
// read from the server (GET /hr/day), where the OVOA Band's readings and a
// watch's (through Apple Health) meet. The old heart tile read Apple Health
// alone, and Health has no heart rate on a phone without a watch, so the Band's
// readings — 19 of them on 2026-09-21, 54-105 bpm, in hr_samples — only ever
// showed on the dev-only Live screen. Reading the server also means no Health
// permission is needed to see them.

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The day's line is drawn through this many points at most (healthView.ts evenOut). */
const LINE_POINTS = 60;
/** How long "Measure now" waits for the Band; it usually answers in about a second (build 51's probe). */
const MEASURE_WAIT_MS = 15_000;

/**
 * The last answer, so coming back to Activity shows it at once. In memory
 * only: a day of points is far past what the keychain (lib/storage.ts,
 * SecureStore) should hold.
 */
let cached: HeartDay | null = null;
onSignOut("heart card", () => {
  cached = null;
});

const midnight = () => new Date().setHours(0, 0, 0, 0);

/** `week` is GET /health/days from the screen (activity.tsx), for the resting bars. */
export function HeartCard({ week = null }: { week?: HealthDay[] | null }) {
  const { token } = useSession();
  const [day, setDay] = useState<HeartDay | null>(() => (cached?.day === dayKey(new Date()) ? cached : null));
  const [failed, setFailed] = useState(false);
  /** Band readings heard while the screen is open, until the server has them. */
  const [heard, setHeard] = useState<Reading[]>([]);
  const [linked, setLinked] = useState(clip.isLinked());
  const [measuring, setMeasuring] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const fresh = await api.heartDay(token);
        if (!alive()) return;
        cached = fresh;
        setDay(fresh);
        setFailed(false);
      } catch (err) {
        devlog("warn", "heart card: couldn't load today", err instanceof Error ? err.message : String(err));
        if (alive()) setFailed(true);
      } finally {
        if (alive()) setNow(Date.now());
      }
    },
    [token],
  );

  // On every visit, every minute while it's open, and after every Band reading.
  useFocusEffect(
    useCallback(() => {
      let focused = true;
      const alive = () => focused;
      void load(alive);
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void load(alive);
      }, 60_000);
      const off = clip.onHeartRate((bpm) => {
        if (!plausibleBpm(bpm)) return;
        setHeard((h) => [...h, { ts: Date.now(), bpm }].slice(-60));
        setMeasuring(false);
        void load(alive);
      });
      return () => {
        focused = false;
        clearInterval(timer);
        off();
      };
    }, [load]),
  );

  useEffect(() => clip.onLinkChange(setLinked), []);

  useEffect(() => {
    if (!measuring) return;
    const t = setTimeout(() => {
      setMeasuring(false);
      setNote("The Band didn't answer. Try again in a moment.");
    }, MEASURE_WAIT_MS);
    return () => clearTimeout(t);
  }, [measuring]);

  const measure = async () => {
    setNote(null);
    setMeasuring(true);
    // The reading comes back through clip.onHeartRate above.
    if (!(await measureNow())) {
      setMeasuring(false);
      setNote("The Band is busy. Try again in a moment.");
    }
  };

  const measureButton = linked && <Btn label="Measure now" onPress={() => void measure()} busy={measuring} />;

  if (!day) {
    return (
      <>
        <GroupLabel>Heart rate</GroupLabel>
        {failed ? (
          <>
            <Text style={text.sub}>Today&apos;s heart rate couldn&apos;t be loaded.</Text>
            <Btn label="Try again" onPress={() => void load()} style={{ alignSelf: "flex-start" }} />
          </>
        ) : (
          <View style={{ gap: space.s2 }}>
            <Skeleton width={120} height={40} />
            <Skeleton width="60%" height={12} />
            <Skeleton height={56} style={{ marginTop: space.s2 }} />
          </View>
        )}
      </>
    );
  }

  const view = heartView(day, [...pendingBand(), ...heard], midnight());
  const { latest } = view;

  if (!latest) {
    return (
      <>
        <GroupLabel>Heart rate</GroupLabel>
        <Text style={text.sub}>No heart rate yet. Wear your OVOA Band, or a watch that saves heart rate to Apple Health.</Text>
        {measureButton && <View style={{ alignSelf: "flex-start" }}>{measureButton}</View>}
        {!!note && <Text style={text.meta}>{note}</Text>}
        <RestingWeek days={week} />
      </>
    );
  }

  const stale = now - latest.ts > STALE_MIN * 60_000;
  const figures: FigureItem[] = [];
  for (const [label, value] of [["Low", view.low], ["Avg", view.avg], ["High", view.high]] as const) {
    if (value !== null) figures.push({ label, value: String(value) });
  }
  if (view.restingBpm !== null) {
    figures.push({
      label: "Resting",
      value: String(view.restingBpm),
      note: view.restingFrom ? RESTING_FROM[view.restingFrom] : undefined,
    });
  }

  return (
    <>
      <GroupLabel>Heart rate</GroupLabel>
      <View style={styles.hero}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.bpm, stale && styles.staleText]}>
            <CountUp value={latest.bpm} style={[styles.bpm, stale && styles.staleText]} />
            <Text style={styles.unit}> bpm</Text>
          </Text>
          <Text style={styles.from}>
            from {readingFrom(latest.source)} · {ago(latest.ts, now)}
          </Text>
        </View>
        {measureButton}
      </View>
      {!!note && <Text style={text.meta}>{note}</Text>}

      {view.points.length > 1 && <DayLine points={view.points} faded={stale} />}

      {figures.length > 0 && <Figures items={figures} />}
      <Text style={styles.foot}>
        {`${view.count} ${view.count === 1 ? "reading" : "readings"} today`}
        {view.raisedMin > 0 ? ` · raised for ${hoursMinutes(view.raisedMin)}` : ""}
      </Text>

      <RestingWeek days={week} />
    </>
  );
}

/** Today's line, first reading to latest, with the times at either end. */
function DayLine({ points, faded }: { points: Reading[]; faded: boolean }) {
  const [width, setWidth] = useState(0);
  const line = evenOut(points, LINE_POINTS);
  return (
    <View style={{ opacity: faded ? 0.45 : 1 }}>
      <View style={styles.line} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
        {width > 0 && <DrawnLine values={line.map((p) => p.bpm)} width={width} height={styles.line.height} />}
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisText}>{clock(points[0].ts)}</Text>
        <Text style={styles.axisText}>{clock(points[points.length - 1].ts)}</Text>
      </View>
    </View>
  );
}

/** Resting heart rate a bar a day, when two or more days have one. */
function RestingWeek({ days }: { days: HealthDay[] | null }) {
  const bars = restingWeek(days ?? []);
  const have = bars.map((b) => b.bpm).filter((b): b is number => b !== null);
  if (have.length < 2) return null;
  // Scaled to the week's own range, from a little under its lowest, so a few bpm show.
  const lo = Math.min(...have) - 4;
  const span = Math.max(1, Math.max(...have) - lo);
  const today = dayKey(new Date());
  return (
    <>
      <Text style={styles.caption}>Resting, last 7 days</Text>
      <View style={styles.week}>
        {bars.map((b) => (
          <View key={b.day} style={styles.col}>
            {b.bpm !== null && <Text style={styles.barValue}>{b.bpm}</Text>}
            <View
              style={[
                styles.bar,
                { height: b.bpm === null ? 2 : Math.round(8 + (32 * (b.bpm - lo)) / span) },
                b.day === today && styles.barToday,
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.weekRow}>
        {bars.map((b) => (
          <Text key={b.day} style={[styles.weekDay, b.day === today && styles.weekToday]}>
            {b.day === today ? "Today" : WEEKDAY[new Date(`${b.day}T12:00:00`).getDay()]}
          </Text>
        ))}
      </View>
    </>
  );
}

type FigureItem = { label: string; value: string; note?: string };

/** A row of small numbers, each with its name over it: the day's low, average and high, a week's averages. */
export function Figures({ items }: { items: FigureItem[] }) {
  return (
    <View style={styles.figures}>
      {items.map((f) => (
        <View key={f.label} style={styles.figure}>
          <Text style={styles.figureLabel}>{f.label}</Text>
          <Text style={styles.figureValue} numberOfLines={1} adjustsFontSizeToFit>
            {f.value}
          </Text>
          {!!f.note && <Text style={styles.figureNote}>{f.note}</Text>}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  bpm: { ...type.display, color: colors.ink, ...numeric },
  staleText: { color: colors.inkMute },
  unit: { ...type.sub, color: colors.inkMute, letterSpacing: 0 },
  from: { ...type.meta, color: colors.inkDim },

  line: { height: 64, marginTop: space.s2 },
  axis: { flexDirection: "row", justifyContent: "space-between", paddingTop: space.s1 },
  axisText: { ...type.micro, ...mono, ...numeric, color: colors.inkMute, letterSpacing: 0 },

  figures: { flexDirection: "row", gap: space.s3, backgroundColor: colors.wash, borderRadius: radius.tile, padding: space.s4 },
  figure: { flex: 1, gap: 2 },
  figureLabel: { ...type.meta, color: colors.inkMute },
  figureValue: { ...type.head, color: colors.ink, ...numeric },
  figureNote: { ...type.micro, color: colors.inkMute, letterSpacing: 0 },

  foot: { ...type.meta, ...mono, color: colors.inkMute, ...numeric },

  caption: { ...type.meta, color: colors.inkMute, paddingTop: space.s3 },
  week: { flexDirection: "row", alignItems: "flex-end", gap: 10, height: 58 },
  col: { flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%", gap: 2 },
  barValue: { ...type.micro, ...numeric, color: colors.inkMute, letterSpacing: 0 },
  bar: { width: "60%", borderRadius: 3, backgroundColor: colors.wash2 },
  barToday: { backgroundColor: colors.now },
  weekRow: { flexDirection: "row", gap: 10 },
  weekDay: { flex: 1, textAlign: "center", ...type.micro, ...mono, color: colors.inkMute, letterSpacing: 0 },
  weekToday: { color: colors.now },
});
