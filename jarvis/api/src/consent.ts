import type { Env } from "./types";

// Whether a person has agreed to their words going to an AI company.
//
// Before anything goes to an AI company, the user agrees on a screen that says
// where their data goes (the v1 release, 2026-09-23; decision 4). The model-call
// gate (plans.ts modelGate) and the crons' pre-checks (plans.ts blockedFor) ask
// this for every model call, and refuse with needs_consent when it isn't given.
//
// One function, so storing the answer changes nothing else: the gate and the
// crons already ask here.

export type AiConsent = "given" | "needed";

/**
 * "given" when this person has agreed to AI, "needed" when they haven't yet.
 *
 * TODO(Phase 5): read users.ai_consent_at and ai_consent_version (migration
 * 0040, with POST /me/consent) and answer "needed" when there is no consent, or
 * it was given to an older version of the wording. Until then everyone counts
 * as having agreed, which is how the app behaved before consent existed. It is
 * asked on every model call, so keep it one cheap read (the users row that
 * plans.ts loadPlan already reads and memoises is the place to put it).
 */
export async function aiConsentFor(_env: Env, _userId: string): Promise<AiConsent> {
  return "given";
}

/** What a person hears or reads when they haven't agreed yet. Plain, one sentence. */
export const CONSENT_NEEDED =
  "Before I can answer, please agree to how OVOA uses AI. You can do that in the app.";
