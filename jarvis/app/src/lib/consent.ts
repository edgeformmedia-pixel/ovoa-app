import { useSyncExternalStore } from "react";

// Whether this person has agreed to AI (api/src/consent.ts; app/consent.tsx is
// the screen).
//
// Before anything goes to an AI company, the person agrees on a screen that
// says where their data goes (the v1 release, 2026-09-23, decision 4). Until
// they have, nothing is sent: the server refuses a turn, OVOA's voice and
// every model call, and this phone doesn't ask. AI features show "Agree to use
// AI" (plan.tsx, components/Plan.tsx), requests that would reach a model are
// stopped before they're sent (api.ts lockedOnPhone), and anything OVOA says
// out loud (the tour, a voice sample, the fillers) uses the phone's own voice
// rather than Deepgram's (voice.ts usesDeviceVoice).
//
// Kept outside React, like the plan's tier in api.ts, because voice.ts and
// api.ts read it from code that has no component around it. auth.tsx sets it
// from GET /me every time the user is read; a needs_consent answer from the
// server sets it too.

/**
 * The wording of app/consent.tsx. Bump it with the server's AI_CONSENT_VERSION
 * when that screen changes. 2 (2026-09-23): it names Cloudflare (Workers AI),
 * where spoken replies and setup are now written first, so everyone who agreed
 * to 1 is asked once more. It ships with the server's 2. POST /me/consent
 * keeps the lower of the two, so against a server still on 1 an agreement here
 * is stored as 1 and asked for again once the server moves; and a server on 2
 * leaves a build that shows 1 unable to agree at all (its needs_consent
 * sentence says to update from TestFlight).
 */
export const CONSENT_VERSION = 2;

/** What GET /me says (api/src/consent.ts consentView). Missing from servers from before consent. */
export type AiConsent = { given: boolean; version: number | null; at: number | null; current: number };

/**
 * "unknown": nobody signed in, or a server from before consent, which never
 * asks: the app then behaves as it always did.
 */
export type ConsentState = "given" | "needed" | "unknown";

let state: ConsentState = "unknown";
const listeners = new Set<() => void>();

function publish(next: ConsentState) {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

/** From the user GET /me gave (auth.tsx), or null when signed out. */
export function noteConsentFromUser(consent: AiConsent | undefined | null, signedIn: boolean) {
  publish(!signedIn || !consent ? "unknown" : consent.given ? "given" : "needed");
}

/** The server said needs_consent: they haven't agreed (or took it back on another phone). */
export function noteConsentNeeded() {
  publish("needed");
}

export const consentState = () => state;
/** Known not to have agreed. Unknown counts as agreed: the server still decides. */
export const consentMissing = () => state === "needed";

export function onConsentChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useConsentState() {
  return useSyncExternalStore(onConsentChange, consentState, consentState);
}
