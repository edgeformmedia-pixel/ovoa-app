import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { api, type Note } from "../lib/api";
import { useSession } from "../lib/auth";
import { NO_ON_DEVICE, noteRecording } from "../lib/capture";
import { devlog } from "../lib/devlog";
import { usePlan } from "../lib/plan";
import { useRecordings } from "../lib/recordings";
import { colors, space, type } from "../lib/theme";
import { HealthCards } from "./HealthCards";
import { AssistantPlanCard } from "./Plan";
import { Answer, Spine, type Moment } from "./Spine";
import { Steps } from "./Steps";
import { Btn, GroupLabel, Screen, TopBar, text } from "./ui";

// The free plan's first screen: one day, one spine. What you noted, in the
// order you noted it, then your health under it. Nothing here calls a model:
// notes are text (typed, or written out on the phone from a Band recording,
// capture.ts noteRecording), and health is read on the phone.
//
// The assistant gets one quiet card at the bottom, and nowhere else.

const today = () => new Date().toLocaleDateString("en-CA");
const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-CA");
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

export function FreeToday() {
  const { token } = useSession();
  const { refresh: refreshPlan } = usePlan();
  const recordings = useRecordings();
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const isToday = date === today();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNotes((await api.notes(token)).notes);
    } catch (err) {
      // Offline: what was on screen stays on screen.
      devlog("warn", "free home: couldn't load notes", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // A Band recording that just became a note: show it.
  const noted = recordings.filter((r) => r.noteId).length;
  useEffect(() => {
    if (noted) void load();
  }, [noted, load]);

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    setProblem(null);
    try {
      await api.addNote(token, { text: body, source: "typed" });
      setDraft("");
      setDate(today());
      await load();
    } catch {
      setProblem("That didn't save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const moments: Moment[] = notes
    .filter((n) => dayOf(n.ts) === date)
    .map((n) => {
      const [first, ...rest] = n.text.split("\n");
      return {
        id: `note:${n.id}`,
        at: clock(n.ts),
        sortAt: n.ts,
        title: first,
        detail: rest.join(" ").trim() || undefined,
        state: "done",
      };
    });

  // Band recordings still being written out, or that this phone couldn't write out.
  for (const r of recordings) {
    if (r.noteId || r.blockId || r.lost || dayOf(r.createdAt) !== date) continue;
    if (r.capturing) {
      moments.push({ id: `rec:${r.id}`, at: clock(r.createdAt), sortAt: r.createdAt, title: "Writing out your recording…", state: "next" });
    } else if (r.captureError === NO_ON_DEVICE) {
      moments.push({
        id: `rec:${r.id}`,
        at: clock(r.createdAt),
        sortAt: r.createdAt,
        title: "Couldn't transcribe on this phone",
        detail: "The recording is kept in Record.",
        state: "missed",
        answer: (
          <Answer>
            <Btn label="Try again" onPress={() => void noteRecording(token, r)} />
          </Answer>
        ),
      });
    }
  }

  const label = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const shift = (by: number) => setDate(new Date(Date.parse(`${date}T12:00:00`) + by * 86_400_000).toLocaleDateString("en-CA"));

  return (
    <View style={styles.page}>
      <TopBar title="Today" when={isToday ? label : undefined} />
      <Screen
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => {
              void load();
              // "Already a member? Pull down to refresh."
              void refreshPlan({ fromSite: true });
            }}
            tintColor={colors.now}
          />
        }
      >
        <View style={styles.nav}>
          <Pressable onPress={() => shift(-1)} hitSlop={12} accessibilityLabel="The day before">
            <Ionicons name="chevron-back" size={20} color={colors.inkDim} />
          </Pressable>
          <Pressable onPress={() => setDate(today())}>
            <Text style={text.head}>{isToday ? "Today" : label}</Text>
          </Pressable>
          <Pressable onPress={() => shift(1)} hitSlop={12} disabled={isToday} accessibilityLabel="The day after">
            <Ionicons name="chevron-forward" size={20} color={isToday ? colors.line : colors.inkDim} />
          </Pressable>
        </View>

        {moments.length > 0 ? (
          <Spine moments={moments} now={isToday ? Date.now() : Date.parse(`${date}T23:59:59`)} />
        ) : (
          <View style={styles.empty}>
            <Text style={text.sub}>{isToday ? "No notes yet today." : "No notes that day."}</Text>
            {isToday && <Text style={text.meta}>Write one below, or double-press your Band's button to record one.</Text>}
          </View>
        )}

        <GroupLabel>Write a note</GroupLabel>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="What do you want to remember?"
          placeholderTextColor={colors.inkMute}
          multiline
        />
        {!!problem && <Text style={[text.meta, { color: colors.late }]}>{problem}</Text>}
        <Btn label={saving ? "Saving…" : "Save"} onPress={save} disabled={!draft.trim() || saving} style={{ alignSelf: "flex-start" }} />

        <GroupLabel>Health</GroupLabel>
        <Steps />
        <HealthCards />

        <AssistantPlanCard />
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: space.s2 },
  empty: { gap: space.s1, paddingVertical: space.s3 },
  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
    minHeight: 64,
    textAlignVertical: "top",
  },
});
