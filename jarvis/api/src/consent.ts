import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { say } from "./obs";
import type { Env, Vars } from "./types";

// Whether a person has agreed to their words going to an AI company.
//
// Before anything goes to an AI company, the user agrees on a screen that says
// where their data goes (the v1 release, 2026-09-23; decision 4): what they say
// and the data needed to answer it go to Cloudflare (Workers AI, which runs GLM
// for spoken turns and the setup conversation) and to Z.ai (GLM) to write
// replies, and to Google Gemini when GLM is down or for web searches; Deepgram
// turns replies into speech from the text alone. The app shows that screen
// (app/consent.tsx) and posts here when they agree; users.ai_consent_at and
// ai_consent_version (migration 0041) keep the answer.
//
// Two places ask:
//   - Every model call, through the model-call gate (plans.ts modelGate) and
//     the crons' pre-checks (plans.ts blockedFor), which refuse with
//     needs_consent. That is the door no caller can forget.
//   - The routes that send the person's words or OVOA's voice out before any
//     model is asked, or without one (requireConsent below): a turn (/chat,
//     /chat/resume, Siri, a setup turn) and /voice/speak (Deepgram). Without
//     this a turn refused by the gate would still have its one-sentence answer
//     voiced by Deepgram.
//
// A new wording of the screen gets a new AI_CONSENT_VERSION, and agreeing to an
// older one then counts as not agreed: they see the new screen once.

/**
 * The newest wording an app can show. 2 names Cloudflare (Workers AI), which
 * answers spoken turns and setup since 2026-09-23 and version 1 didn't name.
 * Bump it with the app's lib/consent.ts CONSENT_VERSION when the screen changes.
 */
export const AI_CONSENT_LATEST = 2;

/**
 * The wording an answer has to be for, to count. It trails AI_CONSENT_LATEST
 * until the build that shows the new screen is installed: requiring 2 while
 * builds 67 and 68 can only agree to 1 would take the AI away from everyone on
 * them (2026-09-23). A version-2 answer is kept as 2 in the meantime, so raising
 * this afterwards asks only those still on version 1.
 */
export const AI_CONSENT_VERSION = 1;

export type AiConsent = "given" | "needed";

/** What GET /me says about it. `current`: the version the server wants agreed to. */
export type ConsentView = { given: boolean; version: number | null; at: number | null; current: number };

export type ConsentRow = { ai_consent_at: number | null; ai_consent_version: number | null };

/** Whether a stored answer counts. Pure. */
export const consentGiven = (row: ConsentRow | null | undefined) =>
  !!row && row.ai_consent_at != null && (row.ai_consent_version ?? 0) >= AI_CONSENT_VERSION;

export function consentView(row: ConsentRow | null | undefined): ConsentView {
  return {
    given: consentGiven(row),
    version: row?.ai_consent_version ?? null,
    at: row?.ai_consent_at ?? null,
    current: AI_CONSENT_VERSION,
  };
}

// Per isolate, and only the yes: every model call asks, and a reply is one
// /chat and several model calls. A no is read again every time, so agreeing on
// one isolate is seen on the next request whichever isolate it lands on; taking
// it back is seen here at once and elsewhere within MEMO_MS.
const MEMO_MS = 60_000;
const MEMO_MAX = 5_000;
const agreed = new Map<string, number>();

/** Forgets what this isolate remembered about one person (or everyone). */
export function forgetConsent(userId?: string) {
  if (userId) agreed.delete(userId);
  else agreed.clear();
}

/** "given" when this person has agreed to AI (the current wording), "needed" when they haven't. */
export async function aiConsentFor(env: Pick<Env, "DB">, userId: string, now = Date.now()): Promise<AiConsent> {
  const at = agreed.get(userId);
  if (at !== undefined && now - at < MEMO_MS) return "given";
  agreed.delete(userId);
  const row = await env.DB.prepare("SELECT ai_consent_at, ai_consent_version FROM users WHERE id = ?")
    .bind(userId)
    .first<ConsentRow>();
  if (!consentGiven(row)) return "needed";
  agreed.set(userId, now);
  if (agreed.size > MEMO_MAX) agreed.delete(agreed.keys().next().value!);
  return "given";
}

/** What a person hears or reads when they haven't agreed yet. Plain, one sentence. */
export const CONSENT_NEEDED =
  "Before I can answer, please agree to how OVOA uses AI in the app. If you don't see where, update OVOA from TestFlight.";

/** The 403 body. The app keys off `error`, as it does for needs_plan. */
export const needsConsentBody = () => ({ error: "needs_consent" as const, message: CONSENT_NEEDED });

/**
 * The routes that need consent before anything else runs: a turn, however it
 * arrives, and OVOA's voice. Every other model route is covered by the gate on
 * the model call itself, and answers needs_consent from there. A setup turn
 * (POST /onboarding/turn) is a turn like any other.
 */
const CONSENT_ROUTES: RegExp[] = [/^\/(chat|chat\/resume|siri|onboarding\/turn)$/, /^\/voice\/speak$/];

export const needsConsentFor = (method: string, path: string) =>
  method.toUpperCase() === "POST" && CONSENT_ROUTES.some((r) => r.test(path));

/**
 * For signed-in routes, after requirePlan: someone who hasn't agreed gets a
 * 403 needs_consent from a turn or /voice/speak, before any word is sent
 * anywhere. Siri reads its answer aloud, so it gets the sentence as text.
 */
export function requireConsent(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    if (!needsConsentFor(c.req.method, c.req.path)) return next();
    if ((await aiConsentFor(c.env, c.var.userId)) === "given") return next();
    say("consent", { outcome: "403", user: c.var.userId, path: c.req.path });
    if (c.req.path === "/siri") return c.text(CONSENT_NEEDED, 403);
    return c.json(needsConsentBody(), 403);
  };
}

// ---------- Routes ----------

export const consentRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

async function viewFor(env: Env, userId: string) {
  const row = await env.DB.prepare("SELECT ai_consent_at, ai_consent_version FROM users WHERE id = ?")
    .bind(userId)
    .first<ConsentRow>();
  return consentView(row);
}

/**
 * They pressed Agree. `version` is the wording their app showed them; one
 * older than the server's is kept, and still counts as not agreed, so they
 * are shown the new wording (an app from before it, updated, shows it).
 */
consentRoutes.post("/me/consent", async (c) => {
  const parsed = z.object({ version: z.number().int().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Which version of the screen did they agree to?" }, 400);
  const version = Math.min(parsed.data.version, AI_CONSENT_LATEST);
  await c.env.DB.prepare("UPDATE users SET ai_consent_at = ?, ai_consent_version = ? WHERE id = ?")
    .bind(Date.now(), version, c.var.userId)
    .run();
  forgetConsent(c.var.userId);
  say("consent", { outcome: "agreed", user: c.var.userId, version });
  return c.json({ aiConsent: await viewFor(c.env, c.var.userId) });
});

/** They took it back (Settings). AI stops at once on this isolate, and within a minute everywhere. */
consentRoutes.delete("/me/consent", async (c) => {
  await c.env.DB.prepare("UPDATE users SET ai_consent_at = NULL, ai_consent_version = NULL WHERE id = ?").bind(c.var.userId).run();
  forgetConsent(c.var.userId);
  say("consent", { outcome: "withdrawn", user: c.var.userId });
  return c.json({ aiConsent: await viewFor(c.env, c.var.userId) });
});
