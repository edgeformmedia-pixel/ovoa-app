-- Proving an email address (src/emailauth.ts), for signing in and signing up
-- on ovoa.ai: a six-digit code emailed from no-reply@ovoa.ai, or Google.
--
-- 1. One live code per address. Only a hash is kept. `attempts` counts wrong
--    guesses (five and the code is gone); `window_*` counts sends in the
--    current hour, so one address can't be mailed without end.
CREATE TABLE email_codes (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash    TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_sends INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;

-- 2. A proven address with no account yet. "Create your account" spends it,
--    with the name and password the person picks. `name` is Google's, to
--    prefill the form. Only a hash of the ticket is kept.
CREATE TABLE signup_tickets (
  ticket_hash TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE,
  name        TEXT,
  expires_at  INTEGER NOT NULL
) WITHOUT ROWID;

-- 3. When the address on an account was last proven. Null for every account
--    made in the app before this, which never asked.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
