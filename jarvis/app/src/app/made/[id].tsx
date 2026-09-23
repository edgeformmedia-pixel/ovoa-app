import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalCard } from "../../components/ApprovalCard";
import { AppBlocks } from "../../components/AppBlocks";
import { Glimmer, PressScale, Rise } from "../../components/motion";
import { Btn, Empty, toneInk, toneWash, type IconName, type Tone } from "../../components/ui";
import { setOpenApp } from "../../lib/activeApp";
import { isNeedsPlan, type AppOp } from "../../lib/api";
import { useAssistant } from "../../lib/assistant";
import { useSession } from "../../lib/auth";
import { cue } from "../../lib/cues";
import { devlog, logFail } from "../../lib/devlog";
import { useDictation } from "../../lib/dictation";
import { myApps, useMyApp } from "../../lib/myApps";
import { usePlan } from "../../lib/plan";
import { colors, radius, space, type } from "../../lib/theme";
import { createSpeaker } from "../../lib/voice";

// A made app, on a screen of its own.
//
// It looks like its own app: its icon and colour across the top, the parts it
// was built with (buttons, a checklist, a counter…) under that, and a box at
// the bottom to ask it anything, typed or said. What it answers shows here and,
// if the app is set to, is read aloud. OVOA can change what's on the screen
// while answering ("add milk" puts milk on the list), so the screen is read
// again after every answer.
//
// Edit (top right) changes anything about it: name, look, parts, and how it
// behaves. "Hands-free in Talk" opens it the old way, for a conversation.

type Exchange = { you: string; reply: string | null; failed?: boolean };

export default function MadeApp() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { token } = useSession();
  const { can } = usePlan();
  const a = useAssistant();
  const app = useMyApp(token, id);
  const [text, setText] = useState("");
  const [talk, setTalk] = useState<Exchange[]>([]);
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const scroll = useRef<ScrollView>(null);

  // Read aloud in the app's voice, with Talk's microphone held off so it can't hear itself.
  const speaker = useRef(createSpeaker(token));
  const stopSpeaking = () => {
    speaker.current.stop();
    setSpeaking(false);
  };
  useEffect(() => () => speaker.current.stop(), []);

  const dictation = useDictation(token, (said) => void ask(said));

  // What's on the screen can change without a tap here: OVOA's app_update, or another phone.
  useEffect(() => {
    void myApps.refresh(token).catch(logFail("made app: refresh"));
  }, [token, id]);

  if (app === undefined) return <View style={[styles.page, { paddingTop: insets.top }]} />;
  if (app === null) {
    return (
      <View style={[styles.page, { paddingTop: insets.top + space.s6, paddingHorizontal: space.s4 }]}>
        <Empty
          icon="apps-outline"
          title="This app is gone"
          body="It was deleted, maybe on another phone."
          action={{
            label: "Back to Apps",
            onPress: () => router.navigate("/apps" as Href),
          }}
        />
      </View>
    );
  }

  const tone = app.tone as Tone;
  const ink = toneInk(tone);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || thinking || !app) return;
    if (!can.chat) {
      Alert.alert("Asking needs a plan", "Your lists, counters and logs still work. Asking OVOA comes with the Base and Pro plans.");
      return;
    }
    stopSpeaking();
    setText("");
    setThinking(true);
    setTalk((t) => [...t, { you: q, reply: null }].slice(-6));
    cue("sent", { sound: false });
    let reply: string | null = null;
    let failed = false;
    try {
      reply = await a.askInApp(q, app.id);
      if (reply === null) {
        failed = true;
        reply = "OVOA is in the middle of something else. Try again in a moment.";
      }
    } catch (err) {
      failed = true;
      reply = isNeedsPlan(err) ? err.message : `That didn't go through: ${err instanceof Error ? err.message : String(err)}`;
      devlog("err", "made app: ask failed", err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
    }
    setTalk((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, reply, failed } : x)));
    // OVOA may have changed the list or the counter while answering.
    void myApps.refresh(token).catch(logFail("made app: refresh after a reply"));
    if (!failed && reply && app.speak && can.voice) {
      setSpeaking(true);
      await a
        .hold(() => speaker.current.speak(reply!, { filler: false }))
        .catch(logFail("made app: speaking"))
        .finally(() => setSpeaking(false));
    }
  }

  const change = (op: AppOp) =>
    myApps.change(token, app.id, op).catch((err) => Alert.alert("Couldn't save that", err instanceof Error ? err.message : String(err)));

  const handsFree = () => {
    setOpenApp({ id: app.id, name: app.name, opener: app.opener });
    router.navigate("/chat");
  };

  const back = () => (router.canGoBack() ? router.back() : router.navigate("/apps" as Href));
  const last = talk[talk.length - 1];

  return (
    <View style={styles.page}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: space.s6 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Its own colour, its own icon: this is the app, not a page of OVOA's. */}
          <View
            style={[
              styles.hero,
              {
                backgroundColor: toneWash(tone),
                paddingTop: insets.top + space.s2,
              },
            ]}
          >
            <View style={styles.bar}>
              <Pressable onPress={back} hitSlop={10} style={styles.barBtn} accessibilityRole="button" accessibilityLabel="Back">
                <Ionicons name="chevron-back" size={24} color={colors.ink} />
              </Pressable>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/made/edit",
                    params: { id: app.id },
                  } as unknown as Href)
                }
                hitSlop={10}
                style={[styles.editBtn, { borderColor: ink }]}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${app.name}`}
              >
                <Ionicons name="options-outline" size={16} color={ink} />
                <Text style={[styles.editText, { color: ink }]}>Edit</Text>
              </Pressable>
            </View>
            <Rise>
              <View style={styles.identity}>
                {/* White, so it stands off the app's own colour behind it. */}
                <View style={styles.icon}>
                  <Ionicons name={app.icon as IconName} size={36} color={ink} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={2}>
                    {app.name}
                  </Text>
                  <Text style={styles.about}>{app.about}</Text>
                </View>
              </View>
            </Rise>
          </View>

          <View style={styles.body}>
            {/* The conversation, short: what it said last, so the screen stays the app. */}
            <View style={styles.answer}>
              {!talk.length ? (
                <Text style={styles.opener}>
                  {app.opener || `Ask ${app.name} anything${app.blocks.some((b) => b.kind === "buttons") ? ", or tap a button below" : ""}.`}
                </Text>
              ) : (
                <>
                  <Text style={styles.you} numberOfLines={3}>
                    {last.you}
                  </Text>
                  {last.reply === null ? (
                    <Glimmer text={a.status ?? "Thinking…"} style={{ color: ink }} />
                  ) : (
                    <Text style={[styles.reply, last.failed && { color: colors.stop }]}>{last.reply}</Text>
                  )}
                </>
              )}
              {speaking && (
                <Pressable
                  onPress={stopSpeaking}
                  hitSlop={8}
                  style={styles.stopRow}
                  accessibilityRole="button"
                  accessibilityLabel="Stop reading"
                >
                  <Ionicons name="volume-high" size={16} color={ink} />
                  <Text style={[styles.stopText, { color: ink }]}>Reading it out · tap to stop</Text>
                </Pressable>
              )}
              {talk.length > 1 && (
                <Pressable onPress={() => setTalk([])} hitSlop={8} style={{ alignSelf: "flex-start", marginTop: space.s2 }}>
                  <Text style={styles.clear}>Clear</Text>
                </Pressable>
              )}
            </View>

            {(a.approvals.length > 0 || a.autoRunning) && (
              <View style={{ gap: space.s2 }}>
                {a.autoRunning && <Text style={styles.clear}>Doing it for you…</Text>}
                {a.approvals.map((action) => (
                  <ApprovalCard
                    key={action.id}
                    action={action}
                    onApprove={(approval) => a.approve(action, approval)}
                    onCancel={() => a.cancel(action.id)}
                  />
                ))}
              </View>
            )}

            {app.blocks.length ? (
              <AppBlocks blocks={app.blocks} state={app.state} tone={tone} busy={thinking} onAsk={(p) => void ask(p)} onChange={change} />
            ) : (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/made/edit",
                    params: { id: app.id },
                  } as unknown as Href)
                }
                style={styles.addParts}
              >
                <Ionicons name="add-circle-outline" size={20} color={ink} />
                <Text style={[styles.addPartsText, { color: ink }]}>Give it buttons, a checklist or a counter</Text>
              </Pressable>
            )}

            <Btn label="Hands-free in Talk" kind="quiet" onPress={handsFree} style={{ alignSelf: "center" }} />
          </View>
        </ScrollView>

        {/* Ask it: typed, or the microphone for one sentence. */}
        <View style={[styles.askBar, { paddingBottom: Math.max(insets.bottom, space.s2) }]}>
          {dictation.listening ? (
            <View style={[styles.askInput, styles.listening]}>
              <Text style={[styles.heard, { color: ink }]} numberOfLines={2}>
                {dictation.words || "Listening…"}
              </Text>
            </View>
          ) : (
            <TextInput
              style={styles.askInput}
              value={text}
              onChangeText={setText}
              placeholder={`Ask ${app.name}…`}
              placeholderTextColor={colors.inkMute}
              onSubmitEditing={() => void ask(text)}
              returnKeyType="send"
              submitBehavior="submit"
              editable={!thinking}
              textContentType="none"
              autoComplete="off"
              importantForAutofill="no"
            />
          )}
          {text.trim() && !dictation.listening ? (
            <PressScale
              sink={0.9}
              onPress={() => void ask(text)}
              disabled={thinking}
              style={[styles.round, { backgroundColor: ink }]}
              accessibilityRole="button"
              accessibilityLabel="Send"
            >
              <Ionicons name="arrow-up" size={20} color={colors.paper} />
            </PressScale>
          ) : (
            <PressScale
              sink={0.9}
              onPress={() => (dictation.listening ? dictation.stop() : void dictation.start())}
              disabled={thinking}
              style={[styles.round, { backgroundColor: dictation.listening ? ink : toneWash(tone) }]}
              accessibilityRole="button"
              accessibilityLabel={dictation.listening ? "Stop listening" : `Say it to ${app.name}`}
            >
              <Ionicons name={dictation.listening ? "stop" : "mic"} size={20} color={dictation.listening ? colors.paper : ink} />
            </PressScale>
          )}
        </View>
        {!!dictation.error && <Text style={styles.error}>{dictation.error}</Text>}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  hero: {
    paddingHorizontal: space.s4,
    paddingBottom: space.s5,
    borderBottomLeftRadius: radius.sheet,
    borderBottomRightRadius: radius.sheet,
  },
  bar: { flexDirection: "row", alignItems: "center", paddingBottom: space.s3 },
  barBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
  },
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1.5,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.paper,
  },
  editText: { fontSize: 15, fontWeight: "600" },
  icon: { width: 64, height: 64, borderRadius: 20, backgroundColor: colors.paper, alignItems: "center", justifyContent: "center" },
  identity: { flexDirection: "row", alignItems: "center", gap: space.s4 },
  name: { ...type.title, color: colors.ink },
  about: { ...type.sub, color: colors.inkDim },

  body: { paddingHorizontal: space.s4, paddingTop: space.s4, gap: space.s3 },
  answer: {
    backgroundColor: colors.wash,
    borderRadius: radius.tile,
    padding: space.s4,
    gap: space.s2,
  },
  opener: { ...type.body, color: colors.ink },
  you: { ...type.meta, color: colors.inkMute },
  reply: { ...type.sub, color: colors.ink },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: space.s1,
  },
  stopText: { ...type.meta, fontWeight: "600" },
  clear: { ...type.meta, color: colors.inkMute, fontWeight: "600" },
  addParts: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s2,
    padding: space.s4,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.line,
  },
  addPartsText: { ...type.sub, fontWeight: "600" },

  askBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.s2,
    paddingHorizontal: space.s4,
    paddingTop: space.s2,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
  },
  askInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    borderRadius: 22,
    backgroundColor: colors.wash,
    paddingHorizontal: space.s4,
    paddingVertical: 11,
    color: colors.ink,
    fontSize: 16,
    justifyContent: "center",
  },
  listening: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.line,
  },
  heard: { fontSize: 16, lineHeight: 21 },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    ...type.meta,
    color: colors.stop,
    textAlign: "center",
    paddingBottom: space.s2,
  },
});
