import Ionicons from "@expo/vector-icons/Ionicons";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { Contact, ContactField, requestPermissionsAsync as requestContactsAccess } from "expo-contacts";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { OrbMode } from "../components/Orb";
import { OrbView } from "../components/OrbView";
import { Btn } from "../components/ui";
import { VoiceList } from "../components/VoicePicker";
import { installedAddons } from "../lib/addons";
import { api, isNeedsConsent, isNeedsPlan, type ServerSpeech, type SetupTurnResult, type SetupView } from "../lib/api";
import { useSession } from "../lib/auth";
import { devlog, logFail } from "../lib/devlog";
import { myApps } from "../lib/myApps";
import { syncRoutines } from "../lib/routines";
import {
  appsMade,
  appsMaking,
  contactAnswer,
  latestLine,
  newTurnId,
  soFar,
  turnLog,
  wantsContact,
  withoutReply,
  withSentence,
  type Line,
} from "../lib/setupScreen";
import { colors } from "../lib/theme";
import { createSpeaker, serverSpeech, useConversation } from "../lib/voice";

// Setup, as a phone call with OVOA that the AI leads (2026-09-23).
//
// The server gives the model a short list of things to find out (api/src/
// setup/objectives.ts: what to call them, their day, their goals, who to call
// in an emergency, and more if it comes up), and it covers them in its own
// words and its own order, asking whatever it likes. Not one line of what it
// says is written here or on the server: the old setup read nine fixed
// questions between a fixed greeting and goodbye, and felt like a form (the
// user quit it after two answers, device_logs 2026-09-23 20:27). Each turn is
// streamed and voiced the way a spoken Talk turn is (api/src/index.ts
// streamTurn): the same voice loop (useConversation) and the same server voice
// (serverSpeech), so OVOA starts talking as soon as its first sentence exists.
//
// On screen: OVOA's latest words, big; what it has understood so far, so a
// misheard value can be seen and said again; the conversation underneath; and
// buttons to type instead, skip what it's asking, or stop for now. Nothing
// counts down. While it asks who to call in an emergency, Choose from Contacts
// sends a contact's number as a typed answer: a number read out loud is the
// easiest thing in setup to mishear. When a turn fails, the screen says why and
// offers Try again; nothing is said out loud in its place.
//
// It comes the first time someone has Base, after they've agreed to AI
// (app/consent.tsx; app/_layout.tsx puts the steps in order), and starts with
// picking OVOA's voice, the current one ticked, before the call rings. Each goal
// gets an app, made in the background (api/src/setup/turn.ts), which this
// screen reads into the list of apps; an eating goal turns on Calorie. Later
// stops without a word, and Settings offers to finish it. The tour follows, if
// it hasn't been seen (components/Tour.tsx).

/** A failed request, and how to send it again. */
type Failure = { message: string; retry: () => void };

type TurnBody = Parameters<typeof api.setupTurn>[1];

/** After setup ends with an app still being made, the list of apps is read again this much later. */
const APP_CHECKS_MS = [20_000, 60_000];

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function Onboarding() {
  const { token, user, setUser } = useSession();
  const [setup, setSetup] = useState<SetupView | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  /** A turn outside the voice loop (the opener, Skip, a typed answer): waiting for its words, or saying them. */
  const [introPhase, setIntroPhase] = useState<"thinking" | "speaking" | null>(null);
  const [calling, setCallingState] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Why Choose from Contacts didn't send anything. */
  const [contactNote, setContactNote] = useState<string | null>(null);
  /** Setup is over or put off, and the app is about to move on. */
  const [leaving, setLeaving] = useState(false);
  /** Picking the voice comes first, on a setup that's starting from the beginning. */
  const [pickingVoice, setPickingVoice] = useState(false);
  // Read from the voice loop's callback, which keeps the render it was made in.
  const callingRef = useRef(false);
  const typingRef = useRef(false);
  typingRef.current = typing;
  const setupRef = useRef<SetupView | null>(null);
  const leavingRef = useRef(false);
  const cancelledRef = useRef(false);
  /** The turn outside the loop that's running, so Later (or leaving the screen) can drop it. */
  const introAbort = useRef<AbortController | null>(null);
  /**
   * What happens once the loop's reply has been heard: setup is over (the
   * goodbye was that reply), or a turn failed and the call waits for Try
   * again or Later. The loop only listens again after the reply has played
   * (voice.ts runLive), so the effect below acts when it does.
   */
  const afterReply = useRef<"finish" | "pause" | null>(null);
  /**
   * A spoken answer is on its way to the server (answer below, start to end).
   * Ending the loop then drops the request on the phone while the server still
   * finishes and stores the turn: its reply was never shown, the screen kept
   * the question before it, and a Skip then declined whatever that one asked
   * (2026-09-23 review). Skip, Contacts and Try again wait for it.
   */
  const [answering, setAnsweringState] = useState(false);
  const answeringRef = useRef(false);
  /** Type was pressed while an answer was on its way: the loop ends once its reply is in (the effect below). */
  const typedMidTurn = useRef(false);
  const madeRef = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const assistant = user?.settings.assistantName ?? "OVOA";

  const setCalling = (on: boolean) => {
    callingRef.current = on;
    setCallingState(on);
  };

  const setAnswering = (on: boolean) => {
    answeringRef.current = on;
    setAnsweringState(on);
  };

  /** Where setup is now, and what it set up besides the profile: apps made for goals, and Calorie for an eating one. */
  const show = (view: SetupView) => {
    setupRef.current = view;
    setSetup(view);
    if (view.addons.includes("calorie")) void installedAddons.install("calorie");
    const made = appsMade(view);
    if (made > madeRef.current) void myApps.refresh(token).catch(logFail("onboarding: reading the apps it made"));
    madeRef.current = made;
  };

  const shown = (res: SetupTurnResult) => {
    show(res.setup);
    devlog("log", turnLog(res));
  };

  /**
   * Try again: the same request once more, with the same turnId, so a turn the
   * server did finish is only replayed. What its reply got as far as saying
   * goes first, or the retry's words would be added to it.
   */
  const retryOf = (body: TurnBody) => () => {
    setLines((l) => withoutReply(l, body.turnId));
    void viaIntro(body);
  };

  /**
   * A turn that didn't get through: why, on screen, and Try again. A plan or
   * consent refusal isn't one: the steps in _layout.tsx move on by themselves.
   * No AI reachable is the server's own words, already said and on screen:
   * only Try again is added.
   */
  const failed = (why: unknown, body: TurnBody) => {
    if (isNeedsPlan(why) || isNeedsConsent(why)) return;
    devlog("err", "setup: a turn failed", messageOf(why));
    setFailure({ message: messageOf(why), retry: retryOf(body) });
  };
  const unreachable = (body: TurnBody) => {
    devlog("warn", "setup: no AI engine answered");
    setFailure({ message: "", retry: retryOf(body) });
  };

  /**
   * One answer, spoken, from the voice loop: sent, and the reply streamed into
   * its bubble as the loop voices it (`onSentence`, and the server's audio
   * through `extra.speech`, as a Talk turn does).
   */
  const answer = async (
    said: string,
    _addressed: boolean,
    onSentence?: (sentence: string) => void,
    signal?: AbortSignal,
    extra?: { speech?: ServerSpeech },
  ): Promise<string | null> => {
    // Setup is over and its goodbye is playing, or a turn failed: nothing more is sent.
    if (afterReply.current) return null;
    const body: TurnBody = { action: "answer", text: said, turnId: newTurnId() };
    setFailure(null);
    setLines((l) => [...l, { from: "you", text: said }]);
    setAnswering(true);
    try {
      const res = await api.setupTurn(
        token,
        body,
        (sentence) => {
          setLines((l) => withSentence(l, body.turnId, sentence));
          onSentence?.(sentence);
        },
        signal,
        extra?.speech,
      );
      shown(res);
      if (res.setup.done) afterReply.current = "finish";
      else if (res.meta.unreachable) {
        // Once that's been heard, the call waits rather than listening into nothing.
        afterReply.current = "pause";
        unreachable(body);
      }
      return res.reply;
    } catch (err) {
      // Talked over, or the call ended: the loop dropped it and logs that itself.
      if (signal?.aborted) throw err;
      afterReply.current = "pause";
      failed(err, body);
      return null;
    } finally {
      setAnswering(false);
    }
  };

  // wake false: Talk's wake word ear waits for "OVOA" before anything counts,
  // so setup heard every answer as room talk and never replied. And no "Let me
  // look into that" fillers: the reply here is the next thing OVOA says, not a
  // search. answers: a one-word answer ("Seven.", "Skip.") is not taken for the
  // reply's echo (turnGate.ts).
  const convo = useConversation(token, answer, { interruptible: true, wake: false, fillers: false, answers: true });
  // The hook's own speaker belongs to the loop; a turn outside it (the opener,
  // Skip, a typed answer) runs while the loop is off, with a speaker of its own.
  const intro = useRef(createSpeaker(token));

  useEffect(() => {
    const then = afterReply.current;
    // Type pressed mid-answer: the loop ends once that answer's reply and what
    // it understood are on screen, cutting only the rest of it out loud. Not
    // the goodbye: that plays out, and setup ends after it, below.
    if (typedMidTurn.current && !answering && convo.phase !== "thinking" && then !== "finish") {
      typedMidTurn.current = false;
      afterReply.current = null;
      convo.end();
      return;
    }
    if (!then || (convo.phase !== "listening" && convo.phase !== "off")) return;
    typedMidTurn.current = false;
    afterReply.current = null;
    convo.end();
    if (then === "finish") void leave(setupRef.current, "over");
  }, [convo.phase, answering]);

  /** Listens again, if the call is live and they aren't typing. */
  const listen = () => {
    if (callingRef.current && !typingRef.current && !introAbort.current && !leavingRef.current && !cancelledRef.current) {
      void convo.start();
    }
  };

  /**
   * A turn outside the voice loop: the opener, Skip, a typed answer, a picked
   * contact, Try again. Streamed into its bubble and, while the call is live,
   * voiced by the server the way Talk's replies are (a typed answer with the
   * call hung up is read, not heard). Resolves once the reply has been said;
   * null when it failed (the screen says why) or was dropped.
   */
  const introTurn = async (body: TurnBody): Promise<SetupTurnResult | null> => {
    introAbort.current?.abort();
    const abort = new AbortController();
    introAbort.current = abort;
    const dropped = () => abort.signal.aborted || cancelledRef.current;
    const reply = callingRef.current ? intro.current.open({ filler: false }) : null;
    const server = reply ? serverSpeech(reply, dropped) : null;
    setFailure(null);
    setIntroPhase("thinking");
    try {
      const res = await api.setupTurn(
        token,
        body,
        (sentence) => {
          if (dropped()) return;
          setIntroPhase("speaking");
          setLines((l) => withSentence(l, body.turnId, sentence));
          if (reply && !server!.on()) reply.say(sentence);
        },
        abort.signal,
        await server?.request(),
      );
      reply?.end();
      shown(res);
      if (res.meta.unreachable) unreachable(body);
      await reply?.done;
      return res;
    } catch (err) {
      intro.current.stop();
      if (!dropped()) failed(err, body);
      return null;
    } finally {
      server?.done();
      if (introAbort.current === abort) {
        introAbort.current = null;
        setIntroPhase(null);
      }
    }
  };

  /** A turn outside the loop, then on: its goodbye ends setup, anything else listens again. A failure waits for Try again. */
  const viaIntro = async (body: TurnBody) => {
    convo.end();
    const res = await introTurn(body);
    if (!res || cancelledRef.current || leavingRef.current) return;
    if (res.setup.done) return leave(res.setup, "over");
    if (!res.meta.unreachable) listen();
  };

  /** Rings: OVOA speaks first, then the voice loop listens. */
  const ring = async (action: "start" | "resume") => {
    // Microphone access asked for first: asked after the opener, the prompt came
    // up just as they started answering, and that first answer was lost.
    await requestRecordingPermissionsAsync().catch(logFail("onboarding: microphone permission"));
    if (cancelledRef.current) return;
    setCalling(true);
    await viaIntro({ action, turnId: newTurnId(), typed: typingRef.current });
  };

  /**
   * Setup is over: the conversation ended it ("over"), they pressed Later
   * (said to the server first, with what was said so far kept), or it was
   * already over when the screen opened. Everything stops talking, and once
   * GET /me says they're set up the app moves on (app/_layout.tsx).
   */
  const leave = async (view: SetupView | null, why: "over" | "later" | "done before") => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    setFailure(null);
    convo.end();
    introAbort.current?.abort();
    intro.current.stop();
    setCalling(false);
    try {
      if (why === "later") view = (await api.onboardingFinish(token, "later")).setup ?? view;
      if (why !== "done before") devlog("log", `setup: finished ${view?.finished?.how ?? why} after ${view?.turns ?? 0} turns`);
      // Medications from setup go into Apple Reminders now, asking for Reminders
      // access at the moment it makes sense rather than on some later screen.
      await syncRoutines(token, { ask: true }).catch(logFail("onboarding: syncRoutines"));
      // A goal's app still being made lands after this screen has gone.
      if (appsMaking(view)) {
        for (const ms of APP_CHECKS_MS) setTimeout(() => void myApps.refresh(token).catch(logFail("onboarding: reading the apps it made")), ms);
      }
      setUser((await api.me(token)).user);
    } catch (err) {
      leavingRef.current = false;
      setLeaving(false);
      setFailure({ message: messageOf(err), retry: () => void leave(view, why) });
    }
  };

  const load = () => {
    setFailure(null);
    api
      .setupState(token)
      .then(({ setup: view }) => {
        if (cancelledRef.current) return;
        show(view);
        if (view.done) return void leave(view, "done before");
        // From the beginning: their voice first, then the call. Picking up
        // where they left off: straight back into it.
        if (view.fresh) setPickingVoice(true);
        else void ring("resume");
      })
      // Setup is part of the assistant. On the free plan the answer is needs_plan,
      // which already moved the plan to free, and the free app opens instead of
      // this; without consent (taken back on another phone, say) the consent
      // state moves the same way, and setup waits for it.
      .catch((err) => !isNeedsPlan(err) && !isNeedsConsent(err) && setFailure({ message: messageOf(err), retry: load }));
  };

  useEffect(() => {
    cancelledRef.current = false;
    load();
    return () => {
      cancelledRef.current = true;
      introAbort.current?.abort();
      intro.current.stop();
    };
  }, [token]);

  const voicePicked = () => {
    setPickingVoice(false);
    void ring("start");
  };

  useEffect(() => {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [lines, setup]);

  const phase = introPhase ?? convo.phase;
  // A spoken answer on its way counts through its reply's first sentences
  // ('speaking'), until the server has stored the turn and its view is shown.
  const busy = !!introPhase || answering || convo.phase === "thinking" || leaving;

  const skip = () => {
    if (busy) return;
    void viaIntro({ action: "skip", turnId: newTurnId(), typed: typingRef.current });
  };

  const sendTyped = () => {
    const said = text.trim();
    if (!said || busy) return;
    setText("");
    setLines((l) => [...l, { from: "you", text: said }]);
    void viaIntro({ action: "answer", text: said, typed: true, turnId: newTurnId() });
  };

  const chooseContact = async () => {
    if (busy) return;
    convo.end();
    setContactNote(null);
    let said: string | null = null;
    try {
      const picked = await pickContact();
      if (picked) said = picked.answer ?? null;
      if (picked && !said) setContactNote("That contact has no phone number. Pick another, or say the number.");
    } catch (err) {
      setContactNote(messageOf(err));
    }
    if (!said) return listen();
    setLines((l) => [...l, { from: "you", text: said }]);
    await viaIntro({ action: "answer", text: said, typed: true, turnId: newTurnId() });
  };

  const toggleTyping = () => {
    const next = !typingRef.current;
    typingRef.current = next;
    setTyping(next);
    // Typing and listening at once means the mic hears the room while they
    // think; the call picks up again when they switch back. With an answer on
    // its way (or about to be: 'thinking' comes just before it's sent), the
    // loop ends once its reply is in rather than dropping it (the effect above).
    if (next) {
      if (answeringRef.current || convo.currentPhase() === "thinking") typedMidTurn.current = true;
      else convo.end();
      return;
    }
    // Back before that reply came in: the loop never stopped.
    if (typedMidTurn.current) {
      typedMidTurn.current = false;
      return;
    }
    setCalling(true);
    listen();
  };

  if (pickingVoice) {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.voicePage}>
          <Text style={styles.who}>How should I sound?</Text>
          <Text style={styles.voiceLead}>Pick a voice for {assistant}. You can change it any time in Settings.</Text>
          <VoiceList token={token} />
          <Btn label="Continue" kind="go" onPress={voicePicked} style={{ marginTop: 12 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  const talking = convo.phase === "listening";
  // Map roughly -60..-10 dBFS onto the halo, the same as the assistant's orb.
  const loudness = talking ? Math.max(0, Math.min(1, (convo.level + 60) / 50)) : 0;
  const latest = latestLine(lines);
  const understood = soFar(setup);
  const problem = failure?.message || convo.error;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.head}>
        <Text style={styles.who}>{assistant}</Text>
        <Text style={styles.status}>{statusLine(calling, phase, leaving)}</Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.stage}>
          {/* The same particle globe as Talk; smaller while the keyboard is up. */}
          <OrbView mode={orbMode(calling, phase)} level={loudness} size={typing ? 72 : 170} />

          {/* OVOA's latest words, big, because they're what's being answered;
              smaller with the keyboard up, so the box and its send button stay on screen. */}
          {!!latest && (
            <Text style={[styles.latest, typing && styles.latestSmall]} numberOfLines={typing ? 4 : undefined}>
              {latest}
            </Text>
          )}
          {!!convo.words && (
            <Text style={styles.heard} numberOfLines={3}>
              {convo.words}
            </Text>
          )}
          {wantsContact(setup) && !leaving && (
            <Btn label="Choose from Contacts" onPress={() => void chooseContact()} disabled={busy} />
          )}
          {!!contactNote && <Text style={styles.note}>{contactNote}</Text>}
          {!!problem && <Text style={styles.error}>{problem}</Text>}
          {failure && <Btn label="Try again" kind="go" onPress={failure.retry} disabled={busy} />}
        </View>

        <ScrollView ref={scroll} style={styles.transcript} contentContainerStyle={styles.lines}>
          {lines.map((line, i) => (
            <View key={i} style={[styles.bubble, line.from === "you" ? styles.you : styles.ovoa]}>
              <Text style={[styles.bubbleText, line.from === "you" && { color: colors.paper }]}>{line.text}</Text>
            </View>
          ))}
          {/* What it understood, last, so it stays in view as the call goes on:
              a misheard name or time is caught here and said again. */}
          {understood.length > 0 && (
            <View style={styles.soFar}>
              <Text style={styles.soFarTitle}>So far</Text>
              {understood.map((o) => (
                <View key={o.id} style={styles.soFarRow}>
                  <Text style={styles.soFarLabel}>{o.label}</Text>
                  <Text style={styles.soFarValue}>
                    {o.shown}
                    {o.checking && <Text style={styles.soFarChecking}> · not sure yet</Text>}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>

        <View style={styles.controls}>
          <CallButton icon={typing ? "mic" : "keypad"} label={typing ? "Talk" : "Type"} onPress={toggleTyping} disabled={leaving} />
          <CallButton icon="play-skip-forward" label="Skip" onPress={skip} disabled={busy || !setup} />
          <CallButton icon="call" label="Later" tone="danger" onPress={() => void leave(setupRef.current, "later")} disabled={leaving} />
        </View>
        {/* Last, right above the keyboard: nothing can sit between the box and it. */}
        {typing && (
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Type your answer…"
              placeholderTextColor={colors.inkMute}
              onSubmitEditing={sendTyped}
              returnKeyType="send"
              submitBehavior="submit"
              // Not tied to `busy`: taking the box away mid-send closed the keyboard after every answer.
              editable={!leaving}
              autoFocus
              // No AutoFill: iOS offered passwords and contacts over the send
              // button, straight after the sign-in screen.
              textContentType="none"
              autoComplete="off"
              importantForAutofill="no"
            />
            <Pressable style={styles.send} onPress={sendTyped} disabled={busy || !text.trim()} accessibilityLabel="Send">
              <Ionicons name="arrow-up" size={20} color={colors.paper} />
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Contacts' own picker, for the emergency contact: the name and a number, as
 * they'd have typed them. Reading the picked contact needs Contacts access
 * (expo-contacts 57 hands back only its id), and with iOS's limited access a
 * contact outside the ones shared can be picked but not read. Null when they
 * closed the picker; `answer` null when the contact has no number.
 */
async function pickContact(): Promise<{ answer: string | null } | null> {
  const { granted } = await requestContactsAccess();
  if (!granted) throw new Error("OVOA can't read Contacts. Allow it in iPhone Settings → OVOA, or say the number.");
  const picked = await Contact.presentPicker();
  if (!picked) return null;
  const details = await picked.getDetails([ContactField.FULL_NAME, ContactField.PHONES]).catch((err) => {
    devlog("warn", "setup: couldn't read the picked contact", messageOf(err));
    throw new Error("OVOA can't read that contact. Say or type the number instead.");
  });
  return { answer: contactAnswer(details.fullName, details.phones) };
}

function CallButton({
  icon,
  label,
  onPress,
  disabled,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.control, disabled && { opacity: 0.4 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.controlCircle, tone === "danger" && styles.controlDanger]}>
        <Ionicons
          name={icon}
          size={22}
          color={tone === "danger" ? colors.paper : colors.ink}
          // A hang-up icon is the call icon, turned over.
          style={tone === "danger" ? { transform: [{ rotate: "135deg" }] } : undefined}
        />
      </View>
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

function orbMode(calling: boolean, phase: string): OrbMode {
  if (!calling) return "off";
  if (phase === "listening" || phase === "thinking" || phase === "speaking") return phase;
  return "idle";
}

function statusLine(calling: boolean, phase: string, leaving: boolean) {
  if (leaving || phase === "thinking") return "One moment…";
  if (!calling) return "Setup";
  if (phase === "speaking") return "Speaking";
  if (phase === "listening") return "Listening…";
  return "Connected";
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper, paddingHorizontal: 16 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 8, paddingBottom: 10 },
  who: { color: colors.ink, fontSize: 24, fontWeight: "700" },
  status: { color: colors.now, fontSize: 14 },

  stage: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 12 },
  voicePage: { paddingTop: 24, paddingBottom: 32, gap: 10 },
  voiceLead: { color: colors.inkMute, fontSize: 15, lineHeight: 21 },
  latest: { color: colors.ink, fontSize: 21, lineHeight: 28, textAlign: "center", paddingHorizontal: 8 },
  latestSmall: { fontSize: 17, lineHeight: 23 },
  heard: { color: colors.now, fontSize: 16, lineHeight: 22, textAlign: "center", opacity: 0.9 },
  note: { color: colors.inkMute, fontSize: 14, lineHeight: 20, textAlign: "center" },
  error: { color: colors.stop, textAlign: "center" },

  transcript: { flex: 1 },
  lines: { gap: 8, paddingVertical: 8 },
  bubble: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  ovoa: { alignSelf: "flex-start", backgroundColor: colors.wash, borderColor: colors.line, borderWidth: 1 },
  you: { alignSelf: "flex-end", backgroundColor: colors.now },
  bubbleText: { color: colors.ink, fontSize: 15, lineHeight: 21 },

  soFar: { marginTop: 8, paddingTop: 10, borderTopColor: colors.line, borderTopWidth: 1, gap: 6 },
  soFarTitle: { color: colors.inkMute, fontSize: 13, fontWeight: "600" },
  soFarRow: { flexDirection: "row", gap: 12 },
  soFarLabel: { color: colors.inkMute, fontSize: 14, lineHeight: 20, width: 118 },
  soFarValue: { color: colors.ink, fontSize: 14, lineHeight: 20, flex: 1 },
  soFarChecking: { color: colors.inkMute },

  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingTop: 4, paddingBottom: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    color: colors.ink,
    backgroundColor: colors.wash,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.now, alignItems: "center", justifyContent: "center" },

  controls: { flexDirection: "row", justifyContent: "space-evenly", alignItems: "flex-start", paddingTop: 12, paddingBottom: 8 },
  control: { alignItems: "center", gap: 6, width: 78 },
  controlCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.wash2,
    borderColor: colors.line,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  controlDanger: { backgroundColor: colors.stop, borderColor: colors.stop },
  controlLabel: { color: colors.inkMute, fontSize: 13 },
});
