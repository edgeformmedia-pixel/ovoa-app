import { useRouter } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, type AgentNote } from "./api";
import { useAuth } from "./auth";
import { devlog } from "./devlog";
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

  // Register for push once the agent is actually on: asking for notification
  // permission before there is anything to notify about is how you get told no.
  useEffect(() => {
    if (!token || !enabled || push?.ok) return;
    registerForPush(token).then(setPush);
  }, [token, enabled, push?.ok]);

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
      if (token) await api.dismissNote(token, id).catch(() => {});
    },
    push,
    pushProblem: push && !push.ok ? pushProblem(push.reason, push.detail) : null,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used inside AgentProvider");
  return ctx;
}
