-- The daily rhythm: a brief when they're up, a checklist on the way out, a
-- nudge to leave on time, a wind-down before bed, and noticing when a usual
-- thing didn't happen.

-- What OVOA expects to happen, learned from two weeks of the timeline, heart
-- rate and routines. A window that passes with no sign of it is an oddity,
-- asked about once.
CREATE TABLE expectations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- visit: being at a place. workout: a workout. left_home: leaving home at all.
  kind         TEXT NOT NULL CHECK (kind IN ('visit', 'workout', 'left_home')),
  place_id     TEXT REFERENCES places(id) ON DELETE CASCADE,
  -- "going to the gym", in words, for the question.
  what         TEXT NOT NULL,
  -- Minutes past local midnight.
  window_start INTEGER NOT NULL,
  window_end   INTEGER NOT NULL,
  -- JSON array of weekdays, 0 = Sunday.
  days         TEXT NOT NULL,
  -- How often it held over the last two weeks, 0-1.
  strength     REAL NOT NULL,
  -- The local day it was last asked about, so each miss is asked once.
  asked_day    TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX expectations_user ON expectations (user_id);

-- Events already worked out for a commute alert: where, how long to get there,
-- when to leave, and whether the alert went out.
CREATE TABLE commute_checks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  starts_at  INTEGER NOT NULL,
  travel_s   INTEGER,
  leave_at   INTEGER,
  notified   INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id)
);

-- The old 7am "Morning brief" agent job is replaced by the brief that waits
-- until they're actually up (rhythm.ts). Paused rather than deleted: it's
-- theirs, and they can turn it back on.
UPDATE agent_jobs SET status = 'paused' WHERE source = 'system' AND title = 'Morning brief' AND status = 'active';
