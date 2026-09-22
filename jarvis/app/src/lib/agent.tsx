import { useRouter } from "expo-router";
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, type AgentNote } from "./api";
import { useAuth } from "./auth";
import { devlog, logFail } from "./devlog";
import { useOptionalContext, useProviderLog } from "./context";
import { clearBadge, onNotificationTapped, pushProblem, registerForPush, type PushSetup } from "./push";

// What OVOA said while you weren't looking.
//
// The notes are written on the server and live there; this is a view of them,
// refreshed when the app comes forward and every few minutes while it is open.
// Push is what makes it timely, but nothing here depends on push having worked:
// open the app and the notes are there either way, which is what keeps the
// feature honest on a phone with notifications turned off.

/** While the app is open. Rare on purpose: the agent runs every couple of minutes at most. */
const POLL_MS = 3 * 60_000;

type AgentState = {
  notes: AgentNote[];
  unread: number;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Marks everything currently showing as read. */
  markRead: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  /** Whether this phone can be reached, and why not when it can't. */
  push: PushSetup | null;
  pushProblem: string | null;
};

const AgentContext = createContext<AgentState | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  useProviderLog("agent");
  const router = useRouter();
  const [notes, setNotes] = useState<AgentNote[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [push, setPush] = useState<PushSetup | null>(null);
  const enabled = !!token && !!user?.settings.agentEnabled;
  // Kept in a ref so the poll and the AppState listener don't need rebinding.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refresh = useCallback(async () => {
    if (!token || !enabledRef.current) return;
    setLoading(true);
    try {
      const r = await api.agentNotes(token);
      setNotes(r.notes);
      setUnread(r.unread);
      if (!r.unread) clearBadge();
    } catch (err) {
      devlog("err", "couldn't load what OVOA has been doing", String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Register for push on sign-in. It used to wait for the agent to be turned on,
  // but reminders and buzzes need the phone to be reachable whether or not the
  // agent is, and onboarding has by then explained why notifications matter.
  // Once per sign-in, tracked in a ref rather than by watching the result —
  // the result changes identity on every attempt, which would have made this
  // ask twice.
  const askedForPush = useRef<string | null>(null);
  useEffect(() => {
    if (!token || askedForPush.current === token) return;
    askedForPush.current = token;
    registerForPush(token).then(setPush);
  }, [token]);

  useEffect(() => {
    if (!enabled) {
      setNotes([]);
      setUnread(0);
      return;
    }
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    // Coming back to the app is the moment a new note is most likely waiting.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [enabled, refresh]);

  // Tapping a notification opens the note it came from.
  useEffect(() => {
    if (!token) return;
    return onNotificationTapped((data) => {
      devlog("push", "notification tapped", JSON.stringify(data));
      refresh();
      router.push("/journal");
    });
  }, [token, refresh, router]);

  const value: AgentState = {
    notes,
    unread,
    loading,
    refresh,
    markRead: async () => {
      if (!token || !unread) return;
      setUnread(0);
      setNotes((list) => list.map((n) => (n.read_at ? n : { ...n, read_at: Date.now() })));
      clearBadge();
      await api.markNotesRead(token).catch((err) => devlog("err", "couldn't mark notes read", String(err)));
    },
    dismiss: async (id) => {
      setNotes((list) => list.filter((n) => n.id !== id));
      if (token) await api.dismissNote(token, id).catch(logFail("agent: api.dismissNote"));
    },
    push,
    pushProblem: push && !push.ok ? pushProblem(push.reason, push.detail) : null,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

/**
 * What useAgent gives a screen with no provider above it: no notes, no actions.
 * A throw here took the whole screen out — /agent did exactly that on every
 * open, because it is a sibling of (tabs) in the root stack and the provider
 * was mounted inside (tabs) (device_logs, 2026-09-21).
 */
const NO_AGENT: AgentState = {
  notes: [],
  unread: 0,
  loading: false,
  refresh: async () => {},
  markRead: async () => {},
  dismiss: async () => {},
  push: null,
  pushProblem: null,
};

export function useAgent() {
  return useOptionalContext(AgentContext, "useAgent", NO_AGENT);
}
