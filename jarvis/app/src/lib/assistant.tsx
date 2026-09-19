import { usePathname, useRouter } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, type ChatResponse, type PendingAction, type PhoneResult } from "./api";
import { useSession } from "./auth";
import { phoneCaps, preparePhoneAction, runPhoneAction, runPhoneLookup, type Approval } from "./phoneActions";
import { devlog } from "./devlog";
import * as clip from "./clip";
import { showIsland } from "./island";
import {
  alwaysListenPref,
  listeningPref,
  listenModePref,
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
  /** Danger zone: listen everywhere and allow talking over replies. */
  alwaysListen: boolean;
  setAlwaysListen: (on: boolean) => void;
  /** How a turn starts: the name, a wrist twist on the ES100, or either. */
  listenMode: ListenMode;
  setListenMode: (mode: ListenMode) => void;
  interrupt: () => void;
  /** Approval cards to show (auto-run ones are hidden while they run). */
  approvals: PendingAction[];
  autoRunning: boolean;
  approve: (action: PendingAction, approval: Approval) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /** Pauses listening while `fn` runs, e.g. to play a voice sample. */
  hold: <T>(fn: () => Promise<T>) => Promise<T>;
};

const AssistantContext = createContext<AssistantState | null>(null);

export function useAssistant() {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { token, user } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const onAssistantTab = pathname === ASSISTANT_PATH;

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [alwaysListen, setAlwaysListenState] = useState(false);
  const [listenMode, setListenModeState] = useState<ListenMode>("wake");
  const [held, setHeld] = useState(0);
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

  const addApprovals = (actions: PendingAction[]) => {
    setApprovals((a) => [...a, ...actions.filter((x) => !a.some((y) => y.id === x.id))]);
    actions.forEach(queueAuto);
    // Cards only show on the Assistant tab; bring the user there if one needs them.
    if (actions.some((a) => !a.auto) && !tabRef.current) router.navigate(ASSISTANT_PATH);
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
  ): Promise<string | null> => {
    if (busy.current) return null;
    busy.current = true;
    // Actions from every step of the turn; shown (or auto-run) once the reply is in.
    const parked: PendingAction[] = [];
    try {
      // Always-listening hears everything, so unless its name was said the server first
      // decides whether this was meant for the assistant.
      const ambient = ambientRef.current && !addressed;
      let res: ChatResponse = onSentence
        ? await api.sendStreamed(token, text, phoneCaps, ambient, onSentence, signal)
        : await api.send(token, text, phoneCaps, true, ambient);
      if (res.ignored) {
        devlog("voice", "not meant for the assistant; staying quiet", text);
        return null;
      }
      // The assistant may pause to look things up on this phone, possibly more than once.
      while (res.paused) {
        const { turnId, calls } = res.paused;
        parked.push(...res.pendingActions);
        setStatus(lookupStatus(calls.map((c) => c.name)));
        const results: Record<string, unknown> = {};
        for (const call of calls) results[call.id] = await runPhoneLookup(call);
        setStatus(null);
        res = onSentence
          ? await api.resumeStreamed(token, turnId, results, onSentence, signal)
          : await api.resume(token, turnId, results);
      }
      parked.push(...res.pendingActions);
      return res.messages.find((m) => m.role === "assistant")?.content ?? null;
    } finally {
      busy.current = false;
      setStatus(null);
      if (parked.length) addApprovals(parked);
    }
  };

  ambientRef.current = alwaysListen;
  const twistOn = listenMode !== "wake";
  const clipPaired = clip.useClipPaired();
  // Twist mode without Always listen: keep the mic (and the app) running so a twist works from other apps.
  const standby = twistOn && !alwaysListen && clipPaired;
  const conversation = useConversation(token, ask, {
    interruptible: alwaysListen,
    background: alwaysListen,
    standby,
    name: user?.settings.assistantName || "OVOA",
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

  const onClick = useCallback(
    (source: string) => {
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
    [summon, currentPhase, finishNow, end],
  );
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  useEffect(() => {
    if (!twistOn) return;
    // The press also starts a recording on the clip; that recording is thrown away.
    return clip.onClipButton((source) => {
      onClickRef.current(`clip button (${source})`);
      return true;
    });
  }, [twistOn]);

  // Pick up actions waiting from Siri or an earlier session.
  useEffect(() => {
    if (!onAssistantTab) return;
    api
      .pendingActions(token)
      .then((r) => {
        setApprovals(r.actions);
        r.actions.forEach(queueAuto);
      })
      .catch(() => {});
  }, [token, onAssistantTab]);

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

  const shouldListen = held === 0 && (alwaysListen || (inForeground && !!enabled && onAssistantTab));

  // Listening on or off, in the Dynamic Island: while a conversation runs, or twist standby is on.
  // Retried when the app comes to the front (a Live Activity can only start from there).
  const islandStatus = conversation.phase !== "off" ? conversation.phase : standby ? "off" : null;
  useEffect(() => showIsland(islandStatus), [islandStatus, inForeground]);
  // And green on the clip while listening.
  const clipListening = conversation.phase === "listening";
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

  const toggleEnabled = () => {
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
    setHeld((h) => h + 1);
    try {
      return await fn();
    } finally {
      setHeld((h) => h - 1);
    }
  }, []);

  const cancel = async (id: string) => {
    await api.cancelAction(token, id).catch(() => {});
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
    alwaysListen,
    setAlwaysListen,
    listenMode,
    setListenMode,
    interrupt: conversation.interrupt,
    approvals: approvals.filter((a) => !autoRunning.includes(a.id)),
    autoRunning: autoRunning.length > 0,
    approve,
    cancel,
    hold,
  };

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
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
