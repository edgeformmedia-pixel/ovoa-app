import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, whenPlanKnown, whenPlanNeeded, type Plan, type PlanNeeded, type Tier } from "./api";
import { useAuth } from "./auth";
import { useConsentState } from "./consent";
import { useOptionalContext } from "./context";
import { devlog, logFail } from "./devlog";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// Which plan this person is on, and so which parts of the app are theirs.
//
// One source for every gate: GET /me's `plan` (api/src/plans.ts planView,
// docs/paywall/SPEC.md §2). The server is what actually enforces a plan; this
// is so the app can show a calm locked state ("That's for Base users", with See
// options) instead of letting a call fail, and so a phone known to be free
// never sends an AI request at all: it is stopped before it's sent (api.ts
// lockedOnPhone, which reads the plan from here). When the plan isn't known yet
// (first launch, an older server) the app behaves as it always did, and a
// needs_plan answer from any call puts it right: the plan is taken down a step
// at once and asked for again.
//
// The rules mirror the server's since v1: free has no AI; Base has every AI
// feature, the wake word, Always listen and background work included; Pro is
// only more of Base's daily usage.
//
// Kept on the phone between launches, per person, so a free phone opens on the
// free home rather than flashing the assistant first.
//
// Consent to AI (lib/consent.ts) is folded in here too: until someone on a plan
// with AI has agreed, `can` says none of it, exactly as if their plan didn't
// have it, so every screen and every listening path that asks `can` stays shut.
// `needsConsent` tells the locked states to say "Agree to use AI" (with a way
// to the consent screen) instead of "That's for Base users".

const PLAN_KEY = "ovoa.plan";
/** Coming back to the app asks again, but not more often than this. */
const FOCUS_REFRESH_MS = 60_000;
/** A burst of needs_plan answers (a screen loading four things) asks once. */
const LOCKED_REFRESH_MS = 5_000;

onSignOut("plan", () => storage.remove(PLAN_KEY));

type Stored = { userId: string; plan: Plan };

const ALL: Plan["features"] = { chat: true, voice: true, wake: true, agent: true };
const NONE: Plan["features"] = { chat: false, voice: false, wake: false, agent: false };

/** What the plan is called on screen. */
export const PLAN_NAMES: Record<Tier, string> = { free: "Free", base: "Base", pro: "Pro" };

export type PlanState = {
  /** Null until the server has said (or an older server never will). */
  plan: Plan | null;
  /** Known to be free: no AI (health, notes, the apps that call no model). False while unknown. */
  free: boolean;
  /**
   * What they can use: what the plan includes, and only once they've agreed to
   * AI. Everything while the plan isn't known: the server still decides.
   */
  can: Plan["features"];
  /** On a plan with AI, but they haven't agreed to it yet (app/consent.tsx). */
  needsConsent: boolean;
  refreshing: boolean;
  /** The plan is known, or the first ask for it has come back either way. */
  ready: boolean;
  /** Asks again. `fromSite`: ask ovoa.ai now (after joining), not the server's ten-minute answer. */
  refresh: (opts?: { fromSite?: boolean }) => Promise<void>;
};

const PlanContext = createContext<PlanState | null>(null);

/**
 * The plan with everything above `needs` taken away: what a needs_plan answer
 * proves. Mirrors the server's planView: every feature comes with Base, so a
 * paid plan has all four and free has none. (No route needs Pro any more; a
 * "pro" answer from an older server still reads as "not more than Base".)
 */
function lockedTo(plan: Plan | null, needs: PlanNeeded): Plan | null {
  const tier: Tier = needs === "pro" ? "base" : "free";
  if (plan && (plan.tier === tier || (needs === "pro" && plan.tier === "free"))) return plan;
  const base = plan ?? {
    status: "none" as const,
    trialEndsAt: null,
    renewsAt: null,
    limits: { repliesLeftToday: 0, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
  };
  const paid = tier !== "free";
  return { ...base, tier, features: { chat: paid, voice: paid, wake: paid, agent: paid } };
}

export function PlanProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const userId = user?.id ?? null;
  const [plan, setPlanState] = useState<Plan | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [asked, setAsked] = useState(false);
  const lastAsked = useRef(0);
  // Read by api.ts on every request, so an AI request from a phone known to be
  // free is stopped before it's sent. A ref: a request must see the plan as it
  // is now, not as it was when some screen last rendered.
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;
  useEffect(() => {
    whenPlanKnown(() => planRef.current?.tier ?? null);
    return () => whenPlanKnown(null);
  }, []);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const userRef = useRef(userId);
  userRef.current = userId;

  const setPlan = useCallback((next: Plan | null) => {
    setPlanState((was) => {
      if (next && was?.tier !== next.tier) devlog("log", `plan: ${was?.tier ?? "unknown"} → ${next.tier} (${next.status})`);
      return next;
    });
    const id = userRef.current;
    if (next && id) storage.set(PLAN_KEY, JSON.stringify({ userId: id, plan: next } satisfies Stored)).catch(logFail("plan: saving"));
  }, []);

  const refresh = useCallback(
    async ({ fromSite = false }: { fromSite?: boolean } = {}) => {
      const t = tokenRef.current;
      if (!t) return;
      lastAsked.current = Date.now();
      setRefreshing(true);
      try {
        if (fromSite) {
          const r = await api.refreshPlan(t);
          if (tokenRef.current === t) setPlan(r.plan);
        } else {
          const r = await api.me(t);
          // An older server has no plan: leave it unknown, and the app as it was.
          if (tokenRef.current === t && r.plan) setPlan(r.plan);
        }
      } catch (err) {
        // Offline, or the server having a bad minute: keep what was known.
        devlog("warn", "plan: couldn't ask", err instanceof Error ? err.message : String(err));
      } finally {
        setRefreshing(false);
        if (tokenRef.current === t) setAsked(true);
      }
    },
    [setPlan],
  );

  // A new person: what this phone last knew about them, then the server.
  useEffect(() => {
    setPlanState(null);
    setAsked(false);
    if (!token || !userId) return;
    let stale = false;
    storage
      .get(PLAN_KEY)
      .then((raw) => {
        if (stale || !raw) return;
        const saved = JSON.parse(raw) as Stored;
        if (saved.userId === userId && saved.plan?.tier) setPlanState((now) => now ?? saved.plan);
      })
      .catch(() => {});
    void refresh();
    return () => {
      stale = true;
    };
  }, [token, userId, refresh]);

  // Back in the app: they may have joined on the site in the meantime.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && Date.now() - lastAsked.current > FOCUS_REFRESH_MS) void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  // Any call that came back needs_plan: that part is locked now, whatever was known.
  useEffect(() => {
    whenPlanNeeded((needs) => {
      setPlanState((was) => {
        const next = lockedTo(was, needs);
        if (next !== was) devlog("log", `plan: a call needs ${needs}; showing it as locked`);
        return next;
      });
      if (Date.now() - lastAsked.current > LOCKED_REFRESH_MS) void refresh();
    });
    return () => whenPlanNeeded(null);
  }, [refresh]);

  const consent = useConsentState();
  const value = useMemo<PlanState>(() => {
    const free = plan?.tier === "free";
    const needsConsent = !free && consent === "needed";
    return {
      plan,
      free,
      can: needsConsent ? NONE : (plan?.features ?? ALL),
      needsConsent,
      refreshing,
      ready: !!plan || asked,
      refresh,
    };
  }, [plan, consent, refreshing, asked, refresh]);
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

const UNKNOWN: PlanState = { plan: null, free: false, can: ALL, needsConsent: false, refreshing: false, ready: true, refresh: async () => {} };

export function usePlan() {
  return useOptionalContext(PlanContext, "usePlan", UNKNOWN);
}

/** "Sep 29": a trial's end or a renewal, in the reader's own calendar. */
export function planDate(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
