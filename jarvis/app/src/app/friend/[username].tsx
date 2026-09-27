import Ionicons from "@expo/vector-icons/Ionicons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Btn, GroupLabel, IconTile, Screen, Toggle } from "../../components/ui";
import { api, type AccessLevel, type Connection, type ConnectionPerms, type OvoaLogLine } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { logFail } from "../../lib/devlog";
import { FULL_WARNING, LEVELS, levelLabel, SWITCHES, type Switch } from "../../lib/friends";
import { usePlan } from "../../lib/plan";
import { colors, space, type } from "../../lib/theme";

// One friend (Friends tab → a friend): how much their OVOA can reach. General
// is the four levels (Basic, Best friend, Partner, Full access); Advanced is
// every switch on its own, for nitpicking, plus what your OVOA said to them and
// disconnecting. The server (api/src/network.ts) is what enforces all of it;
// anything a friend asks beyond it comes to you by text or notification.

const WHEN = { dateStyle: "medium", timeStyle: "short" } as const;
type PermsChange = Partial<Omit<ConnectionPerms, "level">> & { level?: AccessLevel; confirm?: boolean };

export default function Friend() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { token } = useSession();
  const { free } = usePlan();
  const [friend, setFriend] = useState<Connection | null | undefined>(undefined);
  const [log, setLog] = useState<OvoaLogLine[]>([]);
  const [tab, setTab] = useState<"general" | "advanced">("general");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([api.connections(token), api.ovoaLog(token, username)]);
    const f = c.connections.find((x) => x.username === username && x.status === "connected") ?? null;
    setFriend(f);
    setNote(f?.perms?.shareNote ?? "");
    setLog(l.log);
  }, [token, username]);

  useEffect(() => {
    load().catch(logFail("friend: load"));
  }, [load]);

  const save = async (change: PermsChange) => {
    setBusy(true);
    try {
      const r = await api.setConnectionPerms(token, username, change);
      setFriend((f) => (f ? { ...f, perms: r.perms } : f));
    } catch (err) {
      Alert.alert("Couldn't change that", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Anything that reaches memory asks first, here and in the conversation.
  const guarded = (change: PermsChange) => {
    if (change.level === "full" || change.answerFromMemory === true) {
      Alert.alert(`Give @${username} full access?`, FULL_WARNING, [
        { text: "Cancel", style: "cancel" },
        { text: "Give full access", style: "destructive", onPress: () => void save({ ...change, confirm: true }) },
      ]);
      return;
    }
    void save(change);
  };

  if (friend === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.now} />
      </View>
    );
  }
  if (!friend?.perms) {
    return (
      <View style={styles.center}>
        <Text style={styles.meta}>@{username} isn't a friend any more.</Text>
      </View>
    );
  }
  const perms = friend.perms;
  const first = friend.name?.split(" ")[0] ?? `@${username}`;

  return (
    <>
      <Stack.Screen options={{ title: friend.name ?? `@${username}` }} />
      <Screen keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.meta}>
            @{username}
            {friend.theirLevel ? ` · they gave you ${levelLabel(friend.theirLevel)}` : ""}
          </Text>
          <Text style={styles.body}>
            Their OVOA has <Text style={perms.level === "full" ? styles.danger : styles.strong}>{levelLabel(perms.level)}</Text> access to you.
            Anything beyond it, your OVOA asks you first.
          </Text>
        </View>

        <View style={styles.segment}>
          {(["general", "advanced"] as const).map((t) => (
            <Pressable key={t} style={[styles.segmentItem, tab === t && styles.segmentOn]} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
              <Text style={[styles.segmentText, tab === t && styles.segmentTextOn]}>{t === "general" ? "General" : "Advanced"}</Text>
            </Pressable>
          ))}
        </View>

        {tab === "general" ? (
          <View style={styles.group}>
            {LEVELS.map((l) => {
              const on = perms.level === l.key;
              return (
                <Pressable
                  key={l.key}
                  disabled={busy || on}
                  onPress={() => guarded({ level: l.key })}
                  style={[styles.level, on && styles.levelOn, l.danger && styles.levelDanger, on && l.danger && styles.levelDangerOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <IconTile name={l.icon} tone={l.tone} size={36} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[styles.head, l.danger && styles.danger]}>
                      {l.label}
                      {l.danger ? " (danger)" : ""}
                    </Text>
                    <Text style={styles.meta}>{l.blurb}</Text>
                    {on && <Text style={styles.allows}>{l.allows.join(" · ")}</Text>}
                  </View>
                  <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={22} color={on ? (l.danger ? colors.stop : colors.done) : colors.inkMute} />
                </Pressable>
              );
            })}
            {perms.level === "custom" && <Text style={styles.meta}>Custom: set switch by switch under Advanced. Pick a level to reset it.</Text>}

            <GroupLabel>What {first} may know</GroupLabel>
            <TextInput
              style={styles.box}
              value={note}
              onChangeText={setNote}
              onBlur={() => note !== perms.shareNote && void save({ shareNote: note })}
              placeholder={`e.g. "I'm in the office Tue to Thu, gate code is on the fridge"`}
              placeholderTextColor={colors.inkMute}
              multiline
            />
            <Text style={styles.meta}>When OVOA answers {first} on its own, it can use this.</Text>

            {!free && <AskBox username={username} first={first} />}
          </View>
        ) : (
          <View style={styles.group}>
            <Text style={styles.meta}>Every switch on its own. Changing one makes the level Custom.</Text>
            {SWITCHES.map((s) => (
              <View key={s.key} style={styles.setting}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.body, s.danger && styles.danger]}>{s.label}</Text>
                  <Text style={styles.meta}>{s.about}</Text>
                </View>
                <Toggle label={s.label} value={perms[s.key as Switch]} onValueChange={(on) => guarded({ [s.key]: on })} />
              </View>
            ))}

            <GroupLabel>What your OVOA said to {first}</GroupLabel>
            {log.length ? (
              log.map((l, i) => (
                <View key={i} style={styles.logLine}>
                  <Text style={styles.body}>{l.said}</Text>
                  <Text style={styles.meta}>
                    {new Date(l.at).toLocaleString(undefined, WHEN)} · {l.status}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.meta}>Nothing in the last 14 days.</Text>
            )}

            <View style={[styles.row, { marginTop: space.s4 }]}>
              <Btn label="Remove friend" kind="quiet" onPress={() => remove(false)} />
              <Btn label="Block" kind="danger" onPress={() => remove(true)} />
            </View>
          </View>
        )}
      </Screen>
    </>
  );

  function remove(block: boolean) {
    Alert.alert(block ? `Block @${username}?` : `Remove @${username}?`, "Anything still going between your OVOAs stops.", [
      { text: "Cancel", style: "cancel" },
      {
        text: block ? "Block" : "Remove",
        style: "destructive",
        onPress: () =>
          void api
            .disconnect(token, username, block)
            .then(() => router.back())
            .catch((err) => Alert.alert("Couldn't do that", err instanceof Error ? err.message : String(err))),
      },
    ]);
  }
}

/** Ask a friend's OVOA something straight from here: a question, a reminder, or a note. Finding a time is best said to OVOA. */
function AskBox({ username, first }: { username: string; first: string }) {
  const { token } = useSession();
  const [kind, setKind] = useState<"question" | "reminder" | "share">("question");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.askOvoa(token, { username, kind, text: text.trim() });
      if (r.error) throw new Error(r.error);
      setText("");
      Alert.alert("Sent", `On its way to ${first}'s OVOA. You'll hear back.`);
    } catch (err) {
      Alert.alert("Couldn't send that", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: space.s2 }}>
      <GroupLabel>Ask {first}'s OVOA</GroupLabel>
      <View style={styles.row}>
        {(["question", "reminder", "share"] as const).map((k) => (
          <Pressable key={k} onPress={() => setKind(k)} style={[styles.pill, kind === k && styles.pillOn]}>
            <Text style={[styles.pillText, kind === k && styles.pillTextOn]}>{k === "question" ? "Ask" : k === "reminder" ? "Remind" : "Tell"}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.box}
        value={text}
        onChangeText={setText}
        placeholder={kind === "question" ? `e.g. "Did you get the invoice?"` : kind === "reminder" ? `e.g. "Bring the keys"` : "A note for them"}
        placeholderTextColor={colors.inkMute}
        multiline
      />
      <Btn label="Send" kind="go" busy={busy} disabled={!text.trim()} style={styles.left} onPress={() => void send()} />
      <Text style={styles.meta}>To find a time, just tell OVOA: "find 30 minutes with {first} next week".</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper, padding: space.s4 },
  header: { gap: space.s2, marginTop: space.s2 },
  body: { ...type.body, color: colors.ink },
  head: { ...type.head, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  strong: { fontWeight: "700" },
  danger: { color: colors.stop },
  allows: { ...type.meta, color: colors.inkDim, fontWeight: "600" },
  group: { gap: space.s3, marginTop: space.s4 },
  row: { flexDirection: "row", alignItems: "center", gap: space.s2, flexWrap: "wrap" },
  left: { alignSelf: "flex-start" },
  segment: { flexDirection: "row", backgroundColor: colors.wash, borderRadius: 12, padding: 3, marginTop: space.s4 },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: space.s2, borderRadius: 10 },
  segmentOn: { backgroundColor: colors.paper },
  segmentText: { ...type.sub, color: colors.inkDim },
  segmentTextOn: { color: colors.ink, fontWeight: "600" },
  level: { flexDirection: "row", alignItems: "center", gap: space.s3, padding: space.s4, borderRadius: 18, backgroundColor: colors.wash, borderWidth: 2, borderColor: "transparent" },
  levelOn: { borderColor: colors.done, backgroundColor: colors.paper },
  levelDanger: { backgroundColor: colors.stopWash },
  levelDangerOn: { borderColor: colors.stop },
  setting: { flexDirection: "row", alignItems: "center", gap: space.s3, paddingVertical: space.s2 },
  box: { backgroundColor: colors.wash, borderRadius: 12, paddingHorizontal: space.s3, paddingVertical: space.s3, minHeight: 48, color: colors.ink, ...type.body },
  pill: { paddingHorizontal: space.s3, paddingVertical: space.s1, borderRadius: 14, backgroundColor: colors.wash },
  pillOn: { backgroundColor: colors.ink },
  pillText: { ...type.sub, color: colors.inkDim },
  pillTextOn: { color: colors.paper, fontWeight: "600" },
  logLine: { gap: 2, paddingVertical: space.s2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
});
