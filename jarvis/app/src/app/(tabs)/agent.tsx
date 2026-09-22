import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { Btn, GroupLabel, IconTile, Row, Screen, Tile, Tiles, Toggle, TopBar, text } from "../../components/ui";
import { api, type AgentGoal, type AgentJob, type AgentRun, type Autonomy } from "../../lib/api";
import { useAgent } from "../../lib/agent";
import { useSession } from "../../lib/auth";
import { logFail } from "../../lib/devlog";
import { colors, mono, numeric, space, type } from "../../lib/theme";

// What OVOA is set up to do on its own, what it is keeping in mind, and every
// time it has acted. The last one is the point: an agent you cannot audit is
// one you cannot leave running, so the log is a first-class part of the screen
// rather than something buried in Developer.
//
// Six tiles say the state of it in a glance; everything underneath is the
// detail behind them. Quiet is the default and the screen must not make the
// agent look chattier than it is — see docs/agent.md — so "nothing to say" is
// a normal, unalarming outcome here and takes the same grey as an empty run.

const OUTCOME: Record<AgentRun["outcome"], { label: string; color: string }> = {
  spoke: { label: "told you", color: colors.agent },
  acted: { label: "set something up", color: colors.late },
  quiet: { label: "nothing to say", color: colors.inkMute },
  error: { label: "failed", color: colors.stop },
  skipped: { label: "skipped", color: colors.inkMute },
};

/** 450 to "07:30". */
const clockFrom = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export default function AgentScreen() {
  const { token, user, setUser } = useSession();
  const { refresh: refreshNotes } = useAgent();
  const [jobs, setJobs] = useState<AgentJob[] | null>(null);
  const [goals, setGoals] = useState<AgentGoal[] | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [usedToday, setUsedToday] = useState(0);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [newGoal, setNewGoal] = useState("");
  const [showLog, setShowLog] = useState(false);
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
          await api.deleteJob(token, job.id).catch(logFail("agent: api.deleteJob"));
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
    const body = newGoal.trim();
    if (!body) return;
    setNewGoal("");
    try {
      const { id } = await api.addGoal(token, body);
      setGoals((list) => [...(list ?? []), { id, text: body, reason: null, created_at: Date.now() }]);
    } catch (err) {
      Alert.alert("Couldn't save", (err as Error).message);
    }
  };

  const dropGoal = async (goal: AgentGoal) => {
    setGoals((list) => list?.filter((g) => g.id !== goal.id) ?? null);
    await api.closeGoal(token, goal.id, "dropped").catch(logFail("agent: api.closeGoal"));
  };

  const setAutonomy = (agentAutonomy: Autonomy) => {
    const patch = async () => {
      try {
        setUser((await api.updateMe(token, { agentAutonomy })).user);
      } catch (err) {
        Alert.alert("Couldn't update", (err as Error).message);
      }
    };
    if (agentAutonomy !== "act") return patch();
    Alert.alert(
      "Let it act?",
      "It will create calendar events, tasks and drafts on its own when they follow from what you asked it to do. It still can't send anything to another person, or delete anything.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn on", onPress: patch },
      ],
    );
  };

  const today = new Date().toLocaleDateString("en-CA");
  const todays = runs.filter((r) => new Date(r.started_at).toLocaleDateString("en-CA") === today);
  const count = (o: AgentRun["outcome"]) => todays.filter((r) => r.outcome === o).length;
  const budget = user.settings.agentDailyRuns;
  const activeJobs = jobs?.filter((j) => j.status === "active").length ?? 0;

  return (
    <View style={styles.page}>
      <TopBar title="Background" />
      <Screen
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.now} />}
      >
        {!user.settings.agentEnabled && (
          <Text style={styles.warn}>Background work is off, so none of this runs. Turn it on in Settings.</Text>
        )}

        <Tiles>
          <Tile
            icon="sparkles-outline"
            tone="violet"
            label="Autonomy"
            value={user.settings.agentAutonomy === "act" ? "Act" : "Suggest"}
            small
            onPress={() => setAutonomy(user.settings.agentAutonomy === "act" ? "suggest" : "act")}
          />
          <Tile
            icon="moon-outline"
            tone="blue"
            label="Quiet"
            value={`${clockFrom(user.settings.quietStart)} – ${clockFrom(user.settings.quietEnd)}`}
            small
          />
          <Tile icon="flash-outline" tone="teal" label="Runs today" value={`${usedToday}`} suffix={` / ${budget}`}>
            {/* What the budget actually went on, not just how much of it. */}
            <View style={styles.meter}>
              <Seg n={count("spoke")} of={budget} color={colors.agent} />
              <Seg n={count("acted")} of={budget} color={colors.late} />
              <Seg n={count("quiet") + count("skipped")} of={budget} color="#C9CFD8" />
              <Seg n={count("error")} of={budget} color={colors.stop} />
            </View>
          </Tile>
          <Tile icon="refresh-outline" tone="green" label="Jobs" value={`${activeJobs}`} suffix=" on" />
          <Tile icon="locate-outline" tone="amber" label="Goals" value={`${goals?.length ?? 0}`} />
          <Tile
            icon="list-outline"
            tone="pink"
            label="Run log"
            value={showLog ? "Hide" : `${todays.length} today`}
            small
            onPress={() => setShowLog((s) => !s)}
          />
        </Tiles>

        <GroupLabel>Standing jobs</GroupLabel>
        {jobs === null ? (
          <ActivityIndicator color={colors.now} />
        ) : jobs.length === 0 ? (
          <Text style={text.sub}>
            Nothing standing. Ask {name} to check something for you — &ldquo;every morning tell me what&apos;s on&rdquo;,
            &ldquo;keep an eye on my inbox for anything from the landlord&rdquo; — and it will set it up.
          </Text>
        ) : (
          jobs.map((job, i) => (
            <View key={job.id} style={[styles.job, i === 0 && { borderTopWidth: 0 }]}>
              <View style={styles.jobHead}>
                <IconTile name={job.source === "system" ? "sunny-outline" : "git-branch-outline"} tone={job.source === "system" ? "amber" : "violet"} />
                <Text style={[text.body, { flex: 1 }]} numberOfLines={2}>
                  {job.title}
                </Text>
                <Pressable
                  onPress={() => runNow(job)}
                  disabled={running === job.id}
                  style={styles.play}
                  accessibilityLabel={`Run ${job.title} now`}
                >
                  {running === job.id ? (
                    <ActivityIndicator size="small" color={colors.now} />
                  ) : (
                    <Ionicons name="play" size={15} color={colors.now} />
                  )}
                </Pressable>
                <Toggle value={job.status === "active"} onValueChange={() => toggleJob(job)} label={job.title} />
              </View>
              <Text style={styles.jobWhen}>
                {job.when} · {job.status === "paused" ? "paused" : `next ${when(job.next_run_at)}`}
                {job.fail_count > 0 ? ` · ${job.fail_count} failed` : ""}
                {job.source === "system" ? " · built in" : job.source === "agent" ? ` · ${name} set this up` : ""}
              </Text>
              <Text style={styles.instruction}>{job.instruction}</Text>
              <Pressable onPress={() => deleteJob(job)} hitSlop={8} style={{ alignSelf: "flex-start" }}>
                <Text style={styles.stop}>Stop it</Text>
              </Pressable>
            </View>
          ))
        )}

        <GroupLabel>What you&apos;re trying to do</GroupLabel>
        <Text style={text.sub}>
          Standing intentions with no deadline. {name} sees these every time it runs on its own, and takes them into
          account when it decides whether something is worth telling you.
        </Text>
        {goals?.map((goal, i) => (
          <Row
            key={goal.id}
            title={goal.text}
            first={i === 0}
            right={
              <Pressable onPress={() => dropGoal(goal)} hitSlop={10}>
                <Text style={styles.stop}>Drop</Text>
              </Pressable>
            }
          />
        ))}
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={newGoal}
            onChangeText={setNewGoal}
            placeholder="e.g. Keep Thursday evenings clear"
            placeholderTextColor={colors.inkMute}
            onSubmitEditing={addGoal}
            returnKeyType="done"
          />
          <Pressable onPress={addGoal} disabled={!newGoal.trim()} hitSlop={8}>
            <Ionicons name="add-circle" size={30} color={newGoal.trim() ? colors.ink : colors.wash2} />
          </Pressable>
        </View>

        <GroupLabel>Everything it has done</GroupLabel>
        <Text style={text.sub}>
          Every time {name} ran on its own, including the times it decided to stay quiet. {usedToday} run
          {usedToday === 1 ? "" : "s"} today of {budget}.
        </Text>
        {!showLog ? (
          <Btn label="Show the run log" onPress={() => setShowLog(true)} style={{ alignSelf: "flex-start" }} />
        ) : runs.length === 0 ? (
          <Text style={text.sub}>Hasn&apos;t run on its own yet.</Text>
        ) : (
          runs.map((run) => (
            <View key={run.id} style={styles.run}>
              <Text style={styles.runTime}>{when(run.started_at)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={text.sub}>
                  <Text style={{ color: colors.ink }}>{run.job ?? run.trigger}</Text>
                  <Text style={{ color: OUTCOME[run.outcome].color }}> · {OUTCOME[run.outcome].label}</Text>
                </Text>
                {!!run.detail && <Text style={text.meta}>{run.detail}</Text>}
                {run.tools_used.length > 0 && <Text style={styles.tools}>{run.tools_used.join(", ")}</Text>}
              </View>
            </View>
          ))
        )}
      </Screen>
    </View>
  );
}

const Seg = ({ n, of, color }: { n: number; of: number; color: string }) =>
  n > 0 ? <View style={{ flex: n / Math.max(1, of), backgroundColor: color }} /> : null;

/** "7:30 AM", "Tue 7:30 AM" — short enough for a subtitle. */
function when(at: number) {
  const d = new Date(at);
  const sameDay = d.toLocaleDateString("en-CA") === new Date().toLocaleDateString("en-CA");
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  warn: { ...type.meta, color: colors.late },

  meter: { height: 6, borderRadius: 3, backgroundColor: colors.wash2, overflow: "hidden", flexDirection: "row", marginTop: space.s1 },

  job: { gap: space.s2, paddingVertical: space.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  jobHead: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  jobWhen: { ...type.meta, color: colors.inkMute },
  instruction: { ...type.meta, color: colors.inkMute, fontStyle: "italic" },
  stop: { ...type.meta, fontWeight: "600", color: colors.stop },
  play: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.wash, alignItems: "center", justifyContent: "center" },

  addRow: { flexDirection: "row", alignItems: "center", gap: space.s3, paddingTop: space.s2 },
  input: {
    flex: 1,
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },

  run: { flexDirection: "row", gap: space.s3, paddingVertical: space.s2 },
  runTime: { ...type.micro, ...mono, ...numeric, color: colors.inkMute, width: 62, paddingTop: 3, letterSpacing: 0 },
  tools: { ...type.micro, color: colors.inkMute, letterSpacing: 0 },
});
