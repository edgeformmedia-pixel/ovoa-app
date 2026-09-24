import { Hono } from "hono";
import { z } from "zod";
import { say } from "./obs";
import type { Env, Vars } from "./types";

// The Terms of Service, agreed to at sign-up (2026-09-24). The app shows the
// whole text (app/lib/terms.ts) and turns Agree on only once it has been
// scrolled to the end; this keeps when, and which wording. GET /me says whether
// the current wording has been agreed to, and the app shows the Terms first
// until it has. Nothing is refused on the server for it: the answer is kept as
// the record, and the app is the door.
//
// users.terms_accepted_at and terms_version: migration 0048.

/** The wording the app shows now. Bump it with the app's lib/terms.ts TERMS_VERSION when the text changes. */
export const TERMS_VERSION = 1;

export type TermsRow = { terms_accepted_at: number | null; terms_version: number | null };

/** What GET /me says. `current`: the wording the server wants agreed to. */
export type TermsView = { accepted: boolean; version: number | null; at: number | null; current: number };

/** Whether the current wording has been agreed to. Pure. */
export const termsAccepted = (row: TermsRow | null | undefined) =>
  !!row && row.terms_accepted_at != null && (row.terms_version ?? 0) >= TERMS_VERSION;

export function termsView(row: TermsRow | null | undefined): TermsView {
  return {
    accepted: termsAccepted(row),
    version: row?.terms_version ?? null,
    at: row?.terms_accepted_at ?? null,
    current: TERMS_VERSION,
  };
}

export const termsRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * They agreed, having scrolled to the end. `version` is the wording their app
 * showed; a newer one than the server knows is kept as the server's.
 */
termsRoutes.post("/me/terms", async (c) => {
  const parsed = z.object({ version: z.number().int().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Which version of the Terms did they agree to?" }, 400);
  const version = Math.min(parsed.data.version, TERMS_VERSION);
  const now = Date.now();
  await c.env.DB.prepare("UPDATE users SET terms_accepted_at = ?, terms_version = ? WHERE id = ?").bind(now, version, c.var.userId).run();
  say("terms", { outcome: "agreed", user: c.var.userId, version });
  return c.json({ terms: termsView({ terms_accepted_at: now, terms_version: version }) });
});
