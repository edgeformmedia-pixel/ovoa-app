ALTER TABLE settings ADD COLUMN step_goal INTEGER NOT NULL DEFAULT 8000;
ALTER TABLE settings ADD COLUMN fall_detection INTEGER NOT NULL DEFAULT 1;

-- The assistant is no longer branded; new accounts get a neutral name.
UPDATE settings SET assistant_name = 'Assistant' WHERE assistant_name = 'Jarvis';

-- One row per user per local calendar day (YYYY-MM-DD), synced from the phone's pedometer.
CREATE TABLE step_days (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  steps      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE emergency_contacts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_contacts_user ON emergency_contacts(user_id);

-- Falls and SOS presses. status: 'ok' (user dismissed) or 'alerted' (contacts were messaged).
CREATE TABLE safety_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('fall', 'sos')),
  status     TEXT NOT NULL CHECK (status IN ('ok', 'alerted')),
  latitude   REAL,
  longitude  REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_safety_user_time ON safety_events(user_id, created_at);
