import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CountUp, PressScale, Ring, Rise, SkeletonList } from "../../components/motion";
import { PartOfPlan } from "../../components/Plan";
import { Btn, GroupLabel, Screen, TopBar, text, toneInk, toneWash } from "../../components/ui";
import { useSession } from "../../lib/auth";
import { devlog } from "../../lib/devlog";
import { foodApi, type FoodEntry, type FoodLevel, type FoodScreen } from "../../lib/food";
import { usePlan } from "../../lib/plan";
import { colors, numeric, radius, space, type } from "../../lib/theme";

// Calorie: what OVOA noted about food, from what was said in Talk
// (api/src/food.ts). The screen only reads it and fixes it; nothing here calls
// a model, so a downgrade never locks anyone out of their own log.
//
// Today is a ring of eaten against their goal (just the number when there's no
// goal), a protein bar, and what they had, each of which opens a sheet to fix
// the amount. Under that: the last 14 days, what they eat most, and their usual
// protein. The first time it opens it asks how closely they want OVOA to ask
// about food.
//
// Food is a place where an app can do harm by trying to help, so there's no red
// here, no streak, nothing that praises a lower number and nothing that marks
// going over: past the goal the ring is simply full. Every number is plain.

/** The add-on's own colour (lib/addons.ts: tone green). Never colors.stop. */
const ACCENT = toneInk("green");
const WASH = toneWash("green");

const LEVELS: Record<FoodLevel, string> = {
  quick: "A rough idea: OVOA never asks, it just notes what you had.",
  normal: "OVOA asks what's in things when it changes the number a lot.",
  strict: "As close as it can get: OVOA asks for the details first.",
};

const n = (v: number) => Math.round(v).toLocaleString();

export default function Calorie() {
  const { can } = usePlan();
  if (!can.chat) {
    return (
      <PartOfPlan
        title="Calorie"
        needs="base"
        what="Tell OVOA what you eat and it keeps count for you: calories and protein, today and over the last two weeks."
      />
    );
  }
  return <CalorieScreen />;
}

function CalorieScreen() {
  const { token } = useSession();
  const [data, setData] = useState<FoodScreen | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  // Sent at most once per visit: the screen is open, so Calorie is installed,
  // and a server that doesn't know yet (the install's own call failed) is told.
  const told = useRef(false);

  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      setState((s) => (s === "ok" ? s : "loading"));
      try {
        let r = await foodApi.screen(token);
        if (r.level === null && !told.current) {
          told.current = true;
          const s = await foodApi.set(token, { installed: true });
          r = { ...r, ...s };
        }
        if (!alive()) return;
        setData(r);
        setState("ok");
      } catch (err) {
        if (!alive()) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    },
    [token],
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load(() => !cancelled);
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  const choose = async (level: FoodLevel) => {
    setAsking(false);
    try {
      const s = await foodApi.set(token, { level });
      setData((d) => (d ? { ...d, ...s } : d));
    } catch (err) {
      Alert.alert("Couldn't save that", err instanceof Error ? err.message : String(err));
    }
  };

  const today = data?.today;
  const target = data?.target.kcal ?? null;
  const proteinBase = data?.target.protein ?? data?.proteinAvg ?? null;
  const showQuestion = !!data && (asking || (data.level !== null && !data.chosen));

  return (
    <View style={styles.page}>
      <TopBar title="Calorie" />
      <Screen refreshControl={<RefreshControl refreshing={state === "loading" && !!data} onRefresh={() => void load()} tintColor={ACCENT} />}>
        {state === "loading" && !data && <SkeletonList rows={5} />}

        {state === "error" && !data && (
          <>
            <Text style={text.sub}>{error}</Text>
            <Btn label="Try again" onPress={() => void load()} style={{ alignSelf: "flex-start" }} />
          </>
        )}

        {showQuestion && (
          <Rise>
            <View style={styles.ask}>
              <Text style={styles.askTitle}>Do you want a rough idea, or should I ask what's in things?</Text>
              <View style={styles.askButtons}>
                <Btn label="A rough idea" onPress={() => void choose("quick")} style={styles.askButton} />
                <Btn label="Ask what's in things" onPress={() => void choose("normal")} style={styles.askButton} />
              </View>
              <Text style={styles.askMeta}>You can change it here any time, or say "be more exact" for the closest numbers.</Text>
              {asking && <Btn label="Keep it as it is" kind="quiet" onPress={() => setAsking(false)} style={{ alignSelf: "flex-start" }} />}
            </View>
          </Rise>
        )}

        {!!data && !!today && (
          <>
            <Rise index={1}>
              <View style={styles.today}>
                {/* Against the goal when there is one; otherwise the ring is only a frame for the number. */}
                <Ring progress={target ? today.kcal / target : 0} size={196} stroke={14} color={ACCENT}>
                  <CountUp value={today.kcal} format={n} style={styles.eaten} />
                  <Text style={styles.eatenLabel}>{target ? `of ${n(target)} kcal` : "kcal today"}</Text>
                </Ring>
                {!!target && today.kcal < target && <Text style={styles.left}>{n(target - today.kcal)} left</Text>}
              </View>
            </Rise>

            <Rise index={2}>
              <View style={styles.protein}>
                <View style={styles.proteinTop}>
                  <Text style={styles.proteinName}>Protein</Text>
                  <Text style={styles.proteinValue}>
                    {n(today.protein)} g
                    {data.target.protein ? (
                      <Text style={styles.proteinOf}> of {n(data.target.protein)} g</Text>
                    ) : data.proteinAvg ? (
                      <Text style={styles.proteinOf}> · usually {n(data.proteinAvg)} g</Text>
                    ) : null}
                  </Text>
                </View>
                <Bar progress={proteinBase ? today.protein / proteinBase : 0} />
              </View>
            </Rise>

            <GroupLabel>Today</GroupLabel>
            {today.entries.length === 0 ? (
              <Text style={text.sub}>
                Nothing yet. Tell OVOA what you have, like "I had a chicken burrito", and it shows up here.
              </Text>
            ) : (
              today.entries.map((e, i) => <EntryRow key={e.id} entry={e} index={i} first={i === 0} onPress={() => setEditing(e)} />)
            )}

            {data.days.some((d) => d.day !== today.day) && (
              <>
                <GroupLabel>Last 14 days</GroupLabel>
                <DayList days={data.days.filter((d) => d.day !== today.day)} today={today.day} />
              </>
            )}

            {(data.top.length > 0 || data.proteinAvg !== null) && <GroupLabel>What you usually have</GroupLabel>}
            {data.proteinAvg !== null && (
              <View style={[styles.line, styles.lineFirst]}>
                <Text style={styles.lineName}>Protein, on an average day</Text>
                <Text style={styles.lineValue}>{n(data.proteinAvg)} g</Text>
              </View>
            )}
            {data.top.map((f, i) => (
              <View key={f.name} style={[styles.line, i === 0 && data.proteinAvg === null && styles.lineFirst]}>
                <Text style={styles.lineName} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={styles.lineValue}>{f.times} times</Text>
              </View>
            ))}

            <GroupLabel>How OVOA asks</GroupLabel>
            <View style={styles.levelRow}>
              <Text style={[text.sub, { flex: 1 }]}>{data.level ? LEVELS[data.level] : "OVOA notes what you have quietly."}</Text>
              {!showQuestion && <Btn label="Change" kind="quiet" onPress={() => setAsking(true)} />}
            </View>
            <Text style={styles.foot}>
              {target ? "" : 'Want a daily goal? Tell OVOA, like "keep me to 2,000 a day". '}
              These are OVOA's estimates from what you told it, not measurements, and they're kept for 14 days.
            </Text>
          </>
        )}
      </Screen>

      <AmendSheet
        entry={editing}
        onClose={() => setEditing(null)}
        onSave={async (change) => {
          const e = editing;
          setEditing(null);
          if (!e) return;
          try {
            if (change === "remove") await foodApi.remove(token, e.id);
            else await foodApi.amend(token, e.id, change);
            await load();
          } catch (err) {
            devlog("err", "calorie: couldn't fix an entry", String(err));
            Alert.alert("Couldn't change that", err instanceof Error ? err.message : String(err));
          }
        }}
      />
    </View>
  );
}

/** A bar that fills to `progress` (0 to 1) the way the Ring sweeps. Full past 1, and never another colour. */
function Bar({ progress }: { progress: number }) {
  const reduce = useReducedMotion();
  const to = Math.max(0, Math.min(1, progress));
  const shown = useSharedValue(reduce ? to : 0);
  useEffect(() => {
    shown.value = reduce ? to : withDelay(200, withTiming(to, { duration: 1200, easing: Easing.bezier(0.32, 0.72, 0, 1) }));
  }, [to, reduce, shown]);
  const fill = useAnimatedStyle(() => ({ width: `${shown.value * 100}%` }));
  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, fill]} />
    </View>
  );
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function EntryRow({ entry, index, first, onPress }: { entry: FoodEntry; index: number; first: boolean; onPress: () => void }) {
  return (
    <Rise index={index + 3}>
      <PressScale
        sink={0.98}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${entry.name}, ${n(entry.kcal)} calories`}
        accessibilityHint="Change the amount or remove it"
        style={[styles.entry, first && styles.lineFirst]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.entryName} numberOfLines={2}>
            {entry.name}
          </Text>
          <Text style={styles.entryMeta}>
            {clock(entry.ts)}
            {entry.grams !== null && ` · ${n(entry.grams)} g`}
            {entry.protein ? ` · ${n(entry.protein)} g protein` : ""}
          </Text>
        </View>
        <Text style={styles.entryKcal}>{n(entry.kcal)}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.inkMute} />
      </PressScale>
    </Rise>
  );
}

/** "Yesterday", "Mon 21 Sep". `day` is a local YYYY-MM-DD; read at noon UTC so no zone moves it. */
function dayLabel(day: string, today: string) {
  const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
  if (Math.round((at(today) - at(day)) / 86_400_000) === 1) return "Yesterday";
  return new Date(at(day)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function DayList({ days, today }: { days: FoodScreen["days"]; today: string }) {
  // Each day's bar is against the biggest day shown: a shape of the fortnight, not a score.
  const most = Math.max(1, ...days.map((d) => d.kcal));
  return (
    <>
      {days.map((d, i) => (
        <View key={d.day} style={[styles.day, i === 0 && styles.lineFirst]}>
          <View style={styles.dayTop}>
            <Text style={styles.lineName}>{dayLabel(d.day, today)}</Text>
            <Text style={styles.lineValue}>
              {n(d.kcal)} kcal{d.protein ? ` · ${n(d.protein)} g protein` : ""}
            </Text>
          </View>
          <View style={styles.dayTrack}>
            <View style={[styles.dayFill, { width: `${(d.kcal / most) * 100}%` }]} />
          </View>
        </View>
      ))}
    </>
  );
}

type Change = { grams: number } | { fraction: number } | "remove";

/**
 * The one place touching beats talking: "make it 140 grams" is fiddly to say.
 * A weight when OVOA noted one, otherwise the portion, in steps; the calories
 * follow it on the server.
 */
function AmendSheet({ entry, onClose, onSave }: { entry: FoodEntry | null; onClose: () => void; onSave: (c: Change) => void }) {
  const insets = useSafeAreaInsets();
  const [grams, setGrams] = useState(0);
  const [portion, setPortion] = useState(1);
  useEffect(() => {
    if (!entry) return;
    setGrams(entry.grams ?? 0);
    setPortion(1);
  }, [entry]);
  if (!entry) return null;

  const byWeight = entry.grams !== null && entry.grams > 0;
  const step = byWeight ? (grams >= 200 ? 25 : 10) : 0.25;
  const share = byWeight ? grams / entry.grams! : portion;
  const kcal = entry.kcal * share;
  const changed = byWeight ? grams !== entry.grams : portion !== 1;
  const down = () => (byWeight ? setGrams((g) => Math.max(step, g - step)) : setPortion((p) => Math.max(0.25, p - step)));
  const up = () => (byWeight ? setGrams((g) => Math.min(3000, g + step)) : setPortion((p) => Math.min(10, p + step)));

  const remove = () =>
    Alert.alert(`Remove ${entry.name}?`, "It comes off today's list.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => onSave("remove") },
    ]);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.s5 }]}>
        <View style={styles.grip} />
        <Text style={styles.sheetTitle}>{entry.name}</Text>
        <Text style={styles.entryMeta}>
          {clock(entry.ts)} · {n(kcal)} kcal
        </Text>

        <View style={styles.stepper}>
          <PressScale sink={0.9} onPress={down} style={styles.stepButton} accessibilityRole="button" accessibilityLabel="Less">
            <Ionicons name="remove" size={24} color={colors.ink} />
          </PressScale>
          <View style={styles.stepValue}>
            <Text style={styles.stepNumber}>{byWeight ? n(grams) : portion.toLocaleString(undefined, { maximumFractionDigits: 2 })}</Text>
            <Text style={styles.stepUnit}>{byWeight ? "grams" : portion === 1 ? "portion" : "portions"}</Text>
          </View>
          <PressScale sink={0.9} onPress={up} style={styles.stepButton} accessibilityRole="button" accessibilityLabel="More">
            <Ionicons name="add" size={24} color={colors.ink} />
          </PressScale>
        </View>

        <View style={styles.sheetButtons}>
          <Btn label="Remove" kind="quiet" onPress={remove} />
          <View style={{ flex: 1 }} />
          <Btn label="Cancel" onPress={onClose} />
          <Btn
            label="Save"
            kind="go"
            disabled={!changed}
            onPress={() => onSave(byWeight ? { grams } : { fraction: portion })}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },

  ask: { backgroundColor: WASH, borderRadius: radius.tile, padding: space.s4, gap: space.s3 },
  askTitle: { ...type.head, color: colors.ink },
  askButtons: { flexDirection: "row", flexWrap: "wrap", gap: space.s2 },
  askButton: { backgroundColor: colors.paper, flexGrow: 1 },
  askMeta: { ...type.meta, color: colors.inkDim },

  today: { alignItems: "center", gap: space.s2, paddingVertical: space.s3 },
  eaten: { ...type.display, color: colors.ink, ...numeric },
  eatenLabel: { ...type.meta, color: colors.inkMute },
  left: { ...type.sub, color: colors.inkDim, ...numeric },

  protein: { gap: space.s2, paddingTop: space.s2 },
  proteinTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  proteinName: { ...type.head, color: colors.ink },
  proteinValue: { ...type.body, color: colors.ink, ...numeric },
  proteinOf: { ...type.sub, color: colors.inkMute },
  track: { height: 10, borderRadius: 5, backgroundColor: colors.wash2, overflow: "hidden" },
  fill: { height: 10, borderRadius: 5, backgroundColor: ACCENT },

  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  entryName: { ...type.body, color: colors.ink },
  entryMeta: { ...type.meta, color: colors.inkMute, ...numeric },
  entryKcal: { ...type.body, color: colors.ink, ...numeric },

  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s3,
    paddingVertical: space.s3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  lineFirst: { borderTopWidth: 0 },
  lineName: { ...type.body, color: colors.ink, flex: 1 },
  lineValue: { ...type.meta, color: colors.inkMute, ...numeric },

  day: { gap: space.s2, paddingVertical: space.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  dayTop: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  dayTrack: { height: 6, borderRadius: 3, backgroundColor: colors.wash, overflow: "hidden" },
  dayFill: { height: 6, borderRadius: 3, backgroundColor: ACCENT, opacity: 0.45 },

  levelRow: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  foot: { ...type.meta, color: colors.inkMute, paddingTop: space.s4 },

  scrim: { flex: 1, backgroundColor: "rgba(12,14,18,0.3)" },
  sheet: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: space.s5,
    paddingTop: space.s3,
    gap: space.s2,
  },
  grip: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.wash2, marginBottom: space.s2 },
  sheetTitle: { ...type.title, color: colors.ink },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s6, paddingVertical: space.s5 },
  stepButton: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.wash, alignItems: "center", justifyContent: "center" },
  stepValue: { alignItems: "center", minWidth: 110 },
  stepNumber: { ...type.display, color: colors.ink, ...numeric },
  stepUnit: { ...type.meta, color: colors.inkMute },
  sheetButtons: { flexDirection: "row", alignItems: "center", gap: space.s2 },
});
