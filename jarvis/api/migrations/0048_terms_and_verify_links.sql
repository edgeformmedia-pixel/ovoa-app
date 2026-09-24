-- The Terms of Service, agreed at sign-up (api/src/terms.ts), and the one-tap
-- link that proves an email address (api/src/verify.ts), 2026-09-24.
--
-- terms_version: the wording agreed to (TERMS_VERSION); a new wording asks again.
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE users ADD COLUMN terms_version INTEGER;

-- A link in the confirmation email: api.ovoa.ai/verify?id=<token>. Only the
-- token's hash is kept, it works once, and for a day. The code in the same
-- email still works as well (email_codes).
CREATE TABLE verify_links (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX verify_links_user ON verify_links (user_id);
