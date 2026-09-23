import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { FreeToday } from "../../components/FreeToday";
import { Answer, Settled, Spine, type Moment, type MomentState } from "../../components/Spine";
import { Btn, Empty, GroupLabel, Screen, TopBar, text } from "../../components/ui";
import { api, type Commitment, type ContextDay, type FeedCard } from "../../lib/api";
import { useAgent } from "../../lib/agent";
import { useSession } from "../../lib/auth";
import { usePlan } from "../../lib/plan";
import { logFail } from "../../lib/devlog";
import { colors, space, type } from "../../lib/theme";

// The day, as one spine. Everything that is a moment goes on it in the order
// it happened or will happen: what repeats, what OVOA said on its own, and what
// the day was actually made of. The things that are not moments — a list, what
// you still owe, the box for adding something — sit under it.
//
// This replaces both halves of the old Journal and the card stack that used to
// sit on top of Activity. They were three different shapes for the same
// question, and the point of the spine is that there is one.

const today = () => new Date().toLocaleDateString("en-CA");

/** A routine's status, as the server words it, to how the spine draws it. */
function routineState(status: string, dueAt: number, now: number): MomentState {
  if (status === "done") return "kept";
  if (status === "missed") return "missed";
  if (status === "skipped") return "done";
  return dueAt <= now ? "now" : "next";
}

/** "09:15" on a given day, back to a moment in time, for ordering. */
function clockToEpoch(at: string, date: string) {
  const m = /^(\d{1,2}):(\d{2})/.exec(at.trim());
  const base = Date.parse(`${date}T12:00:00`);
  if (!m) return base;
  const d = new Date(base);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

export default function Day() {
  // The free plan's day is its home: notes and health, no assistant.
  const { free } = usePlan();
  return free ? <FreeToday /> : <PlanDay />;
}

function PlanDay() {
  const router = useRouter();
  const { token, user } = useSession();
  const { notes, unread, markRead, pushProblem } = useAgent();
  const [date, setDate] = useState(today());
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [day, setDay] = useState<ContextDay | null>(null);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [settledFavors, setSettledFavors] = useState<Record<string, string>>({});

  const isToday = date === today();
  const name = user.settings.assistantName || "OVOA";

  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      setLoading(true);
      try {
        // The feed is only ever about today; a past day is whatever was recorded.
        const [feed, context, owed] = await Promise.all([
          isToday ? api.feed(token).catch(() => ({ cards: [] as FeedCard[] })) : Promise.resolve({ cards: [] as FeedCard[] }),
          user.settings.contextEnabled ? api.contextDay(token, date).catch(() => null) : Promise.resolve(null),
          api.commitments(token).catch(() => ({ commitments: [] as Commitment[] })),
        ]);
        if (!alive()) return;
        setCards(feed.cards);
        setDay(context);
        setCommitments(owed.commitments ?? []);
      } finally {
        if (alive()) setLoading(false);
      }
    },
    [token, date, isToday, user.settings.contextEnabled],
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

  // Opening the screen is reading what OVOA said. It waits for a count rather
  // than firing once on mount, because the notes may not have arrived yet.
  useEffect(() => {
    if (unread) markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  const tickTodo = async (id: string) => {
    setCards((all) =>
      all.map((c) => (c.kind === "todos" ? { ...c, items: c.items.map((i) => (i.id === id ? { ...i, done: true } : i)) } : c)),
    );
    await api.todoDone(token, id).catch(logFail("day: api.todoDone"));
    void load();
  };

  const confirmRoutine = async (id: string, dueAt: number) => {
    await api.confirmRoutine(token, id, { dueAt, via: "app" }).catch(logFail("day: api.confirmRoutine"));
    void load();
  };

  const settleFavor = async (id: string, how: "keep" | "done" | "drop") => {
    setSettledFavors((s) => ({ ...s, [id]: how === "drop" ? "Dropped" : how === "keep" ? "Kept" : "Done" }));
    if (how === "keep") await api.confirmFavor(token, id).catch(logFail("day: api.confirmFavor"));
    else await api.setCommitment(token, id, how === "done" ? "done" : "dropped").catch(logFail("day: api.setCommitment"));
    void load();
  };

  const add = async () => {
    const body = note.trim();
    if (!body) return;
    setSaving(true);
    try {
      const at = Date.now();
      await api.addContextBlock(token, { startedAt: at, endedAt: at, source: "chat", note: body });
      setNote("");
      if (isToday) await load();
      else Alert.alert("Added to today", "Jump to today to see it.");
    } catch (err) {
      Alert.alert("Couldn't add that", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ---------- the spine ----------

  const now = Date.now();
  const moments: Moment[] = [];

  for (const card of cards) {
    if (card.kind === "routines") {
      for (const item of card.items) {
        const state = routineState(item.status, item.dueAt, now);
        moments.push({
          id: `routine:${item.id}:${item.dueAt}`,
          at: item.at,
          sortAt: item.dueAt,
          title: item.title,
          state,
          // Due now is the one moment on the screen that asks something of you.
          answer:
            state === "now" ? (
              // No eyebrow: the NOW marker is directly above it.
              <Answer>
                <Btn label="Done" kind="go" onPress={() => confirmRoutine(item.id, item.dueAt)} />
              </Answer>
            ) : undefined,
          onDone: state === "next" ? () => confirmRoutine(item.id, item.dueAt) : undefined,
        });
      }
    }
    if (card.kind === "favor") {
      const done = settledFavors[card.commitmentId];
      moments.push({
        id: `favor:${card.commitmentId}`,
        at: "",
        sortAt: now - 1,
        title: "",
        state: "agent",
        answer: done ? (
          <Settled>{done}</Settled>
        ) : (
          <Answer eyebrow={card.unsure ? "Did they ask?" : "Asked of you"} said={card.body} who={card.title}>
            <Btn
              label={card.unsure ? "Keep it" : "Done"}
              onPress={() => settleFavor(card.commitmentId, card.unsure ? "keep" : "done")}
            />
            <Btn label={card.unsure ? "No" : "Not needed"} kind="quiet" onPress={() => settleFavor(card.commitmentId, "drop")} />
          </Answer>
        ),
      });
    }
  }

  // What OVOA said on its own, today. Read ones go quiet rather than away.
  if (isToday) {
    for (const n of notes) {
      if (new Date(n.created_at).toLocaleDateString("en-CA") !== date) continue;
      moments.push({
        id: `note:${n.id}`,
        at: new Date(n.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }),
        sortAt: n.created_at,
        title: n.title,
        detail: n.body,
        state: n.read_at ? "agentQuiet" : "agent",
        answer: n.action_id ? (
          <Answer eyebrow="Waiting on you">
            <Btn label="Open it" kind="go" onPress={() => router.navigate("/chat")} />
          </Answer>
        ) : undefined,
      });
    }
  }

  // What the day was actually made of.
  for (const block of day?.blocks ?? []) {
    moments.push({
      id: `block:${block.at}:${block.title}`,
      at: block.at,
      sortAt: clockToEpoch(block.at, date),
      title: block.title,
      detail: block.summary,
      state: "done",
    });
  }

  const todos = cards.find((c) => c.kind === "todos");
  const summary = day?.summary ?? cards.find((c) => c.kind === "summary")?.body;
  const label = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const shift = (by: number) =>
    setDate(new Date(Date.parse(`${date}T12:00:00`) + by * 86_400_000).toLocaleDateString("en-CA"));

  return (
    <View style={styles.page}>
      <TopBar title="Day" when={isToday ? "Today" : label} />
      <Screen
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.now} />}
      >
        <View style={styles.nav}>
          <Pressable onPress={() => shift(-1)} hitSlop={12}>
            <Ionicons name="chevron-back" size={20} color={colors.inkDim} />
          </Pressable>
          <Pressable onPress={() => setDate(today())}>
            <Text style={text.head}>{isToday ? "Today" : label}</Text>
          </Pressable>
          <Pressable onPress={() => shift(1)} hitSlop={12} disabled={isToday}>
            <Ionicons name="chevron-forward" size={20} color={isToday ? colors.line : colors.inkDim} />
          </Pressable>
        </View>

        {!!pushProblem && <Text style={styles.warn}>Notifications aren't set up, so these only appear here. {pushProblem}</Text>}
        {!!summary && <Text style={styles.summary}>{summary}</Text>}

        {moments.length > 0 ? (
          <Spine moments={moments} now={now} />
        ) : (
          <Empty
            icon="ellipse-outline"
            title={isToday ? "Nothing on today" : "Nothing recorded"}
            body={
              user.settings.contextEnabled
                ? `${name} stays quiet unless something is worth interrupting you for. An empty day means nothing needed you.`
                : "Turn on Timeline in Settings and what you record gets summarised into a day you can ask about later. The words themselves are never stored on the server."
            }
            action={
              user.settings.contextEnabled ? undefined : { label: "Open Settings", onPress: () => router.navigate("/settings") }
            }
          />
        )}

        {!!todos && todos.kind === "todos" && todos.items.length > 0 && (
          <>
            <GroupLabel>{todos.title}</GroupLabel>
            {todos.items.map((item) => (
              <Pressable
                key={item.id}
                style={styles.todo}
                onPress={() => !item.done && tickTodo(item.id)}
                disabled={item.done}
              >
                <Ionicons
                  name={item.done ? "checkmark-circle" : "ellipse-outline"}
                  size={20}
                  color={item.done ? colors.done : colors.inkMute}
                />
                <Text style={[text.body, { flex: 1 }, item.done && styles.struck]}>{item.text}</Text>
              </Pressable>
            ))}
          </>
        )}

        {commitments.length > 0 && (
          <>
            <GroupLabel>Still owed</GroupLabel>
            {commitments.map((c, i) => (
              <View key={i} style={styles.owed}>
                <Text style={text.body}>{c.text}</Text>
                {!!c.theirWords && <Text style={styles.quote}>“{c.theirWords}”</Text>}
                <Text style={text.meta}>{[c.said, c.who, c.when].filter(Boolean).join(" · ")}</Text>
              </View>
            ))}
          </>
        )}

        {user.settings.contextEnabled && (
          <>
            <GroupLabel>Add to the timeline</GroupLabel>
            <TextInput
              style={styles.input}
              value={note}
              onChangeText={setNote}
              placeholder="What just happened?"
              placeholderTextColor={colors.inkMute}
              multiline
            />
            <Btn
              label={saving ? "Adding…" : "Add"}
              onPress={add}
              disabled={!note.trim() || saving}
              style={{ alignSelf: "flex-start" }}
            />
          </>
        )}
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: space.s2 },
  summary: { ...type.sub, color: colors.inkDim, paddingBottom: space.s3 },
  warn: { ...type.meta, color: colors.late },
  todo: { flexDirection: "row", alignItems: "center", gap: space.s3, paddingVertical: space.s2 },
  struck: { color: colors.inkMute, textDecorationLine: "line-through" },
  owed: { paddingVertical: space.s2, gap: 2 },
  quote: { ...type.sub, color: colors.inkMute, fontStyle: "italic" },
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
