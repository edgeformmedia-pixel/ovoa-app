-- Last time zone the app reported, so Siri requests (which don't send one) get local times.
ALTER TABLE settings ADD COLUMN time_zone TEXT;

-- 'app' for normal sign-ins, 'siri' for the long-lived key used by the Siri Shortcut.
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'app';

-- Chat turns waiting for the phone to look something up (contacts, calendar, Health).
CREATE TABLE paused_turns (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  time_zone  TEXT NOT NULL,
  caps       TEXT NOT NULL,
  state      TEXT NOT NULL,
  calls      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_paused_turns_user ON paused_turns(user_id, created_at);
