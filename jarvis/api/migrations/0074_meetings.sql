-- Scheduling with people who aren't on OVOA (meetings.ts): the times offered by
-- email, and whether the other person has answered. Ends after 7 days.
CREATE TABLE meetings (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT,
  title         TEXT NOT NULL,
  minutes       INTEGER NOT NULL,
  slots         TEXT NOT NULL,
  via           TEXT NOT NULL CHECK (via IN ('gmail', 'outlook')),
  account_id    TEXT,
  time_zone     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('waiting', 'picked', 'handed', 'expired')),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  next_check_at INTEGER NOT NULL
);
CREATE INDEX meetings_due ON meetings (status, next_check_at);
CREATE INDEX meetings_user ON meetings (user_id, status);
