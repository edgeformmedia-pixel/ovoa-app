-- The shape of someone's day, asked once.
--
-- Memories (0001) are whatever the model decided was worth keeping from a
-- conversation, in sentences. This is the other kind: a handful of facts every
-- feature needs in a form it can compute with — when they wake, when they sleep,
-- when they work. The to-do list is built an hour before sleep_time; the
-- bedtime buzz is at sleep_time; the morning brief waits for wake_time.
--
-- Filled in by the onboarding conversation, changed later with profile_update
-- ("I get up at six now"). Every field is optional: a skipped question means
-- the feature falls back to a default, not that it breaks.

CREATE TABLE profile (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- JSON array: what else people call them, for recognising when they're addressed.
  nicknames         TEXT NOT NULL DEFAULT '[]',
  -- Minutes past local midnight.
  wake_time         INTEGER,
  sleep_time        INTEGER,
  -- JSON array of weekdays, 0 = Sunday.
  work_days         TEXT,
  work_start        INTEGER,
  work_end          INTEGER,
  gym               TEXT,
  -- JSON array of what to check on the way out: ["keys", "wallet", "meds"].
  leaving_checklist TEXT,
  -- The onboarding step they're on, while it's in progress.
  step              TEXT,
  -- Null until onboarding is finished or skipped. The app shows it until then.
  onboarded_at      INTEGER,
  updated_at        INTEGER NOT NULL
);
