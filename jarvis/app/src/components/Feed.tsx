import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api, type FeedCard } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog } from "../lib/devlog";
import { colors } from "../lib/theme";

// What OVOA did for you, what's due, and what slipped — at the top of the
// Activity tab. Built by the server from the action log, routines and the day's
// list (api/src/feed.ts), so it shows whatever actually ran. Minutes saved are
// always labelled as estimates.

export function Feed() {
  const { token } = useSession();
  const router = useRouter();
  const [cards, setCards] = useState<FeedCard[] | null>(null);

  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const { cards } = await api.feed(token);
        if (alive()) setCards(cards);
      } catch (err) {
        devlog("err", "couldn't load the feed", String(err));
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

  if (!cards) return null;

  const tickTodo = async (id: string) => {
    setCards((all) => all?.map((c) => (c.kind === "todos" ? { ...c, items: c.items.map((i) => (i.id === id ? { ...i, done: true } : i)) } : c)) ?? null);
    await api.todoDone(token, id).catch(() => {});
    void load();
  };

  const confirm = async (routineId: string, dueAt: number) => {
    await api.confirmRoutine(token, routineId, { dueAt, via: "app" }).catch(() => {});
    void load();
  };

  return (
    <View style={{ gap: 12 }}>
      {cards.map((card, i) => {
        switch (card.kind) {
          case "summary":
            return (
              <View key={i} style={styles.card}>
                <Text style={styles.label}>TODAY</Text>
                <Text style={styles.body}>{card.body}</Text>
                {card.minutesSaved > 0 && <Text style={styles.dim}>~{minutes(card.minutesSaved)} saved (estimated)</Text>}
              </View>
            );
          case "todos":
            return (
              <View key={i} style={styles.card}>
                <Text style={styles.label}>{card.title.toUpperCase()}</Text>
                {card.items.map((item) => (
                  <Pressable key={item.id} style={styles.row} onPress={() => !item.done && tickTodo(item.id)} disabled={item.done}>
                    <Ionicons
                      name={item.done ? "checkmark-circle" : "ellipse-outline"}
                      size={20}
                      color={item.done ? colors.success : colors.textDim}
                    />
                    <Text style={[styles.body, { flex: 1 }, item.done && styles.done]}>{item.text}</Text>
                  </Pressable>
                ))}
              </View>
            );
          case "routines":
            return (
              <View key={i} style={styles.card}>
                <Text style={styles.label}>{card.title.toUpperCase()}</Text>
                {card.items.map((item) => (
                  <View key={`${item.id}:${item.dueAt}`} style={styles.row}>
                    <Text style={[styles.dim, { width: 64 }]}>{item.at}</Text>
                    <Text style={[styles.body, { flex: 1 }, item.status === "done" && styles.done]}>{item.title}</Text>
                    {item.status === "pending" || item.status === "snoozed" ? (
                      <Pressable style={styles.chip} onPress={() => confirm(item.id, item.dueAt)}>
                        <Text style={styles.chipText}>Done</Text>
                      </Pressable>
                    ) : (
                      <Text style={[styles.dim, item.status === "missed" && { color: colors.warning }]}>{STATUS[item.status] ?? item.status}</Text>
                    )}
                  </View>
                ))}
              </View>
            );
          case "streak":
            return (
              <View key={i} style={[styles.card, styles.inline]}>
                <Ionicons name="flame" size={20} color={colors.success} />
                <Text style={styles.body}>
                  {card.body}: {card.title}
                </Text>
              </View>
            );
          case "missed":
            return (
              <View key={i} style={[styles.card, styles.inline]}>
                <Ionicons name="alert-circle" size={20} color={colors.warning} />
                <Text style={styles.body}>Missed: {card.body}</Text>
              </View>
            );
          case "agent":
            return (
              <Pressable key={i} style={styles.card} onPress={() => router.push("/journal")}>
                <Text style={styles.label}>🤖 {card.title.toUpperCase()}</Text>
                {card.items.map((item, j) => (
                  <View key={j} style={styles.row}>
                    <Text style={[styles.dim, { width: 64 }]}>{item.at}</Text>
                    <Text style={[styles.body, { flex: 1 }]}>{item.text}</Text>
                  </View>
                ))}
              </Pressable>
            );
          case "workout":
            return (
              <View key={i} style={styles.card}>
                <Text style={styles.label}>WORKOUT</Text>
                <Text style={[styles.body, { fontWeight: "600" }]}>{card.title}</Text>
                {!!card.body && <Text style={styles.dim}>{card.body}</Text>}
              </View>
            );
          case "week":
            return (
              <View key={i} style={styles.card}>
                <Text style={styles.label}>THIS WEEK</Text>
                <Text style={styles.body}>
                  {card.body}
                  {card.minutesSaved > 0 ? ` · ~${minutes(card.minutesSaved)} saved (estimated)` : ""}
                </Text>
              </View>
            );
          case "activity":
            return (
              <View key={i} style={styles.card}>
                <Text style={styles.label}>RECENTLY</Text>
                {card.items.map((item, j) => (
                  <View key={j} style={styles.row}>
                    <Text style={[styles.dim, { width: 64 }]}>{item.at}</Text>
                    <Text style={[styles.body, { flex: 1 }]} numberOfLines={2}>
                      {item.source === "agent" ? "🤖 " : ""}
                      {item.text}
                    </Text>
                  </View>
                ))}
              </View>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

const STATUS: Record<string, string> = { done: "done", missed: "missed", upcoming: "later", skipped: "skipped" };

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  inline: { flexDirection: "row", alignItems: "center", gap: 10 },
  label: { color: colors.textDim, fontSize: 12, fontWeight: "600", letterSpacing: 1 },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  dim: { color: colors.textDim, fontSize: 13 },
  done: { color: colors.textDim, textDecorationLine: "line-through" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2 },
  chip: { backgroundColor: colors.accentDim, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { color: colors.accent, fontWeight: "600", fontSize: 13 },
});
