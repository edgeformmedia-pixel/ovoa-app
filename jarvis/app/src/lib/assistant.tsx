import { usePathname, useRouter } from "expo-router";
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";
import { cue } from "./cues";
import { api, isNeedsPlan, type ChatResponse, type PendingAction, type PhoneResult, type ServerSpeech } from "./api";
import { useSession } from "./auth";
import { noteRecording } from "./capture";
import { usePlan } from "./plan";
import { setKeepsHeard } from "./heard";
import { phoneCaps, preparePhoneAction, runPhoneAction, runPhoneLookup, type Approval } from "./phoneActions";
import { useOptionalContext, useProviderLog } from "./context";
import { devlog, logFail } from "./devlog";
import { onPush } from "./background";
import { SHORT_FILLERS, pickFiller } from "./fillers";
import { syncAlarms } from "./nag";
import * as clip from "./clip";
import { showIsland, type IslandStatus } from "./island";
import { canListen, usePhoneEar } from "./liveListen";
import { ensureSpeechPermission, speechAllowed, transcribeOnDevice } from "./onDeviceTranscribe";
import { deleteRecording, wavFile, type Recording } from "./recordings";
import { micSourcePref, type MicSource } from "./storage";
import { useTourSeen } from "./tour";
import { endTurn, failTurn, mark as markTurn, markStopTalking, noteHeard, noteServer, startTurn } from "./turnTimer";
import {
  alwaysListenPref,
  createSpeaker,
  listeningPref,
  serverSpeech,
  listenModePref,
  setTtsEngine,
  useConversation,
  type ListenMode,
  type VoicePhase,
} from "./voice";

// The voice assistant lives above the tabs so "Always listen" works on every
// screen. The Assistant tab is just its face.

const ASSISTANT_PATH = "/chat";

type AssistantState = {
  phase: VoicePhase;
  level: number;
  error: string | null;
  /** What the user is saying, live, then what was sent (cleared when the reply plays). */
  words: string;
  /** e.g. "Checking contacts…" while the assistant looks something up on the phone. */
  status: string | null;
  /** The Assistant tab's orb. null until loaded. */
  enabled: boolean | null;
  toggleEnabled: () => void;
  /**
   * This iPhone can't recognise speech on its own, so the orb isn't a switch:
   * a tap asks one thing, like a click, and listening closes after the answer.
   */
  tapAsks: boolean;
  /** Danger zone: listen everywhere and allow talking over replies. */
  alwaysListen: boolean;
  setAlwaysListen: (on: boolean) => void;
  /** How a turn starts: the name, a wrist twist on the ES100, or either. */
  listenMode: ListenMode;
  setListenMode: (mode: ListenMode) => void;
  /** Which microphone a summon uses: the phone's, or the ES100's own. */
  micSource: MicSource;
  setMicSource: (source: MicSource) => void;
  interrupt: () => void;
  /** Approval cards to show (auto-run ones are hidden while they run). */
  approvals: PendingAction[];
  autoRunning: boolean;
  approve: (action: PendingAction, approval: Approval) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /** Pauses listening while `fn` runs, e.g. to play a voice sample. */
  hold: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Asks from a made app's own screen (app/made/[id].tsx): the app's
   * instructions and screen ride along, and any approval card shows there
   * rather than pulling them over to Talk. Null if a turn is already running.
   */
  askInApp: (text: string, appId: string) => Promise<string | null>;
};

const AssistantContext = createContext<AssistantState | null>(null);

/**
 * What useAssistant gives a screen with no provider above it: an assistant that
 * is off, has nothing to approve, and ignores every switch. -160 is the same
 * silence floor useConversation starts at (voice.ts).
 */
const NO_ASSISTANT: AssistantState = {
  phase: "off",
  level: -160,
  error: null,
  words: "",
  status: null,
  enabled: null,
  toggleEnabled: () => {},
  tapAsks: false,
  alwaysListen: false,
  setAlwaysListen: () => {},
  listenMode: "wake",
  setListenMode: () => {},
  micSource: "phone",
  setMicSource: () => {},
  interrupt: () => {},
  approvals: [],
  autoRunning: false,
  approve: async () => {},
  cancel: async () => {},
  hold: async (fn) => fn(),
  askInApp: async () => null,
};

export function useAssistant() {
  return useOptionalContext(AssistantContext, "useAssistant", NO_ASSISTANT);
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { token, user } = useSession();
  useProviderLog("assistant");
  // What the plan includes (plan.tsx). Free: no talking at all, and the band's
  // button records notes. Base (and Pro): everything, the wake word included.
  const { can } = usePlan();
  const pathname = usePathname();
  const router = useRouter();
  const onAssistantTab = pathname === ASSISTANT_PATH;

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [alwaysListenPicked, setAlwaysListenState] = useState(false);
  // Always listen is the wake word at its most hands-free: Base. The switch is
  // remembered either way, and comes back on its own if the plan does. It only
  // runs on the phone's own ear (decision 1): on an iPhone that can't recognise
  // speech by itself it doesn't run at all, and Settings says why.
  const phoneEar = usePhoneEar();
  const alwaysListen = alwaysListenPicked && can.wake && phoneEar.available;
  // Nor does the orb left on: without the ear it would be Apple's recogniser,
  // which may use Apple's servers, hearing every sentence in the room. There a
  // tap asks one thing instead (toggleEnabled), and the orb isn't restored.
  const tapAsks = canListen && phoneEar.checked && !phoneEar.available;
  const [listenMode, setListenModeState] = useState<ListenMode>("wake");
  const [micSource, setMicSourceState] = useState<MicSource>("phone");
  const [held, setHeld] = useState(0);
  /** The same count, readable from the band and click handlers without a re-render. */
  const heldRef = useRef(0);
  // Talk stays quiet until the tour has been seen: it opens on Talk, and an open
  // microphone heard the tour's own voice and answered it.
  const tourSeen = useTourSeen();
  const [inForeground, setInForeground] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingAction[]>([]);
  // "Approve for me" actions being run without a card.
  const [autoRunning, setAutoRunning] = useState<string[]>([]);
  const autoStarted = useRef(new Set<string>());
  const autoQueue = useRef(Promise.resolve());
  const busy = useRef(false);
  const tabRef = useRef(onAssistantTab);
  tabRef.current = onAssistantTab;
  const ambientRef = useRef(false);

  useEffect(() => {
    listeningPref.get().then(setEnabled);
    alwaysListenPref.get().then(setAlwaysListenState);
    listenModePref.get().then(setListenModeState);
    // The switch lives in Dev tools now, outside this provider.
    return alwaysListenPref.onChange(setAlwaysListenState);
  }, []);

  const dropApproval = (id: string) => setApprovals((a) => a.filter((x) => x.id !== id));

  const approve = async (action: PendingAction, approval: Approval) => {
    const { id } = action;
    try {
      // Phone actions run here on the device; the server just records the outcome.
      let phoneResult: PhoneResult | undefined;
      if (action.phone) {
        try {
          phoneResult = { ok: true, detail: await runPhoneAction(action, approval) };
        } catch (err) {
          phoneResult = { ok: false, detail: err instanceof Error ? err.message : "unknown error" };
        }
      }
      await api.approveAction(token, id, phoneResult);
      cue(phoneResult && !phoneResult.ok ? "error" : "done");
    } catch (err) {
      conversation.setError(err instanceof Error ? err.message : "Couldn't approve");
    }
    dropApproval(id);
  };

  /**
   * Runs an "Approve for me" action without a card, one at a time so text and
   * email sheets don't stack. Falls back to the card when it needs a choice.
   */
  const queueAuto = (action: PendingAction) => {
    if (!action.auto || autoStarted.current.has(action.id)) return;
    autoStarted.current.add(action.id);
    setAutoRunning((ids) => [...ids, action.id]);
    autoQueue.current = autoQueue.current.then(async () => {
      try {
        const prep = await preparePhoneAction(action);
        if (prep.kind === "contact" && prep.matches.length !== 1) return;
        if (prep.kind === "recipients" && prep.recipients.some((r) => !r.value)) return;
        const contactId = prep.kind === "contact" ? prep.matches[0].id : undefined;
        await approve(action, { contactId, prep });
      } catch {
        // Leave it to the card, which shows the error.
      } finally {
        setAutoRunning((ids) => ids.filter((id) => id !== action.id));
      }
    });
  };

  const addApprovals = (actions: PendingAction[], { stay = false } = {}) => {
    setApprovals((a) => [...a, ...actions.filter((x) => !a.some((y) => y.id === x.id))]);
    actions.forEach(queueAuto);
    // Cards show on the Assistant tab, and on a made app's screen when it asked;
    // otherwise bring the user to Talk if one needs them.
    if (actions.some((a) => !a.auto) && !tabRef.current && !stay) router.navigate(ASSISTANT_PATH);
  };

  /**
   * Sends what the user said and returns the assistant's reply to read aloud.
   * `addressed`: the phone heard its name, so the server needn't check.
   * `onSentence`: stream the reply, one sentence at a time, as it's written.
   */
  const ask = async (
    text: string,
    addressed: boolean,
    onSentence?: (sentence: string) => void,
    signal?: AbortSignal,
    { source, speech, room, app }: { source?: "agent"; speech?: ServerSpeech; room?: boolean; app?: string } = {},
  ): Promise<string | null> => {
    if (busy.current) return null;
    busy.current = true;
    // Actions from every step of the turn; shown (or auto-run) once the reply is in.
    const parked: PendingAction[] = [];
    try {
      // Always-listening hears everything, and the phone's ear hears the room for a
      // moment after each reply, so unless its name was said the server first
      // decides whether this was meant for the assistant.
      const ambient = (ambientRef.current || !!room) && !addressed;
      const caps = await phoneCaps();
      // One mark for the first sentence, however many round trips it takes to get there.
      let firstSentence = false;
      const timed = onSentence
        ? (sentence: string) => {
            if (!firstSentence) {
              firstSentence = true;
              markTurn("model answers");
            }
            onSentence(sentence);
          }
        : undefined;
      let res: ChatResponse = timed
        ? await api.sendStreamed(token, text, caps, ambient, timed, signal, speech)
        : await api.send(token, text, caps, !source && !app, ambient, source, app);
      if (res.meta) noteServer(res.meta);
      if (res.ignored) {
        // Only that it happened: the words were the room's, and they stay on the phone.
        devlog("voice", `not meant for the assistant; staying quiet (${text.length} chars)`);
        return null;
      }
      // The assistant may pause to look things up on this phone, possibly more than once.
      while (res.paused) {
        const { turnId, calls } = res.paused;
        parked.push(...res.pendingActions);
        setStatus(lookupStatus(calls.map((c) => c.name)));
        const results: Record<string, unknown> = {};
        const lookupStarted = Date.now();
        for (const call of calls) results[call.id] = await runPhoneLookup(call);
        markTurn("phone lookup", calls.map((c) => c.name).join(", "));
        devlog("perf", `phone lookup took ${Date.now() - lookupStarted} ms`, calls.map((c) => c.name).join(", "));
        setStatus(null);
        res = timed
          ? await api.resumeStreamed(token, turnId, results, timed, signal, speech)
          : await api.resume(token, turnId, results);
        if (res.meta) noteServer(res.meta);
      }
      parked.push(...res.pendingActions);
      // An alarm was set or changed: the phone arms it now rather than trusting a silent push.
      if (res.meta?.tools?.some((t) => t.name.startsWith("alarm_"))) void syncAlarms(token);
      return res.messages.find((m) => m.role === "assistant")?.content ?? null;
    } finally {
      busy.current = false;
      setStatus(null);
      if (parked.length) addApprovals(parked, { stay: !!app });
    }
  };

  // --- Commands the agent queued (server: commands.ts) ------------------------------
  // The agent runs on the server and can't reach the phone's Reminders, calendar or
  // Health, so it queues a request in words and rings with a silent push. The queue
  // is drained on that push, whenever the app comes forward, and when the band
  // reconnects; the push alone can't be relied on (iOS won't wake a killed app).
  const draining = useRef(false);
  const retryDrain = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainCommands = useCallback(async () => {
    if (!token || draining.current) return;
    // Someone is talking to it: try again once they're done rather than cutting in.
    if (busy.current) {
      if (!retryDrain.current) retryDrain.current = setTimeout(() => ((retryDrain.current = null), void drainRef.current()), 20_000);
      return;
    }
    draining.current = true;
    try {
      const { commands } = await api.pendingCommands(token);
      for (const command of commands) {
        // The length, not the sentence: a command is something the agent decided
        // to say or do about this person, and device_logs is read back over HTTP.
        devlog("agent", `running a command from the agent (${command.text.length} chars)`);
        try {
          const reply = await ask(command.text, true, undefined, undefined, { source: "agent" });
          await api.commandDone(token, command.id, true, reply ?? "");
          if (reply) await showAgentReply(reply);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          devlog("err", "the agent's command failed", message);
          await api.commandDone(token, command.id, false, message).catch(logFail("assistant: api.commandDone"));
        }
      }
    } catch (err) {
      devlog("err", "couldn't fetch the agent's commands", String(err));
    } finally {
      draining.current = false;
    }
  }, [token]);
  const drainRef = useRef(drainCommands);
  drainRef.current = drainCommands;

  useEffect(() => {
    onPush("command", () => drainRef.current());
    void drainRef.current();
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") void drainRef.current();
    });
    const link = clip.onLinkChange((linked) => {
      if (linked) void drainRef.current();
    });
    return () => {
      app.remove();
      link();
      if (retryDrain.current) clearTimeout(retryDrain.current);
    };
  }, [token]);

  ambientRef.current = alwaysListen;
  const alwaysListenRef = useRef(alwaysListen);
  alwaysListenRef.current = alwaysListen;
  // Room talk is only ever sent (to be kept) by a development account with
  // capture-everything on; for everyone else it stays on the phone.
  useEffect(() => {
    setKeepsHeard(!!user?.settings.captureEverything);
  }, [user?.settings.captureEverything]);
  // Which engine voices replies for this person; "device" means this phone does.
  useEffect(() => {
    setTtsEngine(user?.ttsEngine);
  }, [user?.ttsEngine]);
  const twistOn = listenMode !== "wake";
  const clipPaired = clip.useClipPaired();
  // A band click from the wrist is turned into words on the phone, and iOS
  // can't ask for Speech Recognition off screen: ask now, in the foreground,
  // as soon as there's a band to click (Phase 5's first open asks too).
  useEffect(() => {
    if (clipPaired && inForeground) void ensureSpeechPermission();
  }, [clipPaired, inForeground]);
  // Twist mode without Always listen: keep the mic (and the app) running so a twist works from other apps.
  // In band mode the phone's microphone is never used, so there's no standby to keep alive.
  const standby = can.voice && twistOn && !alwaysListen && clipPaired && micSource === "phone";
  const conversation = useConversation(token, ask, {
    interruptible: alwaysListen,
    background: alwaysListen,
    standby,
    name: user?.settings.assistantName || "OVOA",
    wake: can.wake,
  });
  const { start, end, summon, currentPhase, finishNow } = conversation;

  // --- One click to talk (ES100) ------------------------------------------------
  // A click on the clip's button opens listening until the user is done talking (see TurnGate's
  // clicked turns), answers, then closes. A second click while listening sends what's been said
  // right away (or closes, if nothing has); a click during a reply cuts it off and listens again.
  // The twist/shake gesture was dropped: at ~1 gyro reading a second it either missed or fired on
  // every wrist movement (builds 32-35), so the motion stream stays off.
  /** Listening was opened by a click (not by a switch): close it again once it goes idle. */
  const summonedOpen = useRef(false);

  // --- The clip's own microphone ------------------------------------------------
  // The ES100 has no live audio stream, only record-then-fetch, so a band turn is:
  // click (record) -> click again, or 60 s (stop, fetch the file) -> transcribe -> answer.
  // Nothing is heard between turns, and the phone's microphone stays off.
  const [bandPhase, setBandPhase] = useState<VoicePhase | null>(null);
  const bandRecording = useRef(false);
  const bandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bandSpeaker = useRef<ReturnType<typeof createSpeaker> | null>(null);
  const bandPhaseRef = useRef<VoicePhase | null>(null);
  bandPhaseRef.current = bandPhase;

  useEffect(() => {
    micSourcePref.get().then(setMicSourceState);
  }, []);

  // The band's own microphone answers questions when it's picked, and on the
  // free plan it's always what the button uses: every press records a note.
  const bandOn = clipPaired && (micSource === "band" || !can.voice);
  const talks = can.voice;

  const setMicSource = useCallback((source: MicSource) => {
    setMicSourceState(source);
    micSourcePref.set(source).catch(logFail("assistant: micSourcePref.set"));
  }, []);

  /** The clip's finished recording: transcribe it and answer. */
  const bandAnswer = useCallback(
    async (entry: Recording) => {
      setBandPhase("thinking");
      const speaker = (bandSpeaker.current ??= createSpeaker(token));
      let spoke = false;
      let filler: ReturnType<typeof setTimeout> | null = null;
      let server: ReturnType<typeof serverSpeech> | null = null;
      try {
        // Resolved against Documents now, not from a uri stored when it was written:
        // the container's UUID changes on every app update (device_logs 2026-09-20 23:18).
        const audio = wavFile(entry);
        if (!audio?.exists) throw new Error(entry.decodeError ?? "the clip's recording couldn't be decoded");
        devlog("file", `band mic: hearing ${audio.name}, ${Math.round(audio.size / 1024)} KB`, audio.uri);
        // The phone writes the words out itself (onDeviceTranscribe.ts): the audio
        // never leaves it, the same as a free note. The decoded WAV, never the raw opus.
        const heard = await transcribeOnDevice(audio.uri);
        if (!heard) {
          // Off screen iOS can't ask for Speech Recognition, so an unanswered
          // permission fails here; the app asks for it in the foreground ahead of time.
          throw new Error((await speechAllowed()) ? "the recording couldn't be recognised on this phone" : "speech recognition isn't allowed yet");
        }
        const text = heard.text.trim();
        markTurn("recognised on phone", heard.onDevice ? "on the phone" : "Apple's servers");
        if (text) noteHeard(text);
        // A question isn't worth keeping, so the clip's recording doesn't stay in the
        // Recordings list: it goes once the words are back. Kept until then, so that a
        // plan that turns out not to include talking can still make a note of it, and
        // a recording the phone couldn't make out stays to be tried again.
        deleteRecording(entry.id);
        if (entry.sessionId) clip.deleteFromClip(entry.sessionId).catch(logFail("assistant: clip.deleteFromClip"));
        if (!text) {
          devlog("voice", "band mic: nothing was said");
          clip.buzz(2);
          endTurn("nothing was said");
          return;
        }
        const reply = speaker.open({ keepMic: false });
        // The server voices the reply in the same stream when it can (voice.ts serverSpeech).
        server = serverSpeech(reply);
        const voicing = server;
        let streamed = false;
        // Thinking takes a few seconds on a good turn and much longer on a bad one. A
        // filler from the phone's own cache ("One moment.") plays at once; the answer
        // queues straight after it. Only if none is ready yet does it fall back to
        // voicing a short line after a pause: a short one, since "Still on it." as
        // the first thing said would claim a wait that hasn't happened.
        const cached = pickFiller();
        if (cached) {
          setBandPhase("speaking");
          reply.clip(cached);
        } else {
          filler = setTimeout(() => {
            if (streamed) return;
            setBandPhase("speaking");
            reply.say(SHORT_FILLERS[Math.floor(Math.random() * SHORT_FILLERS.length)]);
            devlog("voice", "band mic: saying a word while it thinks");
          }, FILLER_AFTER_MS);
        }
        const full = await ask(
          text,
          true,
          (sentence) => {
            if (!streamed) {
              setBandPhase("speaking");
              if (filler) clearTimeout(filler);
              filler = null;
              voicing.firstSentence();
            }
            streamed = true;
            spoke = true;
            if (!voicing.on()) reply.say(sentence);
          },
          undefined,
          { speech: await voicing.request() },
        );
        voicing.done();
        if (filler) clearTimeout(filler);
        filler = null;
        // An older server sends no sentences as it writes: read the whole reply.
        if (full && !streamed) {
          setBandPhase("speaking");
          spoke = true;
          reply.say(full);
        }
        reply.end();
        await reply.done.catch(logFail("assistant: reply.end"));
        endTurn();
      } catch (err) {
        if (filler) clearTimeout(filler);
        server?.done();
        // The plan doesn't include talking (it has just changed, and the phone
        // hadn't heard yet): not a failure. The recording becomes a note instead.
        if (isNeedsPlan(err)) {
          devlog("voice", "band mic: talking isn't part of this plan; keeping it as a note");
          const outcome = await noteRecording(token, entry);
          clip.buzz(outcome === "noted" ? 1 : 2);
          endTurn(outcome);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        devlog("err", "band mic: the turn failed", message);
        failTurn(message);
        // Failing silently is the worst of it: from the wrist there's no screen to check,
        // so the same speaker that would have read the answer says what went wrong.
        clip.buzz(2);
        if (!spoke) await speaker.speak(excuse(message)).catch(logFail("assistant: excuse"));
      } finally {
        setBandPhase(null);
      }
    },
    [token],
  );

  /**
   * The free plan's band recording: written out on the phone and kept as a note.
   * Never the AI reply. One buzz when it's saved, two when it couldn't be (the
   * Record tab then says why and offers it again).
   */
  const bandNote = useCallback(
    async (entry: Recording) => {
      setBandPhase("thinking");
      try {
        const outcome = await noteRecording(token, entry);
        devlog("voice", `band note: ${outcome}`);
        clip.buzz(outcome === "noted" ? 1 : 2);
        if (outcome === "noted") endTurn();
        else failTurn(outcome === "empty" ? "nothing was said" : "couldn't make a note of it");
      } finally {
        setBandPhase(null);
      }
    },
    [token],
  );

  // Band mode on or off in the clip, and the finished recordings it hands over.
  useEffect(() => {
    const on = bandOn;
    clip.setBandMode(on);
    if (!on) return;
    const off = clip.onBandRecording((entry, err) => {
      if (bandTimer.current) clearTimeout(bandTimer.current);
      bandTimer.current = null;
      bandRecording.current = false;
      if (err || !entry) {
        setBandPhase(null);
        devlog("err", "band mic: no recording came over", err?.message ?? "nothing arrived");
        failTurn(err?.message ?? "no recording came over");
        clip.buzz(2);
        return;
      }
      // Held (the tour, a voice sample, a made app listening): not a question for Talk.
      if (talks && heldRef.current > 0) {
        setBandPhase(null);
        devlog("voice", "band mic: ignored while something else has the microphone");
        endTurn("held");
        clip.buzz(2);
        return;
      }
      void (talks ? bandAnswer(entry) : bandNote(entry));
    });
    return () => {
      clip.setBandMode(false);
      off();
    };
  }, [bandOn, talks, bandAnswer, bandNote]);

  const bandClick = useCallback(() => {
    if (bandPhaseRef.current === "thinking" || bandPhaseRef.current === "speaking") {
      bandSpeaker.current?.stop();
      setBandPhase(null);
      devlog("voice", "band mic: cut the reply short");
      endTurn("cut short by a click");
      return;
    }
    // The press has already started (or stopped) the recording on the clip itself; the finished
    // file arrives through onBandRecording. Nothing is asked of the clip here.
    if (bandRecording.current) {
      bandRecording.current = false;
      setBandPhase("thinking");
      // From here on the user is waiting: this is the moment everything after it is measured from.
      markStopTalking();
      devlog("voice", "band mic: stopped; waiting for the recording");
      // One buzz: heard you, working on it. Without it the wrist gives nothing back for the
      // seconds it takes to fetch and think. It rides the same Bluetooth link the recording is
      // about to come over, so the fetch mark in the turn's timing is worth watching: if the
      // transfer rate drops after this, move the buzz to after the download instead.
      clip.buzz(1);
      // Whether a second press stops the clip's recording or starts another one is untested, so if
      // the clip is still recording a moment later, the app stops it.
      if (bandTimer.current) clearTimeout(bandTimer.current);
      bandTimer.current = setTimeout(() => {
        if (!clip.getClipState().recording) return;
        devlog("voice", "band mic: the clip kept recording; stopping it");
        clip.stopRecording().catch((err) => {
          setBandPhase(null);
          devlog("err", "band mic: couldn't stop the clip", err instanceof Error ? err.message : String(err));
        });
      }, 2000);
      return;
    }
    bandRecording.current = true;
    setBandPhase("listening");
    startTurn("band");
    markTurn("you talk into the clip");
    devlog("voice", "band mic: the clip is recording");
    clip.buzz(1);
    if (bandTimer.current) clearTimeout(bandTimer.current);
    bandTimer.current = setTimeout(() => {
      if (!bandRecording.current) return;
      devlog("voice", "band mic: stopping after a minute");
      bandRecording.current = false;
      setBandPhase("thinking");
      markStopTalking();
      clip.stopRecording().catch((err) => {
        setBandPhase(null);
        devlog("err", "band mic: couldn't stop the clip", err instanceof Error ? err.message : String(err));
      });
    }, BAND_MAX_MS);
  }, []);

  const onClick = useCallback(
    (source: string) => {
      if (bandOn) {
        devlog("voice", `click: ${source} (band microphone)`);
        bandClick();
        return;
      }
      // Nothing to talk to on this plan, and no band to take a note with.
      if (!talks) {
        devlog("voice", `click: ${source} ignored (talking isn't part of this plan)`);
        return;
      }
      // Something else has the microphone (the tour, a made app, a voice sample).
      if (heldRef.current > 0) {
        devlog("voice", `click: ${source} ignored while the microphone is held`);
        return;
      }
      const phase = currentPhase();
      if (phase === "listening" && summonedOpen.current) {
        if (finishNow()) {
          devlog("voice", "click: sending what was said");
        } else {
          devlog("voice", "click: nothing said; closing the microphone");
          summonedOpen.current = false;
          end();
        }
        clip.buzz(1);
        return;
      }
      devlog("voice", `click: listening (${source}, phase ${phase})`);
      clip.buzz(1);
      if (phase === "off") summonedOpen.current = true;
      summon();
    },
    [summon, currentPhase, finishNow, end, bandOn, talks, bandClick],
  );
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  // The clip's button (2026-09-21): a double click turns Always listen off when it's
  // on, and otherwise starts a talk turn, like a single click used to. A single
  // click cuts a reply short or, while listening, sends what's been said; on its
  // own it does nothing, so a brushed button doesn't start a conversation.
  const onGesture = useCallback(
    (g: clip.ClipGesture) => {
      if (g === "double") {
        if (alwaysListenRef.current) {
          setAlwaysListen(false);
          clip.buzz(2);
          devlog("voice", "double click: Always listen off");
          return;
        }
        if (bandOn) {
          if (bandPhaseRef.current === "thinking" || bandPhaseRef.current === "speaking") bandSpeaker.current?.stop();
          bandRecording.current = true;
          setBandPhase("listening");
          startTurn("band");
          markTurn("you talk into the clip");
          clip.buzz(1);
          clip.startRecording().catch((err) => {
            bandRecording.current = false;
            setBandPhase(null);
            devlog("err", "band mic: couldn't start recording", err instanceof Error ? err.message : String(err));
            clip.buzz(2);
          });
          if (bandTimer.current) clearTimeout(bandTimer.current);
          bandTimer.current = setTimeout(() => {
            if (!bandRecording.current) return;
            devlog("voice", "band mic: stopping after a minute");
            bandRecording.current = false;
            setBandPhase("thinking");
            markStopTalking();
            clip.stopRecording().catch(() => setBandPhase(null));
          }, BAND_MAX_MS);
          return;
        }
        onClickRef.current("clip double click");
        return;
      }
      if (g === "stop") {
        // The press stopped the recording: the question is on its way over.
        if (!bandRecording.current) return;
        bandRecording.current = false;
        if (bandTimer.current) clearTimeout(bandTimer.current);
        setBandPhase("thinking");
        markStopTalking();
        clip.buzz(1);
        return;
      }
      // Single click: interrupt, or send what the phone mic has heard. On its own
      // it doesn't start listening: that's the double click, on either microphone
      // (the user, 2026-09-24: build 71 let a single click listen, and they want
      // the double click back).
      if (bandPhaseRef.current === "thinking" || bandPhaseRef.current === "speaking") {
        bandSpeaker.current?.stop();
        setBandPhase(null);
        endTurn("cut short by a click");
        return;
      }
      if (currentPhase() === "speaking") return conversation.interrupt();
      if (currentPhase() === "listening" && summonedOpen.current) finishNow();
    },
    [bandOn, currentPhase, finishNow],
  );
  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;

  useEffect(() => clip.onClipGesture((g) => onGestureRef.current(g)), []);

  // Pick up actions waiting from Siri, an earlier session, or something the
  // agent proposed while the app was closed. Also on every return to the app:
  // an overnight proposal would otherwise sit unseen until the next chat turn.
  useEffect(() => {
    if (!onAssistantTab || !can.chat) return;
    const pull = () =>
      api
        .pendingActions(token)
        .then((r) => {
          setApprovals(r.actions);
          r.actions.forEach(queueAuto);
        })
        .catch(logFail("assistant: r.actions.forEach"));
    pull();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") pull();
    });
    return () => sub.remove();
  }, [token, onAssistantTab, can.chat]);

  // The Assistant tab's orb stops in the background; Always listen keeps going
  // (the app has the "audio" background mode). "inactive" also fires for the
  // microphone permission prompt, so only a real trip to the background counts.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") setInForeground(false);
      else if (state === "active") setInForeground(true);
    });
    return () => sub.remove();
  }, []);

  const shouldListen =
    talks && held === 0 && tourSeen === true && (alwaysListen || (inForeground && !!enabled && !tapAsks && onAssistantTab));

  // Listening on or off, in the Dynamic Island: while a conversation runs, or twist standby is on.
  // Retried when the app comes to the front (a Live Activity can only start from there).
  // "waiting" shows as off: the loop is parked because the app isn't on screen,
  // which is exactly when the island must not claim to be listening.
  const onIsland = (phase: VoicePhase): IslandStatus => (phase === "waiting" ? "off" : phase);
  const islandStatus = bandPhase
    ? onIsland(bandPhase)
    : conversation.phase !== "off" && conversation.phase !== "waiting"
      ? onIsland(conversation.phase)
      : standby
        ? "off"
        : null;
  useEffect(() => showIsland(islandStatus), [islandStatus, inForeground]);
  // And the clip's light on whenever the microphone is: listening, and while a
  // reply is worked out or read, since the ear stays open through the turn.
  // Off when the loop is parked ("waiting"), because then the mic really is off.
  const micOn = (p: VoicePhase) => p === "listening" || p === "thinking" || p === "speaking";
  const clipListening = bandPhase ? bandPhase === "listening" : micOn(conversation.phase);
  useEffect(() => clip.setListeningLight(clipListening), [clipListening]);

  // A summoned turn with nothing else keeping the microphone open: close it after a quiet spell.
  useEffect(() => {
    if (shouldListen) summonedOpen.current = false;
    if (!summonedOpen.current || shouldListen || conversation.phase !== "listening") return;
    const timer = setTimeout(() => {
      devlog("voice", "click: nothing said; closing the microphone");
      summonedOpen.current = false;
      end();
    }, SUMMON_IDLE_MS);
    return () => clearTimeout(timer);
  }, [shouldListen, conversation.phase, conversation.words, end]);

  // One question per click: once a summoned turn has been answered (or failed), close listening.
  // Left open, talk nearby kept it open and every sentence went to the assistant (device_logs
  // 3229-3244), until the model quota ran out.
  const lastPhase = useRef(conversation.phase);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = conversation.phase;
    if (!summonedOpen.current || shouldListen || conversation.phase !== "listening") return;
    if (was !== "thinking" && was !== "speaking") return;
    devlog("voice", "click: answered; closing the microphone");
    summonedOpen.current = false;
    end();
  }, [conversation.phase, shouldListen, end]);

  // Why listening went off, for device_logs (remoteLog.ts). On 2026-09-24 it went
  // off with a question on its way, the reply was never heard, and nothing said
  // why. The phase is this render's, from before end() below turns it off.
  const wasListening = useRef(false);
  useEffect(() => {
    const was = wasListening.current;
    wasListening.current = shouldListen;
    if (!was || shouldListen) return;
    const why = [
      !talks && "voice isn't on this plan",
      held > 0 && "something else has the microphone",
      tourSeen !== true && "the tour",
      !alwaysListen && !inForeground && "the app left the screen",
      !alwaysListen && !enabled && "the orb was turned off",
      !alwaysListen && tapAsks && "tap to ask",
      !alwaysListen && !onAssistantTab && "the assistant's tab was left",
    ]
      .filter(Boolean)
      .join(", ");
    devlog("voice", `stopped listening because ${why || "a setting changed"} (${conversation.phase})`);
  }, [shouldListen]);

  useEffect(() => {
    if (!shouldListen) return;
    start().then((ok) => {
      // No microphone access: flip the switches back off.
      if (!ok) {
        setEnabled(false);
        setAlwaysListenState(false);
      }
    });
    return end;
  }, [shouldListen, start, end]);

  // Listening stopped itself (the old way's ten quiet minutes or its hour a
  // day): the orb follows, so it doesn't stay lit over a microphone that is off.
  // The reason is already on screen as the conversation's error.
  useEffect(() => {
    if (!conversation.stoppedBy || !enabled) return;
    devlog("voice", "listening stopped itself; the orb is off", conversation.stoppedBy);
    setEnabled(false);
    listeningPref.set(false);
  }, [conversation.stoppedBy]);

  // An orb left on from before, on a phone where it can't stay on: it's put away.
  useEffect(() => {
    if (!tapAsks || !enabled) return;
    setEnabled(false);
    listeningPref.set(false);
  }, [tapAsks, enabled]);

  const toggleEnabled = () => {
    if (tapAsks) {
      // One question, the click's way: summonedOpen closes it after the answer
      // or a quiet spell (the effects above).
      if (currentPhase() === "off") {
        summonedOpen.current = true;
        void summon();
      } else {
        summonedOpen.current = false;
        end();
      }
      return;
    }
    const on = !enabled;
    setEnabled(on);
    listeningPref.set(on);
  };

  const setAlwaysListen = (on: boolean) => {
    setAlwaysListenState(on);
    alwaysListenPref.set(on);
  };

  const setListenMode = (mode: ListenMode) => {
    setListenModeState(mode);
    listenModePref.set(mode);
    // "both" listens for the name as well; "twist" keeps the microphone closed until a twist.
    if (mode === "both") setAlwaysListen(true);
    if (mode === "twist") setAlwaysListen(false);
  };

  const hold = useCallback(async <T,>(fn: () => Promise<T>) => {
    heldRef.current++;
    setHeld((h) => h + 1);
    try {
      return await fn();
    } finally {
      heldRef.current--;
      setHeld((h) => h - 1);
    }
  }, []);

  const cancel = async (id: string) => {
    await api.cancelAction(token, id).catch(logFail("assistant: api.cancelAction"));
    dropApproval(id);
  };

  const value: AssistantState = {
    phase: conversation.phase,
    level: conversation.level,
    error: conversation.error,
    words: conversation.words,
    status,
    enabled,
    toggleEnabled,
    tapAsks,
    alwaysListen,
    setAlwaysListen,
    listenMode,
    setListenMode,
    micSource,
    setMicSource,
    interrupt: conversation.interrupt,
    approvals: approvals.filter((a) => !autoRunning.includes(a.id)),
    autoRunning: autoRunning.length > 0,
    approve,
    cancel,
    hold,
    askInApp: (text, appId) => ask(text, true, undefined, undefined, { app: appId }),
  };

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

/**
 * What the agent's command came to, as a notification: nobody asked for it on
 * screen, so there's no conversation for the reply to appear in.
 */
async function showAgentReply(reply: string) {
  await Notifications.scheduleNotificationAsync({
    content: { title: "🤖 OVOA agent", body: reply.slice(0, 180), data: { type: "agent-reply" } },
    trigger: null,
  }).catch(logFail("assistant: reply.slice"));
}

/** A band turn stops itself after this long, in case the second click never comes. */
const BAND_MAX_MS = 60_000;

/** Thinking for longer than this on a band turn earns a word, so the wrist isn't silent. */
const FILLER_AFTER_MS = 2200;


/** A failure, said out loud, in the words a person would use. */
function excuse(message: string) {
  if (/network|connection|offline|fetch failed|timed out|no answer from the server/i.test(message)) {
    return "Sorry, I lost the connection there. Try me again in a second.";
  }
  if (/quota|429|503|high demand|overloaded|unavailable/i.test(message)) {
    return "Sorry, my brain is busy right now. Give it a moment and ask again.";
  }
  if (/speech recognition isn't allowed/i.test(message)) return "I need to be allowed to recognise speech first. Open OVOA once and allow it, then ask me again.";
  if (/decode|recording/i.test(message)) return "Sorry, that recording didn't come through. Try once more.";
  return "Sorry, something went wrong on my end.";
}

/** After a summon, how long the microphone stays open with nothing said. */
const SUMMON_IDLE_MS = 12_000;

const LOOKUP_LABELS: Record<string, string> = {
  phone_contacts_search: "contacts",
  phone_calendar_events: "calendar",
  phone_reminders_list: "reminders",
  phone_health_summary: "Apple Health",
};

function lookupStatus(names: string[]) {
  const labels = [...new Set(names.map((n) => LOOKUP_LABELS[n] ?? "your phone"))];
  return `Checking ${labels.join(" and ")}…`;
}
