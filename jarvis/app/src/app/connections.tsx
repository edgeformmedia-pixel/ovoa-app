import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Btn, Toggle } from "../components/ui";
import { api, type Connection, type ConnectionPerms, type OvoaLogLine, type OvoaWaiting } from "../lib/api";
import { useSession } from "../lib/auth";
import { logFail } from "../lib/devlog";
import { colors, space, type } from "../lib/theme";

// Your OVOA and other people's (api/src/network.ts, docs/ovoa-network.md):
// who it can talk to, who asked, what each one is allowed, what waits for your
// yes, and everything it said. Settings → Assistant → Connections. Most of it
// is done by talking to OVOA ("connect with @maria", "yes, Tuesday at 3");
// this is where it can all be seen and changed.

const WHEN = { dateStyle: "medium", timeStyle: "short" } as const;

export default function Connections() {
  const { token } = useSession();
  const [data, setData] = useState<{ username: string | null; connections: Connection[]; waiting: OvoaWaiting[] } | null>(null);
  const [log, setLog] = useState<OvoaLogLine[]>([]);
  const [asking, setAsking] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([api.connections(token), api.ovoaLog(token)]);
    setData(c);
    setLog(l.log);
  }, [token]);

  useEffect(() => {
    load().catch(logFail("connections: load"));
  }, [load]);

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

  if (!data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.now} />
      </View>
    );
  }

  const connected = data.connections.filter((c) => c.status === "connected");
  const asked = data.connections.filter((c) => c.status === "asked you");
  const waitingOnThem = data.connections.filter((c) => c.status === "waiting for them");
  const blocked = data.connections.filter((c) => c.status === "blocked");

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load()
                .catch(logFail("connections: refresh"))
                .finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <Text style={styles.lead}>
          Your OVOA can talk to the OVOAs of people you connect with: to find a time to meet, ask something, or pass on a reminder. They
          only ever see when you're free or busy, and anything that commits you comes to you first.
        </Text>

        {!data.username ? (
          <Text style={styles.meta}>Pick a username first, in Settings → Account: it's how other people's OVOAs find yours.</Text>
        ) : (
          <View style={{ gap: space.s2 }}>
            <Text style={styles.sub}>Connect with someone</Text>
            <View style={styles.inputRow}>
              <Text style={styles.at}>@</Text>
              <TextInput
                style={styles.input}
                value={asking}
                onChangeText={setAsking}
                placeholder="their username"
                placeholderTextColor={colors.inkMute}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <Btn
              label="Ask to connect"
              kind="go"
              busy={busy}
              disabled={!asking.trim()}
              style={styles.left}
              onPress={() =>
                void act(async () => {
                  const r = await api.connect(token, asking.trim().replace(/^@+/, ""));
                  if (r.error) throw new Error(r.error);
                  setAsking("");
                }, "Asked. They'll be asked in their OVOA, and you'll hear when they say yes.")
              }
            />
            <Text style={styles.meta}>Yours is @{data.username}.</Text>
          </View>
        )}

        {data.waiting.length > 0 && (
          <View style={{ gap: space.s3 }}>
            <Text style={styles.sub}>Waiting for your answer</Text>
            {data.waiting.map((w) => (
              <Waiting key={w.id} w={w} busy={busy} onDecide={(decision, extra) => act(() => api.decideOvoa(token, w.id, decision, extra))} />
            ))}
          </View>
        )}

        {asked.length > 0 && (
          <View style={{ gap: space.s3 }}>
            <Text style={styles.sub}>Asking to connect</Text>
            {asked.map((c) => (
              <View key={c.username} style={styles.card}>
                <Text style={styles.label}>
                  {c.name} (@{c.username})
                </Text>
                <Text style={styles.meta}>Wants their OVOA to be able to talk to yours.</Text>
                <View style={styles.row}>
                  <Btn label="Yes" kind="go" busy={busy} onPress={() => void act(() => api.answerConnection(token, c.username!, "yes"))} />
                  <Btn label="No" busy={busy} onPress={() => void act(() => api.answerConnection(token, c.username!, "no"))} />
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

        <View style={{ gap: space.s3 }}>
          <Text style={styles.sub}>Connected</Text>
          {connected.length ? (
            connected.map((c) => (
              <ConnectionCard
                key={c.username}
                c={c}
                onPerms={(perms) => act(() => api.setConnectionPerms(token, c.username!, perms))}
                onDisconnect={(block) =>
                  Alert.alert(block ? `Block @${c.username}?` : `Disconnect from @${c.username}?`, "Anything still going between your OVOAs stops.", [
                    { text: "Cancel", style: "cancel" },
                    { text: block ? "Block" : "Disconnect", style: "destructive", onPress: () => void act(() => api.disconnect(token, c.username!, block)) },
                  ])
                }
              />
            ))
          ) : (
            <Text style={styles.meta}>Nobody yet.</Text>
          )}
          {waitingOnThem.map((c) => (
            <Text key={c.username} style={styles.meta}>
              @{c.username}: waiting for them to say yes.
            </Text>
          ))}
          {blocked.map((c) => (
            <View key={c.username} style={styles.row}>
              <Text style={[styles.meta, { flex: 1 }]}>@{c.username}: blocked.</Text>
              <Btn label="Unblock" kind="quiet" onPress={() => void act(() => api.disconnect(token, c.username!))} />
            </View>
          ))}
        </View>

        <View style={{ gap: space.s2 }}>
          <Text style={styles.sub}>What your OVOA said (14 days)</Text>
          {log.length ? (
            log.map((l, i) => (
              <View key={i} style={styles.logLine}>
                <Text style={styles.label}>
                  To {l.to}: <Text style={styles.body}>{l.said}</Text>
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
      </ScrollView>
    </SafeAreaView>
  );
}

function Waiting({
  w,
  busy,
  onDecide,
}: {
  w: OvoaWaiting;
  busy: boolean;
  onDecide: (decision: "yes" | "no" | "changes", extra?: { choice?: string; text?: string }) => Promise<unknown>;
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
          <TextInput
            style={[styles.input, styles.box]}
            value={text}
            onChangeText={setText}
            placeholder="Your answer"
            placeholderTextColor={colors.inkMute}
            multiline
          />
          <View style={styles.row}>
            <Btn label="Send" kind="go" busy={busy} disabled={!text.trim()} onPress={() => void onDecide("yes", { text: text.trim() })} />
            <Btn label="Don't answer" kind="quiet" onPress={() => void onDecide("no")} />
          </View>
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

function ConnectionCard({
  c,
  onPerms,
  onDisconnect,
}: {
  c: Connection;
  onPerms: (perms: Partial<ConnectionPerms>) => Promise<unknown>;
  onDisconnect: (block: boolean) => void;
}) {
  const perms = c.perms!;
  const [note, setNote] = useState(perms.shareNote);
  useEffect(() => setNote(perms.shareNote), [perms.shareNote]);
  const first = c.name?.split(" ")[0] ?? `@${c.username}`;
  return (
    <View style={styles.card}>
      <Text style={styles.label}>
        {c.name} (@{c.username})
      </Text>
      <Setting label="Share when I'm free or busy" about="Only the times, never what's in your calendar.">
        <Toggle value={perms.shareFreeBusy} onValueChange={(on) => void onPerms({ shareFreeBusy: on })} />
      </Setting>
      <Setting label={`Let ${first} book me`} about="A free time is taken without asking you, and you're told.">
        <Toggle value={perms.autoAcceptMeetings} onValueChange={(on) => void onPerms({ autoAcceptMeetings: on })} />
      </Setting>
      <Setting label="Answer questions without asking" about="Only from what you write below; anything else still comes to you.">
        <Toggle value={perms.autoAnswerQuestions} onValueChange={(on) => void onPerms({ autoAnswerQuestions: on })} />
      </Setting>
      <TextInput
        style={[styles.input, styles.box]}
        value={note}
        onChangeText={setNote}
        onBlur={() => note !== perms.shareNote && void onPerms({ shareNote: note })}
        placeholder={`What ${first} may know (e.g. "I'm in the office Tue to Thu")`}
        placeholderTextColor={colors.inkMute}
        multiline
      />
      <View style={styles.row}>
        <Btn label="Disconnect" kind="quiet" onPress={() => onDisconnect(false)} />
        <Btn label="Block" kind="danger" onPress={() => onDisconnect(true)} />
      </View>
    </View>
  );
}

function Setting({ label, about, children }: { label: string; about: string; children: React.ReactNode }) {
  return (
    <View style={styles.setting}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.body}>{label}</Text>
        <Text style={styles.meta}>{about}</Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.paper },
  page: { padding: space.s4, gap: space.s4, paddingBottom: space.s10 },
  body: { ...type.body, color: colors.ink },
  lead: { ...type.body, color: colors.inkDim },
  label: { ...type.head, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  sub: { ...type.meta, fontWeight: "600", color: colors.inkMute, marginTop: space.s3 },
  card: { gap: space.s3, padding: space.s4, borderRadius: 18, backgroundColor: colors.wash },
  row: { flexDirection: "row", alignItems: "center", gap: space.s2, flexWrap: "wrap" },
  setting: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  left: { alignSelf: "flex-start" },
  logLine: { gap: 2, paddingVertical: space.s2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: colors.wash, borderRadius: 14, paddingLeft: space.s3 },
  at: { ...type.body, color: colors.inkMute },
  input: { flex: 1, color: colors.ink, ...type.body, paddingHorizontal: space.s1, paddingVertical: space.s3 },
  box: { backgroundColor: colors.paper, borderRadius: 12, paddingHorizontal: space.s3, minHeight: 48 },
});
