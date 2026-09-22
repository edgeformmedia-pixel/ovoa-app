import { useRouter, type Href } from "expo-router";
import { logFail } from "../../lib/devlog";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { GoogleConnection } from "../../components/GoogleConnection";
import { SiriSetup } from "../../components/SiriSetup";
import { VoicePicker } from "../../components/VoicePicker";
import { api, type Autonomy, type Memory } from "../../lib/api";
import { disableTimeline, enableTimeline, timelinePref } from "../../lib/location";
import { useAgent } from "../../lib/agent";
import { useAssistant } from "../../lib/assistant";
import { useSession } from "../../lib/auth";
import { autoSendTextsPref, SEND_TEXT_SHORTCUT } from "../../lib/storage";
import { colors } from "../../lib/theme";

export default function Settings() {
  const router = useRouter();
  const { token, user, setUser, signOut, clear } = useSession();
  const [name, setName] = useState(user?.name ?? "");
  const [assistantName, setAssistantName] = useState(user?.settings.assistantName ?? "");
  const [personality, setPersonality] = useState(user?.settings.personality ?? "");
  const [saving, setSaving] = useState(false);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [autoSendTexts, setAutoSendTexts] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const { listenMode, setListenMode, micSource, setMicSource, alwaysListen, setAlwaysListen } = useAssistant();
  const { pushProblem } = useAgent();
  const [quiet, setQuiet] = useState({
    start: minutesToClock(user?.settings.quietStart ?? 1320),
    end: minutesToClock(user?.settings.quietEnd ?? 420),
  });

  useEffect(() => {
    autoSendTextsPref.get().then(setAutoSendTexts);
  }, []);

  const toggleAutoSendTexts = (on: boolean) => {
    setAutoSendTexts(on);
    autoSendTextsPref.set(on).catch(logFail("settings: autoSendTextsPref.set"));
    if (on) {
      Alert.alert(
        `Build the "${SEND_TEXT_SHORTCUT}" shortcut`,
        `iOS never lets an app send a text on its own, but the Shortcuts app can.

` +
          `1. Open Shortcuts, tap +, and name it exactly "${SEND_TEXT_SHORTCUT}".
` +
          `2. Add "Split Text" with Shortcut Input, split by New Lines.
` +
          `3. Add "Send Message": Recipients = Item 1 of Split Text, Message = Item 2 of Split Text.
` +
          `4. Open the Send Message action's settings and turn "Show When Run" off.

` +
          `The first text asks iOS for permission once. Until the shortcut exists, texts open in Messages as before.`,
      );
    }
  };

  useEffect(() => {
    api.memories(token).then((r) => setMemories(r.memories)).catch(() => setMemories([]));
  }, [token]);

  if (!user) return null; // signing out

  const dirty =
    name.trim() !== user.name ||
    assistantName.trim() !== user.settings.assistantName ||
    personality.trim() !== user.settings.personality;

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.updateMe(token, {
        name: name.trim(),
        assistantName: assistantName.trim(),
        personality: personality.trim(),
      });
      setUser(r.user);
    } catch (err) {
      Alert.alert("Couldn't save", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setAutoApprove = async (autoApprove: boolean) => {
    try {
      setUser((await api.updateMe(token, { autoApprove })).user);
    } catch (err) {
      Alert.alert("Couldn't update", (err as Error).message);
    }
  };

  const toggleAutoApprove = (on: boolean) => {
    if (!on) return setAutoApprove(false);
    Alert.alert(
      "Approve for me?",
      `${assistantName || "Your assistant"} will act without asking first: sending and deleting emails, deleting calendar events, changing contacts, and more. Mistakes can't always be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn on", style: "destructive", onPress: () => setAutoApprove(true) },
      ],
    );
  };

  const toggleMemory = async (memoryEnabled: boolean) => {
    try {
      setUser((await api.updateMe(token, { memoryEnabled })).user);
    } catch (err) {
      Alert.alert("Couldn't update", (err as Error).message);
    }
  };

  const forget = async (id: string) => {
    await api.deleteMemory(token, id);
    setMemories((m) => m?.filter((x) => x.id !== id) ?? null);
  };

  const confirm = (title: string, message: string, action: string, run: () => Promise<unknown>) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: action,
        style: "destructive",
        onPress: () => run().catch((err) => Alert.alert("Something went wrong", err.message)),
      },
    ]);

  /** One settings field at a time; the server answers with the whole user. */
  const patch = async (change: Parameters<typeof api.updateMe>[1]) => {
    try {
      setUser((await api.updateMe(token, change)).user);
    } catch (err) {
      Alert.alert("Couldn't update", (err as Error).message);
    }
  };

  const toggleAgent = (on: boolean) => {
    if (!on) return patch({ agentEnabled: false });
    Alert.alert(
      "Let it work on its own?",
      `${assistantName || "OVOA"} will check things while you're not here — your calendar, what you said you'd do, anything you ask it to watch — and notify you when something matters. It can't message anyone or delete anything without you. Everything it does is logged, and you can turn this off at any time.`,
      [
        { text: "Not now", style: "cancel" },
        { text: "Turn on", onPress: () => patch({ agentEnabled: true }) },
      ],
    );
  };

  const setAutonomy = (agentAutonomy: Autonomy) => {
    if (agentAutonomy !== "act") return patch({ agentAutonomy });
    Alert.alert(
      "Let it act?",
      "It will create calendar events, tasks and drafts on its own when they follow from what you asked it to do. It still can't send anything to another person, or delete anything.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn on", onPress: () => patch({ agentAutonomy: "act" }) },
      ],
    );
  };

  /** "22:00" back to minutes. Anything unparseable leaves the setting alone. */
  const saveQuiet = () => {
    const start = clockToMinutes(quiet.start);
    const end = clockToMinutes(quiet.end);
    if (start === null || end === null) {
      setQuiet({ start: minutesToClock(user.settings.quietStart), end: minutesToClock(user.settings.quietEnd) });
      return;
    }
    setQuiet({ start: minutesToClock(start), end: minutesToClock(end) });
    if (start !== user.settings.quietStart || end !== user.settings.quietEnd) {
      patch({ quietStart: start, quietEnd: end });
    }
  };

  const toggleContext = (on: boolean) => {
    if (!on) return patch({ contextEnabled: false });
    Alert.alert(
      "Keep a record of your days?",
      "Only what you record. Each recording is summarised, the summary is kept, and the words are dropped — they are never stored on the server. Nothing is captured in the background, ever.",
      [
        { text: "Not now", style: "cancel" },
        { text: "Turn on", onPress: () => patch({ contextEnabled: true }) },
      ],
    );
  };

  const setRetention = (contextRetainDays: number) => patch({ contextRetainDays });

  const changePassword = async () => {
    if (newPw.length < 8) return Alert.alert("New password must be at least 8 characters");
    try {
      await api.changePassword(token, currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      Alert.alert("Password changed", "Other devices have been signed out.");
    } catch (err) {
      Alert.alert("Couldn't change password", (err as Error).message);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Section title="Account">
        <Text style={styles.meta}>{user.email}</Text>
        <Field label="Your name" value={name} onChangeText={setName} />
      </Section>

      <Section title="Assistant">
        <Field label="Assistant name" value={assistantName} onChangeText={setAssistantName} />
        <Field
          label="Personality"
          value={personality}
          onChangeText={setPersonality}
          multiline
          placeholder="e.g. Dry British wit, keeps answers brief"
        />
        <Button label={saving ? "Saving…" : "Save changes"} onPress={save} disabled={!dirty || saving} />
      </Section>

      <Section title="Voice">
        <VoicePicker token={token} />
      </Section>

      <Section title="How to start talking">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Always listen</Text>
            <Text style={styles.meta}>
              The microphone stays on and answers when you say its name. Off: double-click the band's button to talk.
              With it on, a double click turns it off.
            </Text>
          </View>
          <Switch
            value={alwaysListen}
            onValueChange={(on) =>
              on
                ? Alert.alert(
                    "Always listen?",
                    "The microphone stays on, even in the background, and hears everything around you, including other people. Turn it off here, from the Assistant tab, or with a double click on the band.",
                    [
                      { text: "Cancel", style: "cancel" },
                      { text: "Turn on", style: "destructive", onPress: () => setAlwaysListen(true) },
                    ],
                  )
                : setAlwaysListen(false)
            }
            trackColor={{ true: colors.danger, false: colors.border }}
          />
        </View>
        <View style={styles.segment}>
          {LISTEN_MODES.map((m) => (
            <Pressable
              key={m.mode}
              onPress={() => setListenMode(m.mode)}
              style={[styles.segmentItem, listenMode === m.mode && styles.segmentOn]}
            >
              <Text style={[styles.segmentText, listenMode === m.mode && styles.segmentTextOn]}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.meta}>{LISTEN_MODES.find((m) => m.mode === listenMode)?.hint}</Text>
        <Text style={[styles.label, { marginTop: 18 }]}>Microphone</Text>
        <View style={styles.segment}>
          {MIC_SOURCES.map((m) => (
            <Pressable
              key={m.source}
              onPress={() => setMicSource(m.source)}
              style={[styles.segmentItem, micSource === m.source && styles.segmentOn]}
            >
              <Text style={[styles.segmentText, micSource === m.source && styles.segmentTextOn]}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.meta}>{MIC_SOURCES.find((m) => m.source === micSource)?.hint}</Text>
      </Section>

      <Section title="Google accounts">
        <GoogleConnection token={token} />
      </Section>

      <Section title="Siri">
        <SiriSetup token={token} />
      </Section>

      <Section title="Memory">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Remember things about me</Text>
            <Text style={styles.meta}>{assistantName || "Your assistant"} learns facts from your chats.</Text>
          </View>
          <Switch
            value={user.settings.memoryEnabled}
            onValueChange={toggleMemory}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>

        {memories === null ? (
          <ActivityIndicator color={colors.accent} />
        ) : memories.length === 0 ? (
          <Text style={styles.meta}>Nothing remembered yet.</Text>
        ) : (
          // Folded away by default: a few months of use is a long scroll between
          // the memory switch and everything under it.
          <>
            <Pressable style={styles.disclosure} onPress={() => setMemoriesOpen((open) => !open)} hitSlop={8}>
              <Text style={styles.label}>
                {memories.length} {memories.length === 1 ? "thing" : "things"} remembered
              </Text>
              <Text style={styles.chevron}>{memoriesOpen ? "▾" : "▸"}</Text>
            </Pressable>
            {memoriesOpen &&
              memories.map((m) => (
                <View key={m.id} style={styles.memory}>
                  <Text style={styles.memoryText}>{m.content}</Text>
                  <Pressable onPress={() => forget(m.id)} hitSlop={10}>
                    <Text style={styles.forget}>Forget</Text>
                  </Pressable>
                </View>
              ))}
          </>
        )}

        {!!memories?.length && memoriesOpen && (
          <Button
            label="Forget everything"
            danger
            onPress={() =>
              confirm("Forget everything?", "All remembered facts will be erased.", "Forget", async () => {
                await api.clearMemories(token);
                setMemories([]);
              })
            }
          />
        )}
        <Button
          label="Clear chat history"
          danger
          onPress={() =>
            confirm("Clear chat history?", "Your conversation will be deleted.", "Clear", () =>
              api.clearMessages(token),
            )
          }
        />
      </Section>

      <Section title="Password">
        <Field label="Current password" value={currentPw} onChangeText={setCurrentPw} secureTextEntry />
        <Field label="New password" value={newPw} onChangeText={setNewPw} secureTextEntry />
        <Button label="Change password" onPress={changePassword} disabled={!currentPw || !newPw} />
      </Section>

      <Section title="Your day">
        <LocationTimeline />
        <Button label="Transcripts — everything said" onPress={() => router.push("/transcripts" as Href)} />
        <Text style={styles.meta}>
          Wake and bed times, work hours, medications and routines. Going through it again adds to what's there; it
          doesn't remove anything.
        </Text>
        <Button
          label="Go through setup again"
          onPress={async () => {
            try {
              await api.onboardingRestart(token);
              setUser({ ...user!, onboarded: false });
            } catch (err) {
              Alert.alert("Couldn't start setup", err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </Section>

      <Section title="Something went wrong">
        <Text style={styles.meta}>
          Tell us what happened and the app sends what it was doing at the time. No passwords or sign-in details go
          with it.
        </Text>
        <Button label="Report a problem" onPress={() => router.push("/report-bug" as Href)} />
      </Section>

      <Section title="Developer">
        <Button label="Sensors, inputs & ES100" onPress={() => router.push("/dev-tools")} />
      </Section>

      <Section title="Session">
        <Button label="Sign out" onPress={signOut} />
      </Section>

      <Section title="Texts">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Send texts automatically</Text>
            <Text style={styles.meta}>
              Hands each text to your "{SEND_TEXT_SHORTCUT}" shortcut instead of opening Messages, so it goes
              without tapping Send. Your phone switches to Shortcuts for a moment and comes back.
            </Text>
          </View>
          <Switch value={autoSendTexts} onValueChange={toggleAutoSendTexts} trackColor={{ true: colors.accent, false: colors.border }} />
        </View>
        {autoSendTexts && (
          <Button label="Open Shortcuts" onPress={() => Linking.openURL("shortcuts://create-shortcut")} />
        )}
      </Section>

      <Section title="Background work">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Let {assistantName || "OVOA"} work on its own</Text>
            <Text style={styles.meta}>
              It checks things between conversations — what's actually on today, what you said you'd do — and tells you
              only when it's worth interrupting you. Everything it does is logged.
            </Text>
          </View>
          <Switch
            value={user.settings.agentEnabled}
            onValueChange={toggleAgent}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>

        {user.settings.agentEnabled && (
          <>
            {!!pushProblem && <Text style={[styles.meta, { color: colors.warning }]}>{pushProblem}</Text>}

            <Text style={styles.label}>How far it can go</Text>
            <View style={styles.segment}>
              {AUTONOMY.map((a) => (
                <Pressable
                  key={a.value}
                  onPress={() => setAutonomy(a.value)}
                  style={[styles.segmentItem, user.settings.agentAutonomy === a.value && styles.segmentOn]}
                >
                  <Text
                    style={[styles.segmentText, user.settings.agentAutonomy === a.value && styles.segmentTextOn]}
                  >
                    {a.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.meta}>{AUTONOMY.find((a) => a.value === user.settings.agentAutonomy)?.hint}</Text>
            <Text style={styles.meta}>
              At every level it can't send a message or email on its own, and can't delete anything. Those always wait
              for you.
            </Text>

            <Text style={[styles.label, { marginTop: 8 }]}>Don't disturb me between</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, { width: 80, textAlign: "center" }]}
                value={quiet.start}
                onChangeText={(v) => setQuiet((q) => ({ ...q, start: v }))}
                onBlur={saveQuiet}
                placeholder="22:00"
                placeholderTextColor={colors.textDim}
                keyboardType="numbers-and-punctuation"
              />
              <Text style={styles.meta}>and</Text>
              <TextInput
                style={[styles.input, { width: 80, textAlign: "center" }]}
                value={quiet.end}
                onChangeText={(v) => setQuiet((q) => ({ ...q, end: v }))}
                onBlur={saveQuiet}
                placeholder="07:00"
                placeholderTextColor={colors.textDim}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <Text style={styles.meta}>
              It still works during these hours; it just saves what it found until morning. Something about to be missed
              tonight comes through anyway.
            </Text>

            <Button label="What it's set up to do" onPress={() => router.push("/agent")} />
          </>
        )}
      </Section>

      <Section title="Timeline">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Keep a record of my days</Text>
            <Text style={styles.meta}>
              What you record gets summarised into a day {assistantName || "OVOA"} can look things up in — "what did I
              do Tuesday", "did I ever call Sarah back". Only ever what you chose to record: nothing is captured in the
              background.
            </Text>
          </View>
          <Switch
            value={user.settings.contextEnabled}
            onValueChange={toggleContext}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>
        {user.settings.contextEnabled && (
          <>
            <Text style={styles.meta}>
              The words themselves are never stored on the server. They're read once to write the summary and then
              dropped; the recordings stay on this phone.
            </Text>
            <Text style={styles.label}>Forget summaries after</Text>
            <View style={styles.segment}>
              {RETENTION.map((r) => (
                <Pressable
                  key={r.days}
                  onPress={() => setRetention(r.days)}
                  style={[styles.segmentItem, user.settings.contextRetainDays === r.days && styles.segmentOn]}
                >
                  <Text
                    style={[styles.segmentText, user.settings.contextRetainDays === r.days && styles.segmentTextOn]}
                  >
                    {r.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Button
              label="Forget the last hour"
              danger
              onPress={() =>
                confirm(
                  "Forget the last hour?",
                  "Everything recorded in the last hour is deleted, along with anything pulled out of it.",
                  "Forget",
                  async () => {
                    const { forgot } = await api.forgetSince(token, Date.now() - 3_600_000);
                    Alert.alert(forgot ? `Forgot ${forgot} ${forgot === 1 ? "moment" : "moments"}` : "Nothing to forget");
                  },
                )
              }
            />
          </>
        )}
      </Section>

      <Section title="Danger zone">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Approve for me</Text>
            <Text style={styles.meta}>
              Skip approval cards: {assistantName || "your assistant"} sends emails, deletes things, and changes your
              contacts, calendar, and reminders right away. iOS still asks you to tap Send for emails, and for texts unless "Send texts automatically" is on.
            </Text>
          </View>
          <Switch
            value={user.settings.autoApprove}
            onValueChange={toggleAutoApprove}
            trackColor={{ true: colors.danger, false: colors.border }}
          />
        </View>
        <Button
          label="Delete account"
          danger
          onPress={() =>
            confirm(
              "Delete your account?",
              "This permanently deletes your account, chats, and memories.",
              "Delete",
              async () => {
                await api.deleteAccount(token);
                await clear();
              },
            )
          }
        />
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, props.multiline && { minHeight: 80, textAlignVertical: "top" }]}
        placeholderTextColor={colors.textDim}
        autoCorrect={!props.secureTextEntry}
        autoCapitalize={props.secureTextEntry ? "none" : "sentences"}
        {...props}
      />
    </View>
  );
}

const AUTONOMY = [
  {
    value: "suggest" as const,
    label: "Suggest",
    hint: "It looks things up and tells you. Anything that would change something shows up as a card for you to approve.",
  },
  {
    value: "act" as const,
    label: "Act",
    hint: "It can also add calendar events, tasks and drafts on its own when they follow from what you asked for.",
  },
];

const RETENTION = [
  { days: 14, label: "2 weeks" },
  { days: 90, label: "3 months" },
  { days: 365, label: "A year" },
  { days: 0, label: "Keep" },
];

/** 450 to "07:30". */
const minutesToClock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "07:30" back to 450, or null if it isn't a time. */
function clockToMinutes(value: string) {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

const MIC_SOURCES = [
  { source: "phone", label: "Phone", hint: "The iPhone's microphone hears you. It answers as soon as you stop talking." },
  {
    source: "band",
    label: "ES100 band",
    hint: "The clip records what you say on its own microphone. Click to start, click again when you're done: the recording comes over Bluetooth, so the answer takes a few seconds longer. The phone's microphone stays off, and it stops on its own after a minute.",
  },
] as const;

const LISTEN_MODES = [
  { mode: "wake", label: "Wake word", hint: "Say the assistant's name while the Assistant tab is open." },
  {
    mode: "twist",
    label: "Clip click",
    hint: "Double-click the ES100's button: it buzzes and listens. Press once to send what you said; press once while it answers to cut it off. Works from other apps too.",
  },
] as const;

/**
 * The location timeline: off until turned on here, because it needs "Always"
 * location and keeps where they've been for 14 days (places for good).
 */
function LocationTimeline() {
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    timelinePref.get().then(setOn);
  }, []);
  const toggle = async (next: boolean) => {
    setProblem(null);
    if (!next) {
      await disableTimeline();
      return setOn(false);
    }
    const r = await enableTimeline();
    if (r.ok) setOn(true);
    else setProblem(r.reason);
  };
  return (
    <>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Location timeline</Text>
          <Text style={styles.meta}>
            Learns home, work and the places you go, so reminders can wait for where you'll be. Where you went is kept 14
            days; named places until you remove them.
          </Text>
        </View>
        <Switch value={on} onValueChange={toggle} trackColor={{ true: colors.accent, false: colors.border }} />
      </View>
      {problem && <Text style={[styles.meta, { color: colors.danger }]}>{problem}</Text>}
    </>
  );
}

function Button({
  label,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 }]}
    >
      <Text style={[styles.buttonText, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48, gap: 24 },
  section: { gap: 8 },
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
  label: { color: colors.text, fontSize: 15 },
  meta: { color: colors.textDim, fontSize: 13 },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  disclosure: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 },
  chevron: { color: colors.textDim, fontSize: 14 },
  memory: { flexDirection: "row", alignItems: "center", gap: 12 },
  memoryText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
  forget: { color: colors.danger, fontSize: 13 },
  button: { backgroundColor: colors.surfaceHigh, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  segment: { flexDirection: "row", backgroundColor: colors.surfaceHigh, borderRadius: 10, padding: 3, gap: 3 },
  segmentItem: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  segmentOn: { backgroundColor: colors.surface },
  segmentText: { color: colors.textDim, fontSize: 14, fontWeight: "600" },
  segmentTextOn: { color: colors.text },
});
