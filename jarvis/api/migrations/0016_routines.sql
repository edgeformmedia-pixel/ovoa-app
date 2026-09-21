-- Routines: the dog walk, the water, the pills.
--
-- Two kinds of source of truth, on purpose:
--
--   Daily routines live only here and are fired by OVOA's own scheduler.
--
--   Medications belong to Apple Reminders (a list called "Medications"). OVOA
--   mirrors them, reminds and buzzes, and writes "took it" back — but it is never
--   the only copy, because a medication schedule that lives in one startup's
--   database is one outage away from a missed dose. external_source/external_id
--   say where a row came from; a row with a source but no id yet is one the phone
--   still has to create there.
--
-- The phone also schedules each occurrence as a local notification, so a
-- reminder fires with no network at all. The server's copy is what escalates,
-- buzzes the band and keeps the record.

CREATE TABLE routines (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('med', 'pet', 'habit', 'custom')),
  title           TEXT NOT NULL,
  -- JSON array of minutes past local midnight: [480, 1200] is 8:00 and 20:00.
  times           TEXT NOT NULL,
  -- JSON array of weekdays, 0 = Sunday. Empty means every day.
  days            TEXT NOT NULL DEFAULT '[]',
  buzz_pattern    TEXT NOT NULL DEFAULT 'reminder',
  meta_json       TEXT,
  -- work / personal, for where its to-dos go (F34).
  context         TEXT,
  -- Minutes after the due time before an unconfirmed occurrence counts as missed.
  window_minutes  INTEGER NOT NULL DEFAULT 120,
  active          INTEGER NOT NULL DEFAULT 1,
  external_source TEXT CHECK (external_source IN ('apple_reminders', 'apple_health', 'google_tasks', 'google_calendar')),
  external_id     TEXT,
  -- The next occurrence, in epoch ms. What the cron scans.
  next_due_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX routines_due ON routines (active, next_due_at);
CREATE INDEX routines_user ON routines (user_id, active);
CREATE UNIQUE INDEX routines_external ON routines (user_id, external_source, external_id) WHERE external_id IS NOT NULL;

-- One occurrence of a routine, and what became of it.
CREATE TABLE routine_events (
  id           TEXT PRIMARY KEY,
  routine_id   TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'missed', 'snoozed', 'skipped')),
  confirmed_at INTEGER,
  -- notification / voice / app / external (ticked off in Reminders itself)
  via          TEXT,
  -- 0: fired. 1: buzzed again at 15 min. 2: spoken at 60 min.
  escalation   INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER,
  -- Set once the phone has ticked the matching reminder off in Apple Reminders.
  written_back INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX routine_events_once ON routine_events (routine_id, due_at);
CREATE INDEX routine_events_open ON routine_events (status, due_at);
CREATE INDEX routine_events_user ON routine_events (user_id, due_at);

-- When the phone last scheduled its local notifications from the routines. A
-- routine changed after this is one the phone doesn't know about yet, so the
-- server sends a visible push for it instead of relying on the phone's copy.
ALTER TABLE device_state ADD COLUMN routines_synced_at INTEGER;
