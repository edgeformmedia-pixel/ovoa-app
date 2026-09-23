-- Proving the address in the app, and agreeing to AI (the v1 release,
-- 2026-09-23; src/verify.ts and src/consent.ts).
--
-- 1. Accounts that can't use anything until their address is proven with the
--    emailed code: the ones the app's own sign-up makes from now on, which set
--    this to 1. Every account from before stays 0, so nobody already using
--    OVOA is locked out by the server; the app asks them for a code once
--    instead (email_verified_at from 0039 says whether they have). The copy
--    between Cloudflare accounts (scripts/move-db.mjs) writes column-listed
--    rows, so copied accounts get this default of 0 too.
ALTER TABLE users ADD COLUMN must_verify INTEGER NOT NULL DEFAULT 0;

-- 2. When they agreed, on the app's consent screen, to what they say (and the
--    data needed to answer it) going to the AI companies, and to which wording
--    of that screen (consent.ts AI_CONSENT_VERSION). Null until they agree, and
--    again after they take it back. Nothing is sent to a model, or to Deepgram
--    for OVOA's voice, without it (consent.ts, plans.ts modelGate).
ALTER TABLE users ADD COLUMN ai_consent_at INTEGER;
ALTER TABLE users ADD COLUMN ai_consent_version INTEGER;
