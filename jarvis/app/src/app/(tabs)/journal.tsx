import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type AgentNote, type Commitment, type ContextDay, type ContextWeek } from "../../lib/api";
import { useAgent } from "../../lib/agent";
import { useSession } from "../../lib/auth";
import { colors } from "../../lib/theme";

// Two things that are both "what happened", from two directions: what OVOA went
// and found out, and what the day was actually made of. They share a screen
// because that is how they get read — you check what came in, then you look
// back at the day it came from.

type Tab = "notes" | "days";

const NOTE_ICON: Record<AgentNote["kind"], { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  brief: { icon: "sunny-outline", color: colors.accent },
  nudge: { icon: "alarm-outline", color: colors.warning },
  finding: { icon: "search-outline", color: colors.accent },
  done: { icon: "checkmark-circle-outline", color: colors.success },
  question: { icon: "help-circle-outline", color: colors.warning },
};

const today = () => new Date().toLocaleDateString("en-CA");

const short = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "Sep 14 – Sep 20", once the week has come back; its number until then. */
function weekLabel(week: ContextWeek | null) {
  if (!week) return "This week";
  return "days" in week && week.days ? `${short(week.from)} – ${short(week.to)}` : week.week;
}

export default function Journal() {
  const [tab, setTab] = useState<Tab>("notes");
  const { user } = useSession();

  return (
    <View style={styles.screen}>
      <View style={styles.segment}>
        {(
          [
            ["notes", `From ${user.settings.assistantName || "OVOA"}`],
            ["days", "Your days"],
          ] as const
        ).map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} style={[styles.segmentItem, tab === key && styles.segmentOn]}>
            <Text style={[styles.segmentText, tab === key && styles.segmentTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "notes" ? <Notes /> : <Days />}
    </View>
  );
}

// ---------- What OVOA has been doing ----------

function Notes() {
  const router = useRouter();
  const { user } = useSession();
  const { notes, unread, loading, refresh, markRead, dismiss, pushProblem } = useAgent();
  const name = user.settings.assistantName || "OVOA";

  // Opening the screen is reading them — but the notes may not have arrived
  // when it mounts, so this waits for a count rather than firing once on the
  // way in. markRead sets the count to zero, so it runs once and settles; a
  // note arriving while the screen is open is read as it lands, which is true.
  useEffect(() => {
    if (unread) markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  if (!user.settings.agentEnabled) {
    return (
      <Empty
        icon="moon-outline"
        title={`${name} isn't working in the background`}
        body={`Turn on Background work in Settings and ${name} will check things while you're away — what's actually on today, what you said you'd do — and tell you only when it's worth it.`}
        action={{ label: "Open Settings", onPress: () => router.push("/settings") }}
      />
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.accent} />}
    >
      {!!pushProblem && (
        <View style={[styles.card, styles.warnCard]}>
          <Text style={styles.warnText}>
            Notifications aren't set up, so these only appear here. {pushProblem}
          </Text>
        </View>
      )}

      {notes.length === 0 ? (
        <Empty
          icon="checkmark-done-outline"
          title="Nothing to report"
          body={`${name} checks on its own and stays quiet unless something's worth interrupting you for. An empty screen means nothing needed you.`}
        />
      ) : (
        notes.map((note) => <NoteCard key={note.id} note={note} onDismiss={() => dismiss(note.id)} />)
      )}

      <Pressable style={styles.linkRow} onPress={() => router.push("/agent")}>
        <Ionicons name="options-outline" size={16} color={colors.accent} />
        <Text style={styles.link}>What {name} is set up to do</Text>
      </Pressable>
    </ScrollView>
  );
}

function NoteCard({ note, onDismiss }: { note: AgentNote; onDismiss: () => void }) {
  const router = useRouter();
  const { icon, color } = NOTE_ICON[note.kind];
  const when = new Date(note.created_at);
  const stamp =
    when.toLocaleDateString("en-CA") === today()
      ? when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : when.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <View style={[styles.card, !note.read_at && styles.unreadCard]}>
      <View style={styles.noteHead}>
        <Ionicons name={icon} size={18} color={color} />
        <Text style={styles.noteTitle}>{note.title}</Text>
        <Text style={styles.stamp}>{stamp}</Text>
      </View>
      <Text style={styles.noteBody}>{note.body}</Text>
      <View style={styles.noteFoot}>
        {!!note.job && <Text style={styles.meta}>{note.job}</Text>}
        {!!note.action_id && (
          // The approval card itself lives on the assistant tab, with the rest
          // of them; this is the way there rather than a second place to tap
          // Approve.
          <Pressable onPress={() => router.push("/chat")} hitSlop={6}>
            <Text style={[styles.meta, { color: colors.warning }]}>Waiting for you to approve something →</Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }} />
        <Pressable onPress={onDismiss} hitSlop={10}>
          <Text style={styles.dismiss}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------- What the day was made of ----------

function Days() {
  const router = useRouter();
  const { token, user } = useSession();
  const [date, setDate] = useState(today());
  const [grain, setGrain] = useState<"day" | "week">("day");
  const [day, setDay] = useState<ContextDay | null>(null);
  const [week, setWeek] = useState<ContextWeek | null>(null);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const enabled = user.settings.contextEnabled;

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [shown, c] = await Promise.all([
        grain === "day" ? api.contextDay(token, date) : api.contextWeek(token, date),
        api.commitments(token),
      ]);
      if (grain === "day") setDay(shown as ContextDay);
      else setWeek(shown as ContextWeek);
      setCommitments(c.commitments ?? []);
    } catch {
      if (grain === "day") setDay(null);
      else setWeek(null);
    } finally {
      setLoading(false);
    }
  }, [token, date, grain, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  if (!enabled) {
    return (
      <Empty
        icon="book-outline"
        title="No timeline yet"
        body="Turn on Timeline in Settings and what you record gets summarised into a day you can ask about later — 'what did I do Tuesday', 'did I ever call Sarah back'. The words themselves are never stored on the server."
        action={{ label: "Open Settings", onPress: () => router.push("/settings") }}
      />
    );
  }

  const shift = (steps: number) => {
    const days = steps * (grain === "week" ? 7 : 1);
    setDate(new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toLocaleDateString("en-CA"));
  };

  const add = async () => {
    const text = note.trim();
    if (!text) return;
    setSaving(true);
    try {
      const now = Date.now();
      await api.addContextBlock(token, { startedAt: now, endedAt: now, source: "chat", note: text });
      setNote("");
      if (date === today()) await load();
      else Alert.alert("Added to today", "Jump to today to see it.");
    } catch (err) {
      Alert.alert("Couldn't add that", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const isToday = date === today();
  const label = new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.grainRow}>
        {(["day", "week"] as const).map((g) => (
          <Pressable key={g} onPress={() => setGrain(g)} hitSlop={6}>
            <Text style={[styles.grain, grain === g && styles.grainOn]}>{g === "day" ? "Day" : "Week"}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.dayNav}>
        <Pressable onPress={() => shift(-1)} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={colors.accent} />
        </Pressable>
        <Pressable onPress={() => setDate(today())}>
          <Text style={styles.dayLabel}>
            {grain === "week" ? weekLabel(week) : isToday ? "Today" : label}
          </Text>
        </Pressable>
        <Pressable onPress={() => shift(1)} hitSlop={12} disabled={isToday}>
          <Ionicons name="chevron-forward" size={22} color={isToday ? colors.border : colors.accent} />
        </Pressable>
      </View>

      {grain === "week" ? (
        week && "nothing" in week && week.nothing ? (
          <Empty icon="ellipse-outline" title="Nothing recorded" body={week.nothing} />
        ) : (
          week && (
            <>
              {!!week.title && (
                <View style={styles.card}>
                  <Text style={styles.dayTitle}>{week.title}</Text>
                  {!!week.summary && <Text style={styles.noteBody}>{week.summary}</Text>}
                </View>
              )}
              {week.days?.map((d) => (
                <Pressable
                  key={d.date}
                  style={styles.blockRow}
                  onPress={() => {
                    setDate(d.date);
                    setGrain("day");
                  }}
                >
                  <Text style={styles.blockTime}>{d.weekday.slice(0, 3)}</Text>
                  <View style={styles.blockBody}>
                    <Text style={styles.meta}>{d.happened.join(" · ")}</Text>
                  </View>
                </Pressable>
              ))}
            </>
          )
        )
      ) : day && "nothing" in day && day.nothing ? (
        <Empty icon="ellipse-outline" title="Nothing recorded" body={day.nothing} />
      ) : (
        day && (
          <>
            {!!day.title && (
              <View style={styles.card}>
                <Text style={styles.dayTitle}>{day.title}</Text>
                {!!day.summary && <Text style={styles.noteBody}>{day.summary}</Text>}
              </View>
            )}
            {day.blocks?.map((b, i) => (
              <View key={`${b.at}-${i}`} style={styles.blockRow}>
                <Text style={styles.blockTime}>{b.at}</Text>
                <View style={styles.blockBody}>
                  <Text style={styles.blockTitle}>{b.title}</Text>
                  <Text style={styles.meta}>{b.summary}</Text>
                </View>
              </View>
            ))}
          </>
        )
      )}

      {commitments.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={styles.sectionTitle}>STILL OWED</Text>
          {commitments.map((c, i) => (
            <View key={i} style={styles.card}>
              <Text style={styles.noteTitle}>{c.text}</Text>
              {!!c.theirWords && <Text style={styles.quote}>"{c.theirWords}"</Text>}
              <Text style={styles.meta}>
                {c.said}
                {c.who ? ` · ${c.who}` : ""}
                {c.when ? ` · ${c.when}` : ""}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.label}>Add something to the timeline</Text>
        <TextInput
          style={styles.input}
          value={note}
          onChangeText={setNote}
          placeholder="What just happened?"
          placeholderTextColor={colors.textDim}
          multiline
        />
        <Pressable onPress={add} disabled={!note.trim() || saving} style={({ pressed }) => [styles.button, (pressed || !note.trim() || saving) && { opacity: 0.5 }]}>
          <Text style={styles.buttonText}>{saving ? "Adding…" : "Add"}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={38} color={colors.textDim} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {action && (
        <Pressable onPress={action.onPress} style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}>
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}


const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  segment: {
    flexDirection: "row",
    backgroundColor: colors.surfaceHigh,
    borderRadius: 10,
    padding: 3,
    gap: 3,
    margin: 16,
    marginBottom: 0,
  },
  segmentItem: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  segmentOn: { backgroundColor: colors.surface },
  segmentText: { color: colors.textDim, fontSize: 14, fontWeight: "600" },
  segmentTextOn: { color: colors.text },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  unreadCard: { borderColor: colors.accentDim, backgroundColor: colors.surfaceHigh },
  warnCard: { borderColor: colors.warning },
  warnText: { color: colors.warning, fontSize: 13, lineHeight: 19 },
  noteHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  noteTitle: { color: colors.text, fontSize: 15, fontWeight: "600", flex: 1 },
  noteBody: { color: colors.text, fontSize: 14, lineHeight: 21 },
  noteFoot: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  stamp: { color: colors.textDim, fontSize: 12 },
  meta: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  quote: { color: colors.textDim, fontSize: 13, fontStyle: "italic" },
  dismiss: { color: colors.textDim, fontSize: 13 },
  grainRow: { flexDirection: "row", gap: 16, justifyContent: "center" },
  grain: { color: colors.textDim, fontSize: 13, fontWeight: "600" },
  grainOn: { color: colors.accent },
  dayNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 },
  dayLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
  dayTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  blockRow: { flexDirection: "row", gap: 12, paddingHorizontal: 4 },
  blockTime: { color: colors.textDim, fontSize: 12, width: 62, paddingTop: 2 },
  blockBody: { flex: 1, gap: 2 },
  blockTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: "600", letterSpacing: 1, marginLeft: 4, marginTop: 8 },
  label: { color: colors.text, fontSize: 15 },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 60,
    textAlignVertical: "top",
  },
  button: { backgroundColor: colors.surfaceHigh, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  empty: { alignItems: "center", gap: 10, padding: 24, paddingTop: 48 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "600", textAlign: "center" },
  emptyBody: { color: colors.textDim, fontSize: 14, lineHeight: 21, textAlign: "center" },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center", paddingVertical: 14 },
  link: { color: colors.accent, fontSize: 14, fontWeight: "600" },
});
