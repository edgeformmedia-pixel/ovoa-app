import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api, type LineSource, type TranscriptBlock, type TranscriptDay, type TranscriptLine } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog, logFail } from "../lib/devlog";
import { colors } from "../lib/theme";

// Everything said, by day: the day's title, then each hour with its title, then
// each five minutes with its title, then the words themselves. Search reaches
// across all fourteen days kept (server: api/src/transcripts.ts).

const BLOCK_MS = 5 * 60_000;

const SOURCE: Record<LineSource, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  mic: { label: "You", color: colors.now, icon: "mic" },
  assistant: { label: "OVOA", color: colors.done, icon: "sparkles" },
  recording: { label: "Recording", color: colors.late, icon: "radio-button-on" },
  background: { label: "Background", color: colors.inkMute, icon: "ear-outline" },
};

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function Transcripts() {
  const { token } = useSession();
  const [date, setDate] = useState(() => new Date());
  const [day, setDay] = useState<TranscriptDay | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openHours, setOpenHours] = useState<Set<string>>(new Set());
  const [openBlock, setOpenBlock] = useState<number | null>(null);
  const [lines, setLines] = useState<Record<number, TranscriptLine[]>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TranscriptLine[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.transcriptDay(token, dayKey(date));
      setDay(d);
      // The latest hour starts open: that's usually what someone is looking for.
      setOpenHours(new Set(d.hours.length ? [d.hours[d.hours.length - 1].hour] : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, date]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const shift = (days: number) => {
    const next = new Date(date);
    next.setDate(date.getDate() + days);
    if (next.getTime() > Date.now()) return;
    setDate(next);
    setOpenBlock(null);
  };

  const toggleBlock = async (b: TranscriptBlock) => {
    if (openBlock === b.start) return setOpenBlock(null);
    setOpenBlock(b.start);
    if (!lines[b.start]) {
      try {
        const r = await api.transcriptLines(token, b.start, b.start + BLOCK_MS);
        setLines((all) => ({ ...all, [b.start]: r.lines }));
      } catch (err) {
        devlog("err", "couldn't load transcript lines", String(err));
      }
    }
  };

  const forget = (b: TranscriptBlock) =>
    Alert.alert("Forget these five minutes?", "The words and their title are deleted for good.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: async () => {
          await api.forgetTranscript(token, b.start, b.start + BLOCK_MS).catch(logFail("transcripts: api.forgetTranscript"));
          setOpenBlock(null);
          void load();
        },
      },
    ]);

  const search = async () => {
    const q = query.trim();
    if (!q) return setResults(null);
    try {
      setResults((await api.searchTranscripts(token, q)).lines);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const isToday = dayKey(date) === dayKey(new Date());

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.inkMute} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            if (!t.trim()) setResults(null);
          }}
          onSubmitEditing={search}
          placeholder="Search everything said"
          placeholderTextColor={colors.inkMute}
          returnKeyType="search"
        />
      </View>

      {results ? (
        <View style={styles.card}>
          <Text style={styles.label}>{results.length ? `${results.length} MATCHES` : "NOTHING FOUND"}</Text>
          {results.map((l) => (
            <Line key={l.id} line={l} showDate />
          ))}
        </View>
      ) : (
        <>
          <View style={styles.dateRow}>
            <Pressable onPress={() => shift(-1)} hitSlop={12}>
              <Ionicons name="chevron-back" size={22} color={colors.ink} />
            </Pressable>
            <Text style={styles.date}>
              {isToday ? "Today" : date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
            </Text>
            <Pressable onPress={() => shift(1)} hitSlop={12} disabled={isToday}>
              <Ionicons name="chevron-forward" size={22} color={isToday ? colors.line : colors.ink} />
            </Pressable>
          </View>

          {loading && <ActivityIndicator color={colors.now} />}
          {error && <Text style={styles.error}>{error}</Text>}

          {day && (day.title || day.summary) && (
            <View style={styles.card}>
              <Text style={styles.label}>THE DAY</Text>
              {day.title && <Text style={styles.title}>{day.title}</Text>}
              {day.summary && <Text style={styles.body}>{day.summary}</Text>}
            </View>
          )}

          {day && !day.hours.length && !loading && (
            <Text style={styles.dim}>
              Nothing recorded {isToday ? "yet today" : "that day"}. What you say to OVOA shows up here; with Capture
              everything on (Dev tools), what's said around you does too.
            </Text>
          )}

          {day?.hours
            .slice()
            .reverse()
            .map((h) => {
              const open = openHours.has(h.hour);
              return (
                <View key={h.hour} style={styles.card}>
                  <Pressable
                    style={styles.hourHead}
                    onPress={() =>
                      setOpenHours((s) => {
                        const next = new Set(s);
                        if (open) next.delete(h.hour);
                        else next.add(h.hour);
                        return next;
                      })
                    }
                  >
                    <Text style={styles.hourLabel}>{h.label}</Text>
                    <Text style={[styles.body, { flex: 1 }]} numberOfLines={open ? undefined : 1}>
                      {h.title ?? "Not titled yet"}
                    </Text>
                    <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.inkMute} />
                  </Pressable>
                  {open && h.summary && <Text style={styles.dim}>{h.summary}</Text>}
                  {open &&
                    h.blocks.map((b) => (
                      <View key={b.start} style={styles.block}>
                        <Pressable style={styles.blockHead} onPress={() => toggleBlock(b)} onLongPress={() => forget(b)}>
                          <Text style={styles.blockTime}>{b.at}</Text>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text style={styles.body}>{b.title ?? "Titling…"}</Text>
                            <View style={styles.badges}>
                              {b.sources.map((s) => (
                                <View key={s} style={[styles.badge, { borderColor: SOURCE[s]?.color ?? colors.line }]}>
                                  <Text style={[styles.badgeText, { color: SOURCE[s]?.color ?? colors.inkMute }]}>
                                    {SOURCE[s]?.label ?? s}
                                  </Text>
                                </View>
                              ))}
                              <Text style={styles.dim}>
                                {b.lines} line{b.lines === 1 ? "" : "s"}
                              </Text>
                            </View>
                          </View>
                        </Pressable>
                        {openBlock === b.start && (
                          <View style={styles.lines}>
                            {b.summary && <Text style={[styles.dim, { marginBottom: 4 }]}>{b.summary}</Text>}
                            {(lines[b.start] ?? []).map((l) => (
                              <Line key={l.id} line={l} />
                            ))}
                            {!lines[b.start] && <ActivityIndicator color={colors.now} />}
                            <Text style={styles.hint}>Hold a block to forget it.</Text>
                          </View>
                        )}
                      </View>
                    ))}
                </View>
              );
            })}
        </>
      )}
    </ScrollView>
  );
}

function Line({ line, showDate }: { line: TranscriptLine; showDate?: boolean }) {
  const s = SOURCE[line.source] ?? SOURCE.mic;
  return (
    <View style={styles.line}>
      <Ionicons name={s.icon} size={13} color={s.color} style={{ marginTop: 3 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.lineMeta}>
          {showDate ? `${new Date(line.ts).toLocaleDateString([], { month: "short", day: "numeric" })} ` : ""}
          {time(line.ts)} · {s.label}
        </Text>
        <Text style={[styles.body, line.source === "background" && { color: colors.inkMute }]} selectable>
          {line.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  search: { flex: 1, color: colors.ink, fontSize: 15, paddingVertical: 10 },
  dateRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 },
  date: { color: colors.ink, fontSize: 18, fontWeight: "700" },
  card: { backgroundColor: colors.wash, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 },
  label: { color: colors.inkMute, fontSize: 12, fontWeight: "600", letterSpacing: 1 },
  title: { color: colors.ink, fontSize: 18, fontWeight: "700" },
  body: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  dim: { color: colors.inkMute, fontSize: 13, lineHeight: 18 },
  hint: { color: colors.inkMute, fontSize: 11, marginTop: 4 },
  error: { color: colors.stop },
  hourHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  hourLabel: { color: colors.now, fontSize: 14, fontWeight: "700", width: 64 },
  block: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  blockHead: { flexDirection: "row", gap: 10 },
  blockTime: { color: colors.inkMute, fontSize: 13, width: 64, marginTop: 2 },
  badges: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  badge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  lines: { marginLeft: 74, marginTop: 8, gap: 8 },
  line: { flexDirection: "row", gap: 8 },
  lineMeta: { color: colors.inkMute, fontSize: 11 },
});
