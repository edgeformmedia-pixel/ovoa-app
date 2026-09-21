-- Alarms, and reminders that don't take no for an answer.
--
-- "OVOA, wake me up at 7": an alarm. It buzzes the band and talks until they say
-- "I'm awake". A hard alarm won't take that for an answer either: it keeps
-- saying "Morning, wake up" until the phone counts 20 steps.
--
-- Urgent reminders (medication by default) keep buzzing until the user says it's
-- done: "I took my pill". The phone does the nagging while it's awake; the
-- server sends a push every two minutes as the backstop for when it isn't.

CREATE TABLE alarms (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Minutes past local midnight.
  time_minutes INTEGER NOT NULL,
  -- JSON array of weekdays, 0 = Sunday; empty for a one-off.
  days         TEXT NOT NULL DEFAULT '[]',
  label        TEXT,
  -- Won't stop until 20 steps.
  hard         INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  next_at      INTEGER,
  -- While it's going off: when it started, and when it was stopped.
  ringing_at   INTEGER,
  stopped_at   INTEGER,
  -- The last backstop push while ringing.
  nagged_at    INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX alarms_due ON alarms (active, next_at);
CREATE INDEX alarms_user ON alarms (user_id);

-- Urgent notes (a reminder that keeps going until it's done).
ALTER TABLE notes ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN nagged_at INTEGER;

-- Urgent routines. Medication is urgent unless the user says otherwise.
ALTER TABLE routines ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
UPDATE routines SET urgent = 1 WHERE kind = 'med';
ALTER TABLE routine_events ADD COLUMN nagged_at INTEGER;
