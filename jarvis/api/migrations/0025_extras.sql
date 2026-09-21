-- The extras (F23-F34): inbox triage, follow-ups, bills, readiness, weekly
-- report, on this day, shared reminders, parking, meeting prep, and picking
-- the right Google account without being told.

-- What each connected Google account is for, learned from its own mail and
-- calendar: whose domains it writes to, what its events are about, and the
-- hours it's busy. Used to choose an account when the user doesn't name one.
CREATE TABLE account_profiles (
  account_id      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_domain    TEXT,
  -- JSON: the email domains it writes to most, most first.
  contact_domains TEXT NOT NULL DEFAULT '[]',
  -- JSON: a handful of words its calendar and mail are about ("standup", "client").
  topics          TEXT NOT NULL DEFAULT '[]',
  -- Minutes past local midnight, from when its events usually are.
  work_start      INTEGER,
  work_end        INTEGER,
  learned_at      INTEGER
);
CREATE INDEX account_profiles_user ON account_profiles (user_id);

-- Last night's sleep, as the phone read it from Health: the one number the
-- readiness line needs that only the phone has.
ALTER TABLE device_state ADD COLUMN sleep_hours REAL;
