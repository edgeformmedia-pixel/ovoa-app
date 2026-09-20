import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type AgentGoal, type AgentJob, type AgentRun } from "../lib/api";
import { useAgent } from "../lib/agent";
import { useSession } from "../lib/auth";
import { colors } from "../lib/theme";

// What OVOA is set up to do on its own, what it is keeping in mind, and every
// time it has acted. The last one is the point: an agent you cannot audit is
// one you cannot leave running, so the log is a first-class screen rather than
// something buried in Developer.

const OUTCOME: Record<AgentRun["outcome"], { label: string; color: string }> = {
  spoke: { label: "told you", color: colors.accent },
  acted: { label: "set something up", color: colors.warning },
  quiet: { label: "nothing to say", color: colors.textDim },
  error: { label: "failed", color: colors.danger },
  skipped: { label: "skipped", color: colors.textDim },
};

export default function AgentScreen() {
  const { token, user } = useSession();
  const { refresh: refreshNotes } = useAgent();
  const [jobs, setJobs] = useState<AgentJob[] | null>(null);
  const [goals, setGoals] = useState<AgentGoal[] | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [usedToday, setUsedToday] = useState(0);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [newGoal, setNewGoal] = useState("");
  const name = user.settings.assistantName || "OVOA";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [j, g, r] = await Promise.all([api.agentJobs(token), api.agentGoals(token), api.agentRuns(token)]);
      setJobs(j.jobs);
      setGoals(g.goals);
      setRuns(r.runs);
      setUsedToday(r.usedToday);
    } catch (err) {
      Alert.alert("Couldn't load", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleJob = async (job: AgentJob) => {
    const status = job.status === "active" ? "paused" : "active";
    setJobs((list) => list?.map((j) => (j.id === job.id ? { ...j, status } : j)) ?? null);
    await api.updateJob(token, job.id, { status }).catch((err) => Alert.alert("Couldn't update", err.message));
  };

  const deleteJob = (job: AgentJob) =>
    Alert.alert(`Stop "${job.title}"?`, `${name} won't do this any more.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop it",
        style: "destructive",
        onPress: async () => {
          setJobs((list) => list?.filter((j) => j.id !== job.id) ?? null);
          await api.deleteJob(token, job.id).catch(() => {});
        },
      },
    ]);

  const runNow = async (job: AgentJob) => {
    setRunning(job.id);
    try {
      const r = await api.runJob(token, job.id);
      await Promise.all([load(), refreshNotes()]);
      Alert.alert(
        r.note ? r.note.title : "Nothing to report",
        r.note ? r.note.body : `${name} looked and decided there was nothing worth telling you. ${r.detail}`,
      );
    } catch (err) {
      Alert.alert("That didn't run", (err as Error).message);
    } finally {
      setRunning(null);
    }
  };

  const addGoal = async () => {
    const text = newGoal.trim();
    if (!text) return;
    setNewGoal("");
    try {
      const { id } = await api.addGoal(token, text);
      setGoals((list) => [...(list ?? []), { id, text, reason: null, created_at: Date.now() }]);
    } catch (err) {
      Alert.alert("Couldn't save", (err as Error).message);
    }
  };

  const dropGoal = async (goal: AgentGoal) => {
    setGoals((list) => list?.filter((g) => g.id !== goal.id) ?? null);
    await api.closeGoal(token, goal.id, "dropped").catch(() => {});
  };

  return (
    <>
      <Stack.Screen options={{ title: "Background work" }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        {!user.settings.agentEnabled && (
          <View style={[styles.card, { borderColor: colors.warning }]}>
            <Text style={{ color: colors.warning, fontSize: 13, lineHeight: 19 }}>
              Background work is off, so none of this runs. Turn it on in Settings.
            </Text>
          </View>
        )}

        <Section title="Standing jobs">
          {jobs === null ? (
            <ActivityIndicator color={colors.accent} />
          ) : jobs.length === 0 ? (
            <Text style={styles.meta}>
              Nothing standing. Ask {name} to check something for you — "every morning tell me what's on", "keep an eye
              on my inbox for anything from the landlord" — and it will set it up.
            </Text>
          ) : (
            jobs.map((job) => (
              <View key={job.id} style={styles.job}>
                <View style={styles.jobHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>{job.title}</Text>
                    <Text style={styles.meta}>
                      {job.when} · {job.status === "paused" ? "paused" : `next ${nextWhen(job.next_run_at)}`}
                      {job.fail_count > 0 ? ` · ${job.fail_count} failed` : ""}
                    </Text>
                  </View>
                  <Switch
                    value={job.status === "active"}
                    onValueChange={() => toggleJob(job)}
                    trackColor={{ true: colors.accent, false: colors.border }}
                  />
                </View>
                <Text style={styles.instruction}>{job.instruction}</Text>
                <View style={styles.jobActions}>
                  <Pressable onPress={() => runNow(job)} disabled={running === job.id} hitSlop={8}>
                    <Text style={styles.action}>{running === job.id ? "Running…" : "Run now"}</Text>
                  </Pressable>
                  <Pressable onPress={() => deleteJob(job)} hitSlop={8}>
                    <Text style={[styles.action, { color: colors.danger }]}>Stop it</Text>
                  </Pressable>
                  {job.source === "system" && <Text style={styles.tag}>built in</Text>}
                  {job.source === "agent" && <Text style={styles.tag}>{name} set this up</Text>}
                </View>
              </View>
            ))
          )}
        </Section>

        <Section title="What you're trying to do">
          <Text style={styles.meta}>
            Standing intentions with no deadline. {name} sees these every time it runs on its own, and takes them into
            account when it decides whether something is worth telling you.
          </Text>
          {goals?.map((goal) => (
            <View key={goal.id} style={styles.row}>
              <Text style={[styles.label, { flex: 1 }]}>{goal.text}</Text>
              <Pressable onPress={() => dropGoal(goal)} hitSlop={10}>
                <Text style={styles.dismiss}>Drop</Text>
              </Pressable>
            </View>
          ))}
          <View style={styles.addRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={newGoal}
              onChangeText={setNewGoal}
              placeholder="e.g. Keep Thursday evenings clear"
              placeholderTextColor={colors.textDim}
              onSubmitEditing={addGoal}
              returnKeyType="done"
            />
            <Pressable onPress={addGoal} disabled={!newGoal.trim()} hitSlop={8}>
              <Ionicons name="add-circle" size={30} color={newGoal.trim() ? colors.accent : colors.border} />
            </Pressable>
          </View>
        </Section>

        <Section title="Everything it has done">
          <Text style={styles.meta}>
            Every time {name} ran on its own, including the times it decided to stay quiet. {usedToday} run
            {usedToday === 1 ? "" : "s"} today of {user.settings.agentDailyRuns}.
          </Text>
          {runs.length === 0 ? (
            <Text style={styles.meta}>Hasn't run on its own yet.</Text>
          ) : (
            runs.map((run) => (
              <View key={run.id} style={styles.runRow}>
                <Text style={styles.runTime}>{nextWhen(run.started_at)}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>
                    {run.job ?? run.trigger}
                    <Text style={{ color: OUTCOME[run.outcome].color }}> · {OUTCOME[run.outcome].label}</Text>
                  </Text>
                  {!!run.detail && <Text style={styles.meta}>{run.detail}</Text>}
                  {run.tools_used.length > 0 && <Text style={styles.tools}>{run.tools_used.join(", ")}</Text>}
                </View>
              </View>
            ))
          )}
        </Section>
      </ScrollView>
    </>
  );
}

/** "today at 7:30 AM", "Tue 7:30 AM" — short enough for a subtitle. */
function nextWhen(at: number) {
  const when = new Date(at);
  const sameDay = when.toLocaleDateString("en-CA") === new Date().toLocaleDateString("en-CA");
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${when.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48, gap: 24 },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: "600", letterSpacing: 1, marginLeft: 4 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 14,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  job: { gap: 8, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  jobHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  jobActions: { flexDirection: "row", alignItems: "center", gap: 18, flexWrap: "wrap" },
  label: { color: colors.text, fontSize: 15 },
  meta: { color: colors.textDim, fontSize: 13, lineHeight: 19 },
  instruction: { color: colors.textDim, fontSize: 12, lineHeight: 18, fontStyle: "italic" },
  action: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  dismiss: { color: colors.danger, fontSize: 13 },
  tag: { color: colors.textDim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  runRow: { flexDirection: "row", gap: 12 },
  runTime: { color: colors.textDim, fontSize: 12, width: 68, paddingTop: 2 },
  tools: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: 10,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
