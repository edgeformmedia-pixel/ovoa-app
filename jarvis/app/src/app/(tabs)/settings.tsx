import { useRouter } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { api, type Memory } from "../../lib/api";
import { useAssistant } from "../../lib/assistant";
import { useSession } from "../../lib/auth";
import { colors } from "../../lib/theme";

export default function Settings() {
  const router = useRouter();
  const { token, user, setUser, signOut, clear } = useSession();
  const [name, setName] = useState(user?.name ?? "");
  const [assistantName, setAssistantName] = useState(user?.settings.assistantName ?? "");
  const [personality, setPersonality] = useState(user?.settings.personality ?? "");
  const [saving, setSaving] = useState(false);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const { alwaysListen, setAlwaysListen, listenMode, setListenMode } = useAssistant();

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

  const toggleAlwaysListen = (on: boolean) => {
    if (!on) return setAlwaysListen(false);
    Alert.alert(
      "Always listen?",
      `The microphone stays on, even with OVOA in the background or the phone locked. Everything it hears, including TV and other people, is transcribed live, but ${assistantName || "your assistant"} only answers when you say its name (or reply right after it speaks). Say its name over a reply, or "stop", to interrupt.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn on", style: "destructive", onPress: () => setAlwaysListen(true) },
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
        {listenMode !== "wake" && (
          <Button label="Calibrate the twist" onPress={() => router.push("/dev-tools")} />
        )}
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
          memories.map((m) => (
            <View key={m.id} style={styles.memory}>
              <Text style={styles.memoryText}>{m.content}</Text>
              <Pressable onPress={() => forget(m.id)} hitSlop={10}>
                <Text style={styles.forget}>Forget</Text>
              </Pressable>
            </View>
          ))
        )}

        {!!memories?.length && (
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

      <Section title="Developer">
        <Button label="Sensors, inputs & ES100" onPress={() => router.push("/dev-tools")} />
      </Section>

      <Section title="Session">
        <Button label="Sign out" onPress={signOut} />
      </Section>

      <Section title="Danger zone">
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Approve for me</Text>
            <Text style={styles.meta}>
              Skip approval cards: {assistantName || "your assistant"} sends emails, deletes things, and changes your
              contacts, calendar, and reminders right away. iOS still asks you to tap Send for texts and emails.
            </Text>
          </View>
          <Switch
            value={user.settings.autoApprove}
            onValueChange={toggleAutoApprove}
            trackColor={{ true: colors.danger, false: colors.border }}
          />
        </View>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Always listen</Text>
            <Text style={styles.meta}>
              The microphone stays on, even in the background or with the phone locked. It only answers when you
              talk to it: say its name, ask something, or reply to it. Talk over a reply to interrupt.
            </Text>
          </View>
          <Switch
            value={alwaysListen}
            onValueChange={toggleAlwaysListen}
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

const LISTEN_MODES = [
  { mode: "wake", label: "Wake word", hint: "Say the assistant's name. Turn on Always listen (Danger zone) to use it from any screen." },
  {
    mode: "twist",
    label: "Twist",
    hint: "Flick your left wrist counter-clockwise with the ES100 on; it buzzes and listens. The microphone stays off until then. Without motion data from the clip, its button does the same.",
  },
  { mode: "both", label: "Both", hint: "Always listen for the name, and a twist also gets its attention." },
] as const;

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
