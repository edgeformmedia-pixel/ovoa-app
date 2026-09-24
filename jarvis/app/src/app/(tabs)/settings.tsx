import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter, type Href } from "expo-router";
import { logFail } from "../../lib/devlog";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  LayoutAnimation,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AccountSection } from "../../components/AccountSection";
import { LockedLine } from "../../components/Plan";
import { SiriSetup } from "../../components/SiriSetup";
import { VoicePicker } from "../../components/VoicePicker";
import { Btn, IconTile, Screen, Toggle, TopBar, type IconName, type Tone } from "../../components/ui";
import { api, type Autonomy, type Memory, type SetupView } from "../../lib/api";
import { setupAgain } from "../../lib/setupScreen";
import { disableTimeline, enableTimeline, timelinePref } from "../../lib/location";
import { useAgent } from "../../lib/agent";
import { useAssistant } from "../../lib/assistant";
import { usePhoneEar } from "../../lib/liveListen";
import { useSession } from "../../lib/auth";
import { devModePref, useDevMode } from "../../lib/devMode";
import { usePlan } from "../../lib/plan";
import { tourPref } from "../../lib/tour";
import { soundsPref, useSoundsOn } from "../../lib/cues";
import { autoSendTextsPref, SEND_TEXT_SHORTCUT } from "../../lib/storage";
import { colors, space, type } from "../../lib/theme";

export default function Settings() {
  const router = useRouter();
  const { token, user, setUser } = useSession();
  const [assistantName, setAssistantName] = useState(user?.settings.assistantName ?? "");
  const [personality, setPersonality] = useState(user?.settings.personality ?? "");
  const [saving, setSaving] = useState(false);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [setup, setSetup] = useState<SetupView | null>(null);
  const [autoSendTexts, setAutoSendTexts] = useState(false);
  const { listenMode, setListenMode, micSource, setMicSource, alwaysListen, setAlwaysListen } = useAssistant();
  const { pushProblem } = useAgent();
  // The free plan has no assistant, so its settings aren't shown at all. Every
  // one of them comes with Base (Pro is only more usage), so the locked lines
  // below ("For Base users") show only where the plan's features say otherwise,
  // as a server from before v1 still does for the wake word and background work.
  const { free, can, needsConsent } = usePlan();
  // Always listen runs on the phone's own recogniser or not at all (decision 1).
  const phoneEar = usePhoneEar();
  const devMode = useDevMode();
  const soundsOn = useSoundsOn();
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
    if (free) return;
    api.memories(token).then((r) => setMemories(r.memories)).catch(() => setMemories([]));
  }, [token, free]);

  // How setup ended, for Your day's button: one they stopped is finished, not
  // gone through again. No model call; before consent it isn't asked (the
  // phone stops every /onboarding request then, lib/api.ts lockedOnPhone).
  useEffect(() => {
    if (free || needsConsent) return;
    api.setupState(token).then((r) => setSetup(r.setup)).catch(logFail("settings: api.setupState"));
  }, [token, free, needsConsent]);
  const again = setupAgain(setup);

  if (!user) return null; // signing out

  const dirty =
    assistantName.trim() !== user.settings.assistantName ||
    personality.trim() !== user.settings.personality;

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.updateMe(token, {
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
      "Only what you record. Each recording is summarised, and its words and summary are kept on OVOA's server until you delete them. Everything else about your day is deleted after 14 days, apart from a short summary of each day. Nothing is captured in the background, ever.",
      [
        { text: "Not now", style: "cancel" },
        { text: "Turn on", onPress: () => patch({ contextEnabled: true }) },
      ],
    );
  };

  // Four groups that open and close (2026-09-24): the page had grown into one
  // long scroll of everything. Account is open to begin with; the rest wait to
  // be tapped. Everything the assistant does is under Assistant, what's kept
  // about you under Privacy & data, and the rest under App & help.
  return (
    <View style={styles.page}>
      <TopBar title="Settings" />
      <Screen keyboardShouldPersistTaps="handled">
      <Group title="Account" icon="person-circle-outline" tone="blue" startOpen>
        {/* Plan, email, name, password, Google accounts, and the ways out. */}
        <AccountSection google={!free} />
      </Group>

      {!free && (
      <Group title="Assistant" icon="sparkles-outline" tone="violet">
        <Sub>Name and personality</Sub>
        <Field label="Assistant name" value={assistantName} onChangeText={setAssistantName} />
        <Field
          label="Personality"
          value={personality}
          onChangeText={setPersonality}
          multiline
          placeholder="e.g. Dry British wit, keeps answers brief"
        />
        <Button label={saving ? "Saving…" : "Save changes"} onPress={save} disabled={!dirty || saving} />

        <Sub>Voice</Sub>
        <VoicePicker token={token} />

        <Sub>How to start talking</Sub>
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
        <About>
          {listenMode === "wake" && !can.wake
            ? needsConsent
              ? "Saying its name to start works once you've agreed to AI, under Privacy & data."
              : "Saying its name to start is for Base users. For now, tap the orb on Talk and speak."
            : LISTEN_MODES.find((m) => m.mode === listenMode)?.hint}
        </About>
        <Text style={[styles.label, { marginTop: 8 }]}>Microphone</Text>
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
        <About>{MIC_SOURCES.find((m) => m.source === micSource)?.hint}</About>
        {!can.wake ? (
          <LockedLine
            label="Always listen"
            what="The microphone stays on day and night, and answers when you say its name."
          />
        ) : !phoneEar.available ? (
          phoneEar.checked && (
            <View style={{ gap: 2 }}>
              <Text style={styles.label}>Always listen</Text>
              <Text style={styles.meta}>
                Not on this iPhone: it can't recognise speech on its own, and OVOA never sends a room's sound anywhere to listen for its name.
              </Text>
            </View>
          )
        ) : (
          <Setting
            label="Always listen"
            about={`The microphone stays on day and night, on every screen and with the app in the background, and answers when you say "${assistantName || "OVOA"}". Your iPhone listens for the name itself: nothing you or anyone else says leaves the phone until the name is heard. While the microphone is on, the band's light stays on. Turn it off here, from the Talk tab, or with a double click on the band.`}
          >
            <Toggle
              value={alwaysListen}
              onValueChange={(on) =>
                on
                  ? Alert.alert(
                      "Always listen?",
                      `The microphone stays on day and night, even with the app in the background, and hears everyone around you. Your iPhone listens for "${assistantName || "OVOA"}" on its own; nothing is sent until it hears the name. The band's light stays on while it listens.`,
                      [
                        { text: "Cancel", style: "cancel" },
                        { text: "Turn on", style: "destructive", onPress: () => setAlwaysListen(true) },
                      ],
                    )
                  : setAlwaysListen(false)
              }
            />
          </Setting>
        )}

        <Sub>What it can do for you</Sub>
        <Setting
          label="Approve for me"
          about={`Skip approval cards: ${assistantName || "your assistant"} sends emails, deletes things, and changes your contacts, calendar, and reminders right away. iOS still asks you to tap Send for emails, and for texts unless "Send texts automatically" is on.`}
        >
          <Toggle value={user.settings.autoApprove} onValueChange={toggleAutoApprove} />
        </Setting>
        <Setting
          label="Send texts automatically"
          about={`Hands each text to your "${SEND_TEXT_SHORTCUT}" shortcut instead of opening Messages, so it goes without tapping Send. Your phone switches to Shortcuts for a moment and comes back.`}
        >
          <Toggle value={autoSendTexts} onValueChange={toggleAutoSendTexts} />
        </Setting>
        {autoSendTexts && <Button label="Open Shortcuts" onPress={() => Linking.openURL("shortcuts://create-shortcut")} />}
        <SiriSetup token={token} />

        <Sub>Background work</Sub>
        {!can.agent ? (
          <LockedLine
            label={`Let ${assistantName || "OVOA"} work on its own`}
            what="It checks things between conversations and tells you only when it's worth interrupting you."
          />
        ) : (
          <>
            <Setting
              label={`Let ${assistantName || "OVOA"} work on its own`}
              about="It checks things between conversations — what's actually on today, what you said you'd do — and tells you only when it's worth interrupting you. Everything it does is logged."
            >
              <Toggle value={user.settings.agentEnabled} onValueChange={toggleAgent} />
            </Setting>

            {user.settings.agentEnabled && (
              <>
                {!!pushProblem && <Text style={[styles.meta, { color: colors.late }]}>{pushProblem}</Text>}

                <Text style={styles.label}>How far it can go</Text>
                <View style={styles.segment}>
                  {AUTONOMY.map((a) => (
                    <Pressable
                      key={a.value}
                      onPress={() => setAutonomy(a.value)}
                      style={[styles.segmentItem, user.settings.agentAutonomy === a.value && styles.segmentOn]}
                    >
                      <Text style={[styles.segmentText, user.settings.agentAutonomy === a.value && styles.segmentTextOn]}>
                        {a.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <About>
                  {AUTONOMY.find((a) => a.value === user.settings.agentAutonomy)?.hint} At every level it can't send a message
                  or email on its own, and can't delete anything. Those always wait for you.
                </About>

                <Text style={[styles.label, { marginTop: 8 }]}>Don't disturb me between</Text>
                <View style={styles.row}>
                  <TextInput
                    style={[styles.input, { width: 80, textAlign: "center" }]}
                    value={quiet.start}
                    onChangeText={(v) => setQuiet((q) => ({ ...q, start: v }))}
                    onBlur={saveQuiet}
                    placeholder="22:00"
                    placeholderTextColor={colors.inkMute}
                    keyboardType="numbers-and-punctuation"
                  />
                  <Text style={styles.meta}>and</Text>
                  <TextInput
                    style={[styles.input, { width: 80, textAlign: "center" }]}
                    value={quiet.end}
                    onChangeText={(v) => setQuiet((q) => ({ ...q, end: v }))}
                    onBlur={saveQuiet}
                    placeholder="07:00"
                    placeholderTextColor={colors.inkMute}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <About>
                  It still works during these hours; it just saves what it found until morning. Something about to be missed
                  tonight comes through anyway.
                </About>

                <Button label="What it's set up to do" onPress={() => router.push("/agent")} />
              </>
            )}
          </>
        )}

        <Sub>Setup</Sub>
        <About>{again.about}</About>
        <Button
          label={again.label}
          onPress={async () => {
            try {
              await api.onboardingRestart(token);
              setUser({ ...user!, onboarded: false });
            } catch (err) {
              Alert.alert("Couldn't start setup", err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </Group>
      )}

      {!free && (
      <Group title="Privacy & data" icon="lock-closed-outline" tone="green">
        {/* Whether they've agreed to AI, what that covers, and the way to take it back (app/consent.tsx). */}
        <Sub>AI and your data</Sub>
        <About>
          {needsConsent
            ? "You haven't agreed yet, so OVOA doesn't send anything to an AI company, and talking to it is off until you do."
            : "You've agreed: what you say, and what's needed to answer it, goes to the AI companies that write OVOA's replies and voice them."}
        </About>
        <Button label={needsConsent ? "Review and agree" : "What goes where"} onPress={() => router.push("/consent" as Href)} />

        <Sub>Memory</Sub>
        <Setting
          label="Remember things about me"
          about={`${assistantName || "Your assistant"} learns facts from your chats and forgets them after 14 days, unless you asked it to remember them ("remember that I'm vegan").`}
        >
          <Toggle value={user.settings.memoryEnabled} onValueChange={toggleMemory} />
        </Setting>
        {memories === null ? (
          <ActivityIndicator color={colors.now} />
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

        <Sub>Your days</Sub>
        <Setting
          label="Keep a record of my days"
          about={`What you record gets summarised into a day ${assistantName || "OVOA"} can look things up in — "what did I do Tuesday", "did I ever call Sarah back". Only ever what you chose to record: nothing is captured in the background. A recording's words and summary are kept on OVOA's server until you delete them, and the audio stays on this phone. Everything else about your day is deleted after 14 days, apart from a short summary of each day.`}
        >
          <Toggle value={user.settings.contextEnabled} onValueChange={toggleContext} />
        </Setting>
        {user.settings.contextEnabled && (
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
        )}
        <LocationTimeline />
        <Button label="Transcripts — everything said" onPress={() => router.push("/transcripts" as Href)} />

        <Sub>Chat history</Sub>
        <Button
          label="Clear chat history"
          danger
          onPress={() =>
            confirm("Clear chat history?", "Your conversation will be deleted.", "Clear", () => api.clearMessages(token))
          }
        />
      </Group>
      )}

      <Group title="App & help" icon="help-buoy-outline" tone="amber">
        <Setting
          label="Sound effects"
          about="Soft glass chimes when OVOA starts listening, when it's done something, when it needs you and when something goes wrong. The taps you feel stay on either way."
        >
          <Toggle value={soundsOn} onValueChange={(on) => void soundsPref.set(on)} />
        </Setting>

        <Sub>Getting around</Sub>
        <About>
          The menu is Talk and Apps, the apps you have added, and Settings at the bottom. The tour walks through it again.
        </About>
        <Button label="Show the tour again" onPress={() => void tourPref.replay()} />

        <Sub>Something went wrong</Sub>
        <About>
          Tell us what happened and the app sends what it was doing at the time. No passwords or sign-in details go with it.
        </About>
        <Button label="Report a problem" onPress={() => router.push("/report-bug" as Href)} />

        <Sub>Legal</Sub>
        <Button label="Terms of Service" onPress={() => router.push("/terms" as Href)} />

        <Sub>Developer</Sub>
        <Setting
          label="Dev mode"
          about="Shows the developer's screens: Dev tools, the Logs panel on Talk, and the Developer group in the menu. Turn it off to see OVOA the way someone who just downloaded it would. It only changes this phone."
        >
          <Toggle value={devMode} onValueChange={(on) => void devModePref.set(on)} />
        </Setting>
        {devMode && <Button label="Sensors, inputs & OVOA Band" onPress={() => router.push("/dev-tools")} />}
      </Group>
      </Screen>
    </View>
  );
}

/**
 * A group of settings that opens and closes (2026-09-24): a row with its icon,
 * and under it, only once tapped, what's in it.
 */
function Group({
  title,
  icon,
  tone,
  startOpen = false,
  children,
}: {
  title: string;
  icon: IconName;
  tone: Tone;
  startOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <View style={styles.group}>
      <Pressable
        style={styles.groupHead}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen((o) => !o);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <IconTile name={icon} tone={tone} />
        <Text style={styles.groupTitle}>{title}</Text>
        <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={18} color={colors.inkMute} />
      </Pressable>
      {open && <View style={styles.groupBody}>{children}</View>}
    </View>
  );
}

/** A heading inside a group. */
function Sub({ children }: { children: ReactNode }) {
  return <Text style={styles.sub}>{children}</Text>;
}

/**
 * A setting by its name alone. What it does is folded away until the name is
 * tapped: a page of explanations is a long scroll to find one switch.
 */
function Setting({ label, about, children }: { label: string; about: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.row}>
      <Pressable
        style={{ flex: 1, gap: 4 }}
        onPress={() => setOpen((o) => !o)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityHint={open ? "Hides what this does" : "Shows what this does"}
      >
        <Text style={styles.label}>
          {label} <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        </Text>
        {open && <Text style={styles.meta}>{about}</Text>}
      </Pressable>
      {children}
    </View>
  );
}

/** An explanation with no switch of its own, folded away the same way. */
function About({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((o) => !o)} hitSlop={6} accessibilityRole="button" style={{ gap: 4 }}>
      <Text style={styles.chevron}>{open ? "What this does ▾" : "What this does ▸"}</Text>
      {open && <Text style={styles.meta}>{children}</Text>}
    </Pressable>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, props.multiline && { minHeight: 80, textAlignVertical: "top" }]}
        placeholderTextColor={colors.inkMute}
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
    label: "OVOA Band",
    hint: "The clip records what you say on its own microphone. Click to start, click again when you're done: the recording comes over Bluetooth, so the answer takes a few seconds longer. The phone's microphone stays off, and it stops on its own after a minute.",
  },
] as const;

const LISTEN_MODES = [
  { mode: "wake", label: "Wake word", hint: "Say the assistant's name while the Assistant tab is open." },
  {
    mode: "twist",
    label: "Clip click",
    hint: "Click the OVOA Band's button: it buzzes and listens. Click again to send what you said, or while it answers to cut it off. Works from other apps too, on an iPhone that recognises speech on its own.",
  },
] as const;

/**
 * The location timeline: off until turned on here, because it needs "Always"
 * location and keeps where they've been for 14 days (named places for good).
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
      <Setting
        label="Location timeline"
        about="Learns home, work and the places you go, so reminders can wait for where you'll be. Where you went is kept 14 days; named places until you remove them."
      >
        <Toggle value={on} onValueChange={toggle} />
      </Setting>
      {problem && <Text style={[styles.meta, { color: colors.stop }]}>{problem}</Text>}
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
    <Btn
      label={label}
      onPress={onPress}
      disabled={disabled}
      kind={danger ? "danger" : "plain"}
      style={{ alignSelf: "flex-start" }}
    />
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  // A group is a row that opens: its settings are a run of rows under it, not a box.
  group: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  groupHead: { flexDirection: "row", alignItems: "center", gap: space.s3, paddingVertical: space.s4 },
  groupTitle: { ...type.body, fontWeight: "600", color: colors.ink, flex: 1 },
  groupBody: { gap: space.s3, paddingBottom: space.s5 },
  sub: { ...type.meta, fontWeight: "600", color: colors.inkMute, marginTop: space.s3 },
  row: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  label: { ...type.body, color: colors.ink },
  meta: { ...type.meta, color: colors.inkMute },
  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },
  disclosure: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: space.s1 },
  chevron: { ...type.meta, color: colors.inkMute },
  memory: { flexDirection: "row", alignItems: "center", gap: space.s3 },
  memoryText: { flex: 1, ...type.sub, color: colors.ink },
  forget: { ...type.meta, fontWeight: "600", color: colors.stop },
  // Selection is ink, never teal: which option is picked is not urgency.
  segment: { flexDirection: "row", backgroundColor: colors.wash, borderRadius: 14, padding: 3, gap: 3 },
  segmentItem: { flex: 1, borderRadius: 11, paddingVertical: 9, alignItems: "center" },
  segmentOn: { backgroundColor: colors.paper },
  segmentText: { ...type.meta, fontWeight: "600", color: colors.inkMute },
  segmentTextOn: { color: colors.ink },
});
