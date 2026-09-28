import type { Context, MiddlewareHandler } from "hono";
import { aiConsentFor, CONSENT_NEEDED } from "./consent";
import type { GateCall, LlmEnv, ModelRefused, Refusal } from "./llm";
import { say } from "./obs";
import { ttsCostMicro } from "./pricing";
import type { Env, Vars } from "./types";

// Plans: free, base, plus and pro (docs/paywall/SPEC.md; the v1 release brief
// wins where they differ).
//
// Free is health, notes and every app that doesn't use AI. Base is the AI:
// talking to OVOA, the wake word, Always listen, making apps. Plus (added
// 2026-09-27) adds background work, the agent's jobs and goals, and 2.5x
// Base's daily usage. Pro is four times Base's daily usage and nothing more. The
// site (ovoa.ai) sells the plans and says which tier an email is on; this file
// asks it, remembers the answer, and decides what each route, each cron job
// and each model call may do for the person asking.
//
// Three promises, in order of importance:
//   1. Nobody who pays is locked out because ovoa.ai had a blip. The last good
//      answer stands for a day, and until the site's key is set on this Worker
//      everyone is treated as pro, so shipping this can't lock out a tester.
//   2. A free person never costs a model call or a voice: every route that
//      calls a model is behind requirePlan below, the cron jobs that call
//      models ask mayRunFor first, and every model call asks modelGate (the
//      gate, near the end) before anything is sent.
//   3. A day's AI costs no more than its plan's budget: Base $0.10, Plus
//      $0.25, Pro $0.40 (the
//      allowance section below has the arithmetic).

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------
//
// Every route and cron job, and which plan it needs. First match wins. A
// signed-in route that matches nothing needs base: a new route that spends
// money is paid until someone decides otherwise, never free by accident.
//
// The rule (2026-09-23): charge only for what uses AI. Every route that never
// calls a model is free, whatever it's for; the ones that do are Base. No route
// needs Pro: Pro is more of the same allowance, not more features. This table
// is the early reject, so a free phone gets a 402 before anything is read; the
// model-call gate (modelGate) is what actually stands in front of every model.
//
// Public (no sign-in, never gated):
//   GET  /                        health check
//   POST /auth/*                  sign up, sign in, email codes, Google
//   GET  /google/callback         OAuth return
//   GET  /shortcuts/file/:t/:name signed shortcut download
//   POST /logs                    phone logs
//   *    /debug/*                 DEBUG_KEY only (engines, usage, ticks, plan, verify)
//
// Signed in: see ROUTE_TIERS just below; the `why` on each line is the reason.
//
// Cron jobs (index.ts runTick). Only the ones that call a model are gated, by
// their own silent pre-check (blockedFor, mayRunFor, lazyCheck) and then by the
// gate on each model call, which they treat as a skip:
//   */2 clock lane  alarms, routines, escalate, note reminders   no model: run for everyone
//   */2 slow lane   agent jobs (agent.ts runJob)                 PLUS (model)
//                   evening list (todos.ts)                      no model: runs for everyone
//                   transcript titles (transcripts.ts)           BASE (model)
//                   rhythm: morning brief (rhythm.ts)            BASE (model); wind-down,
//                                                                 commute and oddities have none
//                   extras: inbox triage, follow-ups, bills      BASE (model); meeting prep
//                           (extras.ts)                           and the weekly report have none
//                   money reminders (money.ts)                   no model: runs for everyone
//   13 4 nightly    learn places, expectations                   no model
//                   relearn Google accounts (google/routing.ts)  BASE (model)
//                   day summaries (daysummary.ts)                BASE (model)
//                   the 14-day purge (retention.ts)              no model: runs for everyone
// And one request-time model call on a free route: a detected workout's
// one-line summary (heart.ts) is written by a model only for the paid plans;
// free gets the plain sentence the code already had as its fallback.

export type Tier = "free" | "base" | "plus" | "pro";
export const TIERS: readonly Tier[] = ["free", "base", "plus", "pro"];
const RANK: Record<Tier, number> = { free: 0, base: 1, plus: 2, pro: 3 };

export const isTier = (v: unknown): v is Tier => typeof v === "string" && (TIERS as readonly string[]).includes(v);
/** Whether `have` includes everything `need` does. */
export const atLeast = (have: Tier, need: Tier) => RANK[have] >= RANK[need];

type RouteRule = { method: string; path: RegExp; tier: Tier; why: string };

export const ROUTE_TIERS: RouteRule[] = [
  // Removing your own things is always allowed, whatever the plan: data, a
  // connection, a Siri key, a job. A downgrade must never trap anything.
  { method: "DELETE", path: /./, tier: "free", why: "deleting your own data or connections" },

  // Free: the account, the phone, health, notes.
  { method: "*", path: /^\/auth\/logout$/, tier: "free", why: "sign out" },
  { method: "*", path: /^\/me(\/password|\/plan\/refresh)?$/, tier: "free", why: "the account and its settings" },
  { method: "POST", path: /^\/me\/email\/(code|verify)$/, tier: "free", why: "proving the account's address with the emailed code" },
  { method: "POST", path: /^\/me\/consent$/, tier: "free", why: "agreeing to AI (taking it back is a DELETE)" },
  { method: "POST", path: /^\/me\/terms$/, tier: "free", why: "agreeing to the Terms (no app without them)" },
  { method: "*", path: /^\/(device\/state|capabilities)$/, tier: "free", why: "what the phone and band have" },
  { method: "POST", path: /^\/buzz\/test$/, tier: "free", why: "band buzz test, no model" },
  { method: "*", path: /^\/push\/token$/, tier: "free", why: "push registration" },
  { method: "*", path: /^\/usage\/(stream|me)$/, tier: "free", why: "reporting and reading usage" },
  // Speech to text moved onto the phone (voice.ts). Old builds still ask; free,
  // so every one of them hears "update from TestFlight" rather than a 402.
  { method: "POST", path: /^\/voice\/(transcribe|token)$/, tier: "free", why: "gone: answers 410 for old builds" },
  { method: "*", path: /^\/engines$/, tier: "free", why: "development accounts only, checked in the handler" },
  { method: "POST", path: /^\/debug\/(commands|food\/log)$/, tier: "free", why: "DEBUG_KEY only" },
  { method: "*", path: /^\/notes(\/[^/]+)?$/, tier: "free", why: "notes" },
  // Logging food is a chat turn (base); the Calorie screen only reads and fixes it.
  { method: "*", path: /^\/food(\/settings|\/log\/[^/]+)?$/, tier: "free", why: "the Calorie screen: reading, fixing and its settings, no model" },
  { method: "*", path: /^\/(hr|hr\/today|workouts)(\/.*)?$/, tier: "free", why: "health: heart rate and workouts" },
  { method: "*", path: /^\/health\/days$/, tier: "free", why: "health: the day's numbers from Apple Health, no model" },
  { method: "*", path: /^\/(steps|contacts|safety-events)(\/[^/]+)?$/, tier: "free", why: "health and safety" },
  { method: "GET", path: /^\/feed$/, tier: "free", why: "the day spine, built from rows, no model" },
  { method: "GET", path: /^\/profile$/, tier: "free", why: "reading your own profile" },
  { method: "GET", path: /^\/apps$/, tier: "free", why: "reading the apps you made" },
  { method: "GET", path: /^\/(chat\/messages|memories)$/, tier: "free", why: "reading your own history" },
  // The agent's outbox and controls: anyone can see what it did and stop it.
  { method: "GET", path: /^\/agent\/(notes|jobs|goals|runs)$/, tier: "free", why: "seeing what the agent did" },
  { method: "POST", path: /^\/agent\/notes\/read$/, tier: "free", why: "clearing the outbox" },
  { method: "PATCH", path: /^\/agent\/(jobs|goals)\/[^/]+$/, tier: "free", why: "pausing background work" },
  // Filled only by the agent, polled by every phone; empty for everyone else.
  { method: "*", path: /^\/commands(\/pending|\/[^/]+\/done)?$/, tier: "free", why: "the phone's command queue" },

  // Free: everything else that never calls a model (decision 5, 2026-09-23).
  // What they feed later (a turn, a cron) is gated where the model is called.
  { method: "*", path: /^\/(routines|todos|money|alarms|nags|people|favors|locations|places)(\/.*)?$/, tier: "free", why: "lists, reminders, money, people and places: no model" },
  { method: "POST", path: /^\/apps\/(design|revise)$/, tier: "base", why: "a model designs the app, or changes it" },
  { method: "*", path: /^\/apps(\/[^/]+(\/state)?)?$/, tier: "free", why: "saving an app you designed, and editing it or its screen by hand" },
  { method: "GET", path: /^\/transcripts\/(day\/[^/]+|lines|search)$/, tier: "free", why: "reading your transcripts" },
  { method: "*", path: /^\/context\/commitments(\/[^/]+)?$/, tier: "free", why: "what you said you'd do, and marking it done" },
  { method: "*", path: /^\/google\/(status|connect|callback|accounts\/[^/]+)$/, tier: "free", why: "connecting Google and managing its accounts" },
  { method: "GET", path: /^\/actions$/, tier: "free", why: "the actions waiting for your OK" },
  { method: "POST", path: /^\/actions\/[^/]+\/approve$/, tier: "free", why: "approving one: it runs as written, no model" },
  { method: "POST", path: /^\/siri\/key$/, tier: "free", why: "making the Siri key (asking through it is base)" },
  // Texting OVOA itself arrives on the webhook (public) and is checked there,
  // like a turn (index.ts textTurn): these only link and unlink the number, and
  // turn texting first on or off.
  { method: "*", path: /^\/texting(\/link)?$/, tier: "free", why: "linking the number you text OVOA from (texting it is base)" },
  // Websites are built by a model, from a turn (base, and gated at the model
  // call); listing and deleting the ones you have calls none.
  { method: "GET", path: /^\/sites$/, tier: "free", why: "the websites you have (building one is a turn)" },
  // Your @username (usernames.ts): picking, checking and changing it calls no model.
  { method: "*", path: /^\/me\/username(\/check)?$/, tier: "free", why: "your username, and whether one is free" },
  // OVOA to OVOA (network.ts): connecting, permissions, answering what waits for
  // you and the log call no model; asking another OVOA something is base, like
  // the assistant that usually does it.
  { method: "POST", path: /^\/ovoa\/ask$/, tier: "base", why: "asking another OVOA something" },
  { method: "*", path: /^\/ovoa\/(connect|connections|log|approvals\/[^/]+|connections\/[^/]+(\/answer|\/perms)?)$/, tier: "free", why: "your OVOA connections, their permissions, answering what waits for you, the log" },

  // Base: everything that calls a model, or voices a reply. Listed so the table
  // reads whole; the default is base anyway.
  { method: "POST", path: /^\/(chat|chat\/resume|siri)$/, tier: "base", why: "chat and Siri" },
  { method: "POST", path: /^\/texting\/try$/, tier: "base", why: "a text answered in the response instead of by text (the probes)" },
  { method: "GET", path: /^\/brief$/, tier: "base", why: "the morning brief" },
  { method: "POST", path: /^\/voice\/speak$/, tier: "base", why: "OVOA's voice (Deepgram)" },
  { method: "*", path: /^\/context\//, tier: "base", why: "the timeline (summaries are a model)" },
  { method: "*", path: /^\/onboarding(\/.*)?$/, tier: "base", why: "the setup conversation (a model)" },
  { method: "POST", path: /^\/agent\/(jobs|goals)$/, tier: "plus", why: "setting up background work" },
  { method: "POST", path: /^\/agent\/jobs\/[^/]+\/run$/, tier: "plus", why: "running background work now" },
  { method: "POST", path: /^\/transcripts\/heard$/, tier: "base", why: "overheard lines, kept for the timeline" },
];

/** Which plan a signed-in request needs. Pure. */
export function tierForRoute(method: string, path: string): Tier {
  const m = method.toUpperCase();
  for (const r of ROUTE_TIERS) {
    if ((r.method === "*" || r.method === m) && r.path.test(path)) return r.tier;
  }
  return "base";
}

// ---------------------------------------------------------------------------
// What a person is on
// ---------------------------------------------------------------------------

export type PlanStatus = "trialing" | "active" | "past_due" | "canceled" | "comp" | "none";
const STATUSES: readonly PlanStatus[] = ["trialing", "active", "past_due", "canceled", "comp", "none"];
const isStatus = (v: unknown): v is PlanStatus => typeof v === "string" && (STATUSES as readonly string[]).includes(v);

export type Plan = {
  tier: Tier;
  status: PlanStatus;
  trialEndsAt: string | null;
  renewsAt: string | null;
  /**
   * How the answer was reached. For logs and Dev tools, never for the app's
   * logic: "override" (DEBUG_KEY), "no_key" (the site isn't wired up yet, so
   * everyone is pro), "site" (asked just now), "cache" (asked in the last ten
   * minutes), "stale" (the site is down; last answer, under a day old),
   * "fallback" (never answered, or over a day ago: free), "trial" (a free
   * account answering one of its number's trial texts: guest.ts).
   */
  from: "override" | "no_key" | "site" | "cache" | "stale" | "fallback" | "trial";
};

/** The site is asked at most this often per person. */
export const PLAN_FRESH_MS = 10 * 60_000;
/** While the site is down, the last good answer stands this long; then free. */
export const PLAN_GRACE_MS = 24 * 3_600_000;
export const DEFAULT_MEMBERSHIP_URL = "https://ovoa.ai/api/public/membership";

export type PlanRow = {
  email: string;
  plan_tier: string | null;
  plan_status: string | null;
  plan_checked_at: number | null;
  plan_trial_ends_at: string | null;
  plan_renews_at: string | null;
  plan_override: string | null;
};

const FREE: Plan = { tier: "free", status: "none", trialEndsAt: null, renewsAt: null, from: "fallback" };

/**
 * What the row alone says: the plan to use now, and whether the site should be
 * asked. Pure, so the cache and the fallback can be tested on fixed clocks.
 */
export function planFromRow(row: PlanRow, now: number, keySet: boolean): { plan: Plan; ask: boolean } {
  if (isTier(row.plan_override)) {
    // "comp", like access given from the site's admin page; a free override has nothing to comp.
    const status: PlanStatus = row.plan_override === "free" ? "none" : "comp";
    return { plan: { tier: row.plan_override, status, trialEndsAt: null, renewsAt: null, from: "override" }, ask: false };
  }
  if (!keySet) return { plan: { tier: "pro", status: "comp", trialEndsAt: null, renewsAt: null, from: "no_key" }, ask: false };
  const age = row.plan_checked_at == null ? Infinity : Math.max(0, now - row.plan_checked_at);
  if (isTier(row.plan_tier) && age < PLAN_GRACE_MS) {
    return {
      plan: {
        tier: row.plan_tier,
        status: isStatus(row.plan_status) ? row.plan_status : "none",
        trialEndsAt: row.plan_trial_ends_at,
        renewsAt: row.plan_renews_at,
        from: age < PLAN_FRESH_MS ? "cache" : "stale",
      },
      ask: age >= PLAN_FRESH_MS,
    };
  }
  return { plan: FREE, ask: true };
}

export type Membership = { tier: Tier; status: PlanStatus; trialEndsAt: string | null; renewsAt: string | null };

/** The site's answer, or null when it isn't one (a changed or broken site is "down", not "free"). */
export function parseMembership(body: unknown): Membership | null {
  const b = body as Record<string, unknown> | null;
  if (!b || !isTier(b.tier)) return null;
  const date = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 40) : null);
  return { tier: b.tier, status: isStatus(b.status) ? b.status : "none", trialEndsAt: date(b.trialEndsAt), renewsAt: date(b.renewsAt) };
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Asks the site. Null means it couldn't say (down, slow, changed): the caller
 * keeps what it had. Only a parsed answer counts: the site says "free" with a
 * 200 for someone who never paid, so a 404 is a missing or unpublished route
 * (ovoa.ai without the membership code), not a verdict on the person.
 */
export async function fetchMembership(env: Pick<Env, "MEMBERSHIP_API_KEY" | "MEMBERSHIP_URL">, email: string, fetcher: Fetcher = fetch): Promise<Membership | null> {
  const url = `${env.MEMBERSHIP_URL || DEFAULT_MEMBERSHIP_URL}?email=${encodeURIComponent(email)}`;
  try {
    const res = await fetcher(url, {
      headers: { authorization: `Bearer ${env.MEMBERSHIP_API_KEY}`, accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      say("plan", { outcome: "site error", status: res.status });
      return null;
    }
    const parsed = parseMembership(await res.json().catch(() => null));
    if (!parsed) say("plan", { outcome: "site answered nonsense" });
    return parsed;
  } catch (err) {
    say("plan", { outcome: "site unreachable", why: err instanceof Error ? err.name : "error" });
    return null;
  }
}

// Per isolate, like the session cache in auth.ts: a spoken reply is one /chat
// and several /voice/speak, and each would otherwise read the users row again.
// An override or a refresh on another isolate shows here within MEMO_MS.
const MEMO_MS = 60_000;
const MEMO_MAX = 5_000;
const memo = new Map<string, { plan: Plan; email: string; at: number }>();
/** After the site fails, nobody asks it again for this long (per isolate). */
const SITE_BACKOFF_MS = 60_000;
let siteDownUntil = 0;
let warnedNoKey = false;
/** People whose plan is being asked about after a reply (loadPlan's waitUntil), so it's asked once. */
const refreshing = new Set<string>();

/** Forgets what this isolate remembered about one person (or everyone). */
export function forgetPlan(userId?: string) {
  if (userId) memo.delete(userId);
  else {
    memo.clear();
    siteDownUntil = 0;
  }
}

type PlanOptions = {
  force?: boolean;
  now?: number;
  fetcher?: Fetcher;
  /**
   * Work that can finish after the reply (ExecutionContext.waitUntil). With it,
   * a tier the site gave within the day stands while the site is asked again
   * afterwards: that ask took up to 4 s at the start of a /chat, once every ten
   * minutes per person (PLAN_FRESH_MS), before the turn had begun.
   */
  waitUntil?: (work: Promise<unknown>) => void;
};

/**
 * The person's plan, and their email (for the development-account check).
 * `force` asks the site even when the cached answer is fresh: that is what
 * POST /me/plan/refresh is for, right after a checkout. Null: no such person.
 */
export async function loadPlan(
  env: Env,
  userId: string,
  { force = false, now = Date.now(), fetcher, waitUntil }: PlanOptions = {},
): Promise<{ plan: Plan; email: string } | null> {
  const hit = memo.get(userId);
  if (!force && hit && now - hit.at < MEMO_MS) return hit;
  const row = await env.DB.prepare(
    `SELECT email, plan_tier, plan_status, plan_checked_at, plan_trial_ends_at, plan_renews_at, plan_override
       FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<PlanRow>();
  if (!row) return null;
  const keySet = !!env.MEMBERSHIP_API_KEY;
  if (!keySet && !warnedNoKey) {
    warnedNoKey = true;
    console.warn("ovoa.plan MEMBERSHIP_API_KEY is not set: everyone is treated as pro until it is");
  }
  let { plan, ask } = planFromRow(row, now, keySet);
  const overridden = plan.from === "override" || plan.from === "no_key";
  if (!overridden && (ask || force) && (force || now >= siteDownUntil)) {
    if (!force && waitUntil && plan.from === "stale") {
      if (!refreshing.has(userId)) {
        refreshing.add(userId);
        waitUntil(askSite(env, userId, row, plan, now, fetcher).finally(() => refreshing.delete(userId)));
      }
    } else {
      plan = await askSite(env, userId, row, plan, now, fetcher);
    }
  }
  return remember(userId, plan, row.email, now);
}

// A free account answering one of its number's free trial texts (guest.ts)
// reaches AI as Base for that one text. Per isolate on purpose: the text's
// turn runs here, and the crons elsewhere never see it, so a trial doesn't
// grow background work.
const TRIAL_TURN_MS = 3 * 60_000;
const trialTurns = new Map<string, number>();

/** Lets this free account's next few minutes of AI through, for one trial text. */
export function grantTrialTurn(userId: string, now = Date.now()) {
  trialTurns.set(userId, now + TRIAL_TURN_MS);
  if (trialTurns.size > MEMO_MAX) trialTurns.delete(trialTurns.keys().next().value!);
}

function withTrial<T extends { plan: Plan }>(userId: string, entry: T, now: number): T {
  if (entry.plan.tier !== "free" || (trialTurns.get(userId) ?? 0) < now) return entry;
  return { ...entry, plan: { ...entry.plan, tier: "base", from: "trial" } };
}

function remember(userId: string, plan: Plan, email: string, now: number) {
  const entry = { plan, email, at: now };
  memo.delete(userId);
  memo.set(userId, entry);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return entry;
}

/** Asks the site and keeps its answer; `had` when it couldn't say. */
async function askSite(env: Env, userId: string, row: PlanRow, had: Plan, now: number, fetcher?: Fetcher): Promise<Plan> {
  const got = await fetchMembership(env, row.email, fetcher);
  if (!got) {
    siteDownUntil = now + SITE_BACKOFF_MS;
    say("plan", { user: userId, outcome: "kept", tier: had.tier, from: had.from });
    return had;
  }
  const plan: Plan = { ...got, from: "site" };
  await env.DB.prepare(
    `UPDATE users SET plan_tier = ?, plan_status = ?, plan_checked_at = ?, plan_trial_ends_at = ?, plan_renews_at = ?
      WHERE id = ?`,
  )
    .bind(got.tier, got.status, now, got.trialEndsAt, got.renewsAt, userId)
    .run()
    .catch((err: unknown) => console.error("ovoa.err plan: couldn't keep the answer", err));
  if (got.tier !== row.plan_tier) say("plan", { user: userId, was: row.plan_tier ?? "unknown", now: got.tier, status: got.status });
  // Asked after the reply: the next request here sees the answer.
  remember(userId, plan, row.email, now);
  return plan;
}

export async function planFor(env: Env, userId: string, opts: Pick<PlanOptions, "waitUntil"> = {}): Promise<Plan> {
  const loaded = await loadPlan(env, userId, opts);
  return loaded ? withTrial(userId, loaded, Date.now()).plan : FREE;
}

/** Sets or clears the developer's override. Null clears it. */
export async function setPlanOverride(env: Env, userId: string, tier: Tier | null) {
  const { meta } = await env.DB.prepare("UPDATE users SET plan_override = ? WHERE id = ?").bind(tier, userId).run();
  forgetPlan(userId);
  return (meta.changes ?? 0) > 0;
}

/**
 * The accounts that are never capped and may use the development switches.
 * Named in wrangler.jsonc rather than in the database, so no request can grant it.
 */
export function isDevEmail(env: Pick<Env, "DEV_EMAILS">, email: string) {
  const allowed = (env.DEV_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.length > 0 && allowed.includes(email.toLowerCase());
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type NeedsPlan = { error: "needs_plan"; needs: "base" | "plus" | "pro"; message: string };

/**
 * The 402 body (SPEC §2). The app keys off `error`, never off the status alone.
 * Background work needs Plus. No route needs Pro (Pro is usage, not
 * features); "pro" stays in the contract because the app still reads it.
 * Builds from before Plus read "plus" as "base", and show `message` either way.
 */
export function needsPlanBody(needs: "base" | "plus" | "pro"): NeedsPlan {
  return {
    error: "needs_plan",
    needs,
    message:
      needs === "pro"
        ? "That's for Pro users. Plans are on ovoa.ai."
        : needs === "plus"
          ? "Background work is for Plus users. Plans are on ovoa.ai."
          : "That's for Base users. Your health, notes and the apps that don't use AI stay free. Plans are on ovoa.ai.",
  };
}

export function needsPlan(c: Context, needs: "base" | "plus" | "pro") {
  return c.json(needsPlanBody(needs), 402);
}

/**
 * For signed-in routes: answers 402 when the person's plan doesn't include the
 * route (ROUTE_TIERS). A free route never reads the plan at all. The plan is
 * left on the context for the handler (the allowance needs its tier).
 */
export function requirePlan(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const need = tierForRoute(c.req.method, c.req.path);
    if (need === "free") return next();
    const plan = await planFor(c.env, c.var.userId, { waitUntil: (work) => c.executionCtx.waitUntil(work) });
    c.set("plan", plan);
    if (!atLeast(plan.tier, need)) {
      say("plan", { outcome: "402", user: c.var.userId, path: c.req.path, has: plan.tier, needs: need });
      return needsPlan(c, need);
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// The daily allowance
// ---------------------------------------------------------------------------
//
// Since 2026-09-28 a plan is a daily usage budget in dollars, not a count of
// replies. Everything a person's AI costs draws on it at its real price, read
// from usage_daily (usage.ts, pricing.ts): the model reading and writing each
// reply, the spoken voice, web searches, recorded clips, the morning brief,
// memory, background work. So talking uses the day faster than typing (the
// voice is most of a spoken reply), a search faster still, and a quiet day
// leaves the budget for replies. What a reply costs, measured on production
// 2026-09-21..27 at list prices (Z.ai GLM 5.3 Flash, Aura-2):
//
//   a typed or texted reply   about $0.0013   the model, and a search now and then
//   a spoken reply            about $0.0034   the same, plus about 70 characters voiced
//   a reply that searches     about $0.011    Z.ai's search is $0.01
//
// The budgets (the user's call, 2026-09-28): Base is the most profitable plan,
// Plus has 2.5x Base's usage, and Pro 4x with a wide margin:
//
//   Base  $0.10 a day   about 45 average replies   $9.95: at most $3.00 a month of AI
//   Plus  $0.25 a day   about 110                  $13.95: at most $7.50
//   Pro   $0.40 a day   about 180                  $25.95: at most $12.00
//
// New work stops once the day's spend is within one spoken reply of the
// budget (REPLY_MARGIN_MICRO), so the reply that crosses the line can't carry
// the day far past it. The spend is checked where a turn starts (index.ts
// chatTurn) and by the gate on every model call (modelGate), which is what
// stops the crons and the other model routes once the day is spent.
//
// Counted per UTC day, because usage_daily is (usage.ts); the person is told
// the reset in their own time. There is no monthly cap any more: the daily
// budget already bounds a month (cap.ts is kept for a plan that sets one).
// Development accounts are exempt from all of it.

/** One spoken reply at today's measured cost, in micro-dollars: the margin new work stops short of the budget by. */
export const REPLY_MARGIN_MICRO = 3_400;
/** An average reply (typed and spoken as people use them), for turning a budget into "about N replies". */
export const AVERAGE_REPLY_MICRO = 2_200;

// Credits (2026-09-28): what people see instead of dollars. One credit is
// $0.00001 (10 micro-dollars), so Base's $0.10 a day is 10,000 credits, sold as
// 300,000 a month. Only a unit for showing the budget: enforcement stays in
// micro-dollars, and a reply costs whatever it really costs in credits (about
// 130 typed, 340 spoken). The site (ovoa-team membership/copy.ts) uses the same.
export const CREDIT_MICRO = 10;
/** Micro-dollars to whole credits, rounded down. */
export const creditsOf = (micro: number) => Math.max(0, Math.floor(micro / CREDIT_MICRO));

export const BASE_DAILY_BUDGET_MICRO = 100_000;
/** Plus is 2.5x Base, Pro 4x (2026-09-28). */
export const PLUS_DAILY_BUDGET_MICRO = 250_000;
export const PRO_DAILY_BUDGET_MICRO = 400_000;

/** Per plan: the day's usage budget in micro-dollars, and replies a calendar month (cap.ts; 0 = no monthly cap). */
export const ALLOWANCES: Record<Tier, { budgetMicro: number; monthly: number }> = {
  free: { budgetMicro: 0, monthly: 0 },
  base: { budgetMicro: BASE_DAILY_BUDGET_MICRO, monthly: 0 },
  plus: { budgetMicro: PLUS_DAILY_BUDGET_MICRO, monthly: 0 },
  pro: { budgetMicro: PRO_DAILY_BUDGET_MICRO, monthly: 0 },
};

/** The spend at which new work stops for the day: one spoken reply short of the budget. */
export const spendStopMicro = (tier: Tier) => Math.max(0, ALLOWANCES[tier].budgetMicro - REPLY_MARGIN_MICRO);

export type Allowance = {
  /** Share of today's budget used, 0-100. */
  usedPercent: number;
  /** About how many average replies are left today: an estimate, for builds that show a number. */
  left: number;
  /** Credits left today (CREDIT_MICRO), counted to the stop line, and the day's full amount. */
  creditsLeft: number;
  creditsPerDay: number;
  /** Set when today is used up. */
  over: null | "spend";
};

/** Where a person stands today, from what today has cost them. Pure. */
export function allowanceFor(tier: Tier, microToday: number): Allowance {
  const { budgetMicro } = ALLOWANCES[tier];
  const stop = spendStopMicro(tier);
  const over = !budgetMicro || microToday >= stop ? "spend" : null;
  return {
    usedPercent: budgetMicro ? Math.min(100, Math.round((Math.max(0, microToday) / budgetMicro) * 100)) : 100,
    left: over ? 0 : Math.max(1, Math.floor((stop - microToday) / AVERAGE_REPLY_MICRO)),
    creditsLeft: over ? 0 : creditsOf(budgetMicro - Math.max(0, microToday)),
    creditsPerDay: creditsOf(budgetMicro),
    over,
  };
}

/** The next UTC midnight, when usage_daily starts a new day. */
export function nextUtcMidnight(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** "at 7:00 PM", or "at 2:00 AM tomorrow" when the reset falls on the person's next day. */
export function resetPhrase(now: number, timeZone: string) {
  const at = nextUtcMidnight(now);
  const time = new Date(at).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const day = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone });
  return day(at) === day(now) ? `at ${time}` : `at ${time} tomorrow`;
}

/** One sentence, spoken or shown, when today's allowance is used up. A reply, not an error. */
export function allowanceMessage(_a: Allowance, now: number, timeZone: string) {
  return `You've used today's credits on your plan, so I'll pick up again ${resetPhrase(now, timeZone)}.`;
}

/** What today (UTC, like usage_daily) has cost this person so far, in micro-dollars. */
async function usedToday(env: Env, userId: string, now = Date.now()) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(est_micro_usd), 0) AS micro FROM usage_daily WHERE user_id = ? AND day = ?")
    .bind(userId, new Date(now).toISOString().slice(0, 10))
    .first<{ micro: number }>();
  return { micro: row?.micro ?? 0 };
}

/**
 * Whether today's usage budget is spent. Once it is, nothing more runs on AI
 * for this person until the reset: not a text, not a cron job, not a game or a
 * site (2026-09-27, a hard cut-off).
 */
const dayUsedUp = (tier: Tier, used: { micro: number }) => used.micro >= spendStopMicro(tier);

/**
 * For work nobody asked for this minute (the cron, a workout summary): null
 * when this person's plan covers `need`, they have agreed to AI, and today's
 * spend is still under its line; otherwise why not. The same questions the
 * model-call gate asks, asked before any work is built, so a cron can skip a
 * person quietly and say why. Never throws: when in doubt, the work waits.
 */
export async function blockedFor(env: Env, userId: string, need: Tier): Promise<null | "plan" | "consent" | "allowance"> {
  try {
    const loaded = await loadPlan(env, userId);
    if (!loaded || !atLeast(loaded.plan.tier, need)) return "plan";
    if ((await aiConsentFor(env, userId)) !== "given") return "consent";
    if (isDevEmail(env, loaded.email)) return null;
    return dayUsedUp(loaded.plan.tier, await usedToday(env, userId)) ? "allowance" : null;
  } catch (err) {
    console.error("ovoa.err plan: couldn't check a plan for background work", err);
    return "plan";
  }
}

export async function mayRunFor(env: Env, userId: string, need: Tier) {
  return (await blockedFor(env, userId, need)) === null;
}

/** Memoised per call site: a sweep asks at most once per person, and only if it gets that far. */
export function lazyCheck(env: Env, userId: string, need: Tier) {
  let answer: Promise<boolean> | null = null;
  return () => (answer ??= mayRunFor(env, userId, need));
}

// ---------------------------------------------------------------------------
// The model-call gate
// ---------------------------------------------------------------------------
//
// llm.ts asks this before every model call (setModelGate, registered once in
// index.ts), web search grounding included, and sends nothing when it says no.
// Three questions, in order:
//
//   1. The plan. Free never reaches a model: needs_plan.
//   2. Today's usage budget, spent (spendStopMicro): allowance. Since
//      2026-09-27 this is a hard cut-off: once the day's budget is gone, no AI
//      runs for that person at all (texts, crons, games, sites) until the reset. A resumed turn
//      (GateCall.continuing) isn't asked: it was let in when it began.
//      Development accounts have no line.
//   3. Consent (consent.ts aiConsentFor): needs_consent until they've agreed.
//
// The crons ask the same questions first through blockedFor and friends, and
// skip quietly; this is the backstop behind them, and the one door a new
// caller can't forget.
//
// Fails closed on the plan: a database error reading it fails the call as an
// ordinary error, and nothing is sent. Fails open on the spend: a person on a
// plan whose day couldn't be read this once isn't refused for it (the check
// at the start of their turn, and blockedFor for the crons, still hold).
// A call with no person (userId null) is only ever a DEBUG_KEY route's.

export async function modelGate(env: Env, call: GateCall, now = Date.now()): Promise<Refusal | null> {
  if (!call.userId) return null;
  const raw = await loadPlan(env, call.userId);
  const loaded = raw && withTrial(call.userId, raw, now);
  if (!loaded || !atLeast(loaded.plan.tier, "base")) return "needs_plan";
  if (!call.continuing && !isDevEmail(env, loaded.email)) {
    const used = await usedToday(env, call.userId, now).catch((err: unknown) => {
      console.error("ovoa.err plan: couldn't read today's usage for a model call; letting it through", err);
      return { micro: 0 };
    });
    if (dayUsedUp(loaded.plan.tier, used)) {
      say("plan", { outcome: "refused", user: call.userId, why: "allowance", purpose: call.purpose });
      return "allowance";
    }
  }
  if ((await aiConsentFor(env, call.userId)) !== "given") {
    say("plan", { outcome: "refused", user: call.userId, why: "consent", purpose: call.purpose });
    return "needs_consent";
  }
  return null;
}

/** For setModelGate: llm.ts hands over its own env type, which on this Worker is the whole Env. */
export const modelGateFor = (env: LlmEnv, call: GateCall) => modelGate(env as Env, call);

/** The one sentence a person hears or reads when a model call was refused. `timeZone` says when the day resets. */
export function refusalMessage(reason: Refusal, tier: Tier, now: number, timeZone: string) {
  if (reason === "needs_plan") return needsPlanBody("base").message;
  if (reason === "needs_consent") return CONSENT_NEEDED;
  return allowanceMessage(allowanceFor(tier, ALLOWANCES[tier].budgetMicro), now, timeZone);
}

/** A time zone Intl knows, or UTC. */
function zoneOr(tz: unknown) {
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * A route's answer when its model call was refused (llm.ts ModelRefused): 402
 * needs_plan (the body the app already knows), 429 allowance, or 403
 * needs_consent, each with `message`, the sentence to show. The app keys off
 * `error`, as it does for needs_plan.
 */
export async function refusedResponse(c: Context<{ Bindings: Env; Variables: Vars }>, err: ModelRefused) {
  if (err.reason === "needs_plan") return needsPlan(c, "base");
  const [settings, plan] = await Promise.all([
    c.env.DB.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(c.var.userId).first<{ time_zone: string | null }>().catch(() => null),
    planFor(c.env, c.var.userId).catch(() => FREE),
  ]);
  const message = refusalMessage(err.reason, plan.tier, Date.now(), zoneOr(settings?.time_zone));
  return err.reason === "allowance"
    ? c.json({ error: "allowance", message, resetsAt: new Date(nextUtcMidnight(Date.now())).toISOString() }, 429)
    : c.json({ error: "needs_consent", message }, 403);
}

// ---------------------------------------------------------------------------
// What GET /me says
// ---------------------------------------------------------------------------

export type PlanView = {
  tier: Tier;
  status: PlanStatus;
  trialEndsAt: string | null;
  renewsAt: string | null;
  /**
   * usedPercent is the share of today's usage budget spent; repliesLeftToday
   * is about how many average replies that leaves (builds before 2026-09-28
   * show it as "Replies left today"). creditsLeftToday and creditsPerDay are
   * the same day in credits (builds from 2026-09-28 show those). All null for
   * a development account, which has no daily limit.
   */
  limits: {
    repliesLeftToday: number | null;
    usedPercent: number | null;
    creditsLeftToday: number | null;
    creditsPerDay: number | null;
    resetsAt: string;
  };
  features: { chat: boolean; voice: boolean; wake: boolean; agent: boolean };
};

export function planView(plan: Plan, allowance: Allowance | null, now: number): PlanView {
  return {
    tier: plan.tier,
    status: plan.status,
    trialEndsAt: plan.trialEndsAt,
    renewsAt: plan.renewsAt,
    limits: {
      repliesLeftToday: allowance ? allowance.left : null,
      usedPercent: allowance ? allowance.usedPercent : null,
      creditsLeftToday: allowance ? allowance.creditsLeft : null,
      creditsPerDay: allowance ? allowance.creditsPerDay : null,
      resetsAt: new Date(nextUtcMidnight(now)).toISOString(),
    },
    // Base has every feature but background work, which is Plus's (Pro is
    // more usage, not more features). Every build of the app reads all four.
    features: {
      chat: atLeast(plan.tier, "base"),
      voice: atLeast(plan.tier, "base"),
      wake: atLeast(plan.tier, "base"),
      agent: atLeast(plan.tier, "plus"),
    },
  };
}
