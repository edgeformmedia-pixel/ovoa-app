import Ionicons from "@expo/vector-icons/Ionicons";
import { router, useFocusEffect, type Href } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { Btn, GroupLabel, Screen, TopBar, toneInk, toneWash } from "../../components/ui";
import { api, type Connection, type OvoaLogLine, type OvoaWaiting } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { logFail } from "../../lib/devlog";
import { LEVELS, levelLabel } from "../../lib/friends";
import { colors, space, type } from "../../lib/theme";

// Friends (api/src/network.ts, docs/ovoa-network.md): the people whose OVOAs
// yours can talk to. Add someone by @username, answer who asked, see what waits
// for your OK (anything a friend asked that's beyond the access you gave them),
// and open a friend to set their access: a level under General, single switches
// under Advanced (app/friend/[username].tsx). All of it can also be done by
// talking or texting OVOA ("add @maria", "make Maria my partner").

const WHEN = { dateStyle: "medium", timeStyle: "short" } as const;

type Data = { username: string | null; connections: Connection[]; waiting: OvoaWaiting[] };

export default function Friends() {
  const { token } = useSession();
  const [data, setData] = useState<Data | null>(null);
  const [log, setLog] = useState<OvoaLogLine[]>([]);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([api.connections(token), api.ovoaLog(token)]);
    setData(c);
    setLog(l.log);
  }, [token]);

  // Fresh each time it's opened: a friend may have said yes, or asked something, meanwhile.
  useFocusEffect(
    useCallback(() => {
      load().catch(logFail("friends: load"));
    }, [load]),
  );

  const act = async (what: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await what();
      await load();
      if (done) Alert.alert(done);
    } catch (err) {
      Alert.alert("Couldn't do that", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const accept = (c: Connection) =>
    Alert.alert(`Add ${c.name ?? `@${c.username}`}?`, "How much can their OVOA reach? You can change it any time.", [
      ...LEVELS.filter((l) => !l.danger).map((l) => ({
        text: l.label,
        onPress: () => void act(() => api.answerConnection(token, c.username!, "yes", l.key as "basic" | "best_friend" | "partner")),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);

  const friends = data?.connections.filter((c) => c.status === "connected") ?? [];
  const asked = data?.connections.filter((c) => c.status === "asked you") ?? [];
  const sent = data?.connections.filter((c) => c.status === "waiting for them") ?? [];
  const blocked = data?.connections.filter((c) => c.status === "blocked") ?? [];

  return (
    <View style={styles.safe}>
      <TopBar title="Friends" when={data?.username ? `@${data.username}` : undefined} />
      {!data ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.now} />
        </View>
      ) : (
        <Screen
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load()
                  .catch(logFail("friends: refresh"))
                  .finally(() => setRefreshing(false));
              }}
            />
          }
        >
          <Text style={styles.lead}>
            Your OVOA talks to your friends' OVOAs: finding a time, asking something, passing on a reminder. You choose how much each
            friend's OVOA can reach, and anything beyond that comes to you first.
          </Text>

          {!data.username ? (
            <View style={styles.card}>
              <Text style={styles.body}>Pick a username first: it's how friends find your OVOA.</Text>
              <Btn label="Pick one" kind="go" style={styles.left} onPress={() => router.push("/settings" as Href)} />
            </View>
          ) : (
            <View style={styles.addRow}>
              <Text style={styles.at}>@</Text>
              <TextInput
                style={styles.input}
                value={adding}
                onChangeText={setAdding}
                placeholder="Add a friend by username"
                placeholderTextColor={colors.inkMute}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="send"
                onSubmitEditing={() => adding.trim() && void add()}
              />
              <Btn label="Add" kind="go" busy={busy} disabled={!adding.trim()} onPress={() => void add()} />
            </View>
          )}

          {data.waiting.length > 0 && (
            <View style={styles.group}>
              <GroupLabel>Waiting for your OK</GroupLabel>
              {data.waiting.map((w) => (
                <Waiting key={w.id} w={w} busy={busy} onDecide={(decision, extra) => act(() => api.decideOvoa(token, w.id, decision, extra))} />
              ))}
            </View>
          )}

          {asked.length > 0 && (
            <View style={styles.group}>
              <GroupLabel>Friend requests</GroupLabel>
              {asked.map((c) => (
                <View key={c.username} style={styles.card}>
                  <View style={styles.personRow}>
                    <Avatar name={c.name ?? c.username ?? "?"} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.head}>{c.name}</Text>
                      <Text style={styles.meta}>@{c.username} wants your OVOAs to talk</Text>
                    </View>
                  </View>
                  <View style={styles.row}>
                    <Btn label="Accept" kind="go" busy={busy} onPress={() => accept(c)} />
                    <Btn label="Decline" busy={busy} onPress={() => void act(() => api.answerConnection(token, c.username!, "no"))} />
                    <Btn
                      label="Block"
                      kind="quiet"
                      onPress={() =>
                        Alert.alert(`Block @${c.username}?`, "They won't be told, and can't ask again.", [
                          { text: "Cancel", style: "cancel" },
                          { text: "Block", style: "destructive", onPress: () => void act(() => api.answerConnection(token, c.username!, "block")) },
                        ])
                      }
                    />
                  </View>
                </View>
              ))}
            </View>
          )}

          <View style={styles.group}>
            <GroupLabel>{friends.length ? `Friends (${friends.length})` : "Friends"}</GroupLabel>
            {friends.length ? (
              friends.map((c) => <FriendRow key={c.username} c={c} />)
            ) : (
              <Text style={styles.meta}>No friends yet. Add someone who uses OVOA by their username.</Text>
            )}
            {sent.map((c) => (
              <Text key={c.username} style={styles.meta}>
                @{c.username}: waiting for them to accept.
              </Text>
            ))}
            {blocked.map((c) => (
              <View key={c.username} style={styles.row}>
                <Text style={[styles.meta, { flex: 1 }]}>@{c.username}: blocked.</Text>
                <Btn label="Unblock" kind="quiet" onPress={() => void act(() => api.disconnect(token, c.username!))} />
              </View>
            ))}
          </View>

          <View style={styles.group}>
            <GroupLabel>What your OVOA said (14 days)</GroupLabel>
            {log.length ? (
              log.slice(0, 20).map((l, i) => (
                <View key={i} style={styles.logLine}>
                  <Text style={styles.body}>
                    <Text style={styles.head}>To {l.to}: </Text>
                    {l.said}
                  </Text>
                  <Text style={styles.meta}>
                    {new Date(l.at).toLocaleString(undefined, WHEN)} · {l.status}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.meta}>Nothing yet.</Text>
            )}
          </View>
        </Screen>
      )}
    </View>
  );

  async function add() {
    const name = adding.trim().replace(/^@+/, "");
    await act(async () => {
      const r = await api.connect(token, name);
      if (r.error) throw new Error(r.error);
      setAdding("");
    }, `Asked @${name}. You'll hear when they accept.`);
  }
}

function Avatar({ name, level }: { name: string; level?: string }) {
  const tone = LEVELS.find((l) => l.key === level)?.tone ?? "blue";
  return (
    <View style={[styles.avatar, { backgroundColor: toneWash(tone) }]}>
      <Text style={[styles.avatarText, { color: toneInk(tone) }]}>{name.trim()[0]?.toUpperCase() ?? "?"}</Text>
    </View>
  );
}

function FriendRow({ c }: { c: Connection }) {
  const level = c.perms?.level;
  const danger = level === "full" || c.perms?.answerFromMemory;
  return (
    <Pressable style={styles.friend} onPress={() => router.push(`/friend/${c.username}` as Href)} accessibilityRole="button">
      <Avatar name={c.name ?? c.username ?? "?"} level={level} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.head}>{c.name}</Text>
        <Text style={styles.meta}>
          @{c.username}
          {c.theirLevel && c.theirLevel !== "basic" ? ` · gave you ${levelLabel(c.theirLevel)}` : ""}
        </Text>
      </View>
      <View style={[styles.chip, danger && styles.chipDanger]}>
        <Text style={[styles.chipText, danger && styles.chipTextDanger]}>{levelLabel(level)}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.inkMute} />
    </Pressable>
  );
}

/** Something a friend's OVOA asked that waits for them: often beyond the access they gave. */
function Waiting({
  w,
  busy,
  onDecide,
}: {
  w: OvoaWaiting;
  busy: boolean;
  onDecide: (decision: "yes" | "no" | "changes", extra?: { choice?: string; text?: string; always?: boolean }) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  return (
    <View style={styles.card}>
      <Text style={styles.meta}>From {w.from}</Text>
      <Text style={styles.body}>{w.summary}</Text>
      {w.kind === "accept_meeting" && w.times?.length ? (
        <View style={{ gap: space.s2 }}>
          {w.times.map((t, i) => (
            <Btn key={t} label={t.replace(/^\d+\) /, "")} busy={busy} style={styles.left} onPress={() => void onDecide("yes", { choice: String(i + 1) })} />
          ))}
          <Btn label="No" kind="quiet" style={styles.left} onPress={() => void onDecide("no")} />
        </View>
      ) : w.kind === "answer_question" ? (
        <View style={{ gap: space.s2 }}>
          <View style={styles.row}>
            <Btn label="Answer it for me" kind="go" busy={busy} onPress={() => void onDecide("yes")} />
            <Btn label="Always answer them" busy={busy} onPress={() => void onDecide("yes", { always: true })} />
          </View>
          <TextInput
            style={[styles.input, styles.box]}
            value={text}
            onChangeText={setText}
            placeholder="Or write the answer yourself"
            placeholderTextColor={colors.inkMute}
            multiline
          />
          <View style={styles.row}>
            <Btn label="Send" busy={busy} disabled={!text.trim()} onPress={() => void onDecide("yes", { text: text.trim() })} />
            <Btn label="Don't answer" kind="quiet" onPress={() => void onDecide("no")} />
          </View>
        </View>
      ) : w.kind === "pass_reminder" ? (
        <View style={styles.row}>
          <Btn label="Let it through" kind="go" busy={busy} onPress={() => void onDecide("yes")} />
          <Btn label="Always" busy={busy} onPress={() => void onDecide("yes", { always: true })} />
          <Btn label="No" kind="quiet" onPress={() => void onDecide("no")} />
        </View>
      ) : (
        <View style={styles.row}>
          <Btn label="Yes" kind="go" busy={busy} onPress={() => void onDecide("yes")} />
          <Btn label="No" kind="quiet" onPress={() => void onDecide("no")} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  lead: { ...type.sub, color: colors.inkDim },
  body: { ...type.body, color: colors.ink },
  head: { ...type.head, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  group: { gap: space.s3, marginTop: space.s4 },
  card: { gap: space.s3, padding: space.s4, borderRadius: 18, backgroundColor: colors.wash },
  row: { flexDirection: "row", alignItems: "center", gap: space.s2, flexWrap: "wrap" },
  left: { alignSelf: "flex-start" },
  addRow: { flexDirection: "row", alignItems: "center", gap: space.s2, backgroundColor: colors.wash, borderRadius: 16, paddingLeft: space.s3, paddingRight: space.s1, marginTop: space.s4 },
  at: { ...type.body, color: colors.inkMute },
  input: { flex: 1, color: colors.ink, ...type.body, paddingHorizontal: space.s1, paddingVertical: space.s3 },
  box: { backgroundColor: colors.paper, borderRadius: 12, paddingHorizontal: space.s3, minHeight: 48 },
  personRow: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  friend: { flexDirection: "row", alignItems: "center", gap: space.s3, paddingVertical: space.s3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  avatarText: { ...type.head },
  chip: { paddingHorizontal: space.s2, paddingVertical: 3, borderRadius: 10, backgroundColor: colors.wash },
  chipDanger: { backgroundColor: colors.stopWash },
  chipText: { ...type.meta, color: colors.inkDim, fontWeight: "600" },
  chipTextDanger: { color: colors.stop },
  logLine: { gap: 2, paddingVertical: space.s2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
});
