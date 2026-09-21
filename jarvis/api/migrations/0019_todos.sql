-- Tomorrow's list.
--
-- An hour before bedtime OVOA gathers what's open — promises made, notes tagged
-- todo, today's leftovers, routines that were missed — scores it, and keeps the
-- top ten as tomorrow's list. At bedtime itself it taps the wrist and says it's
-- time for bed. The morning brief reads the first three back.
--
-- A row is one line on one day's list. Built rows can be rebuilt; ones the user
-- added by hand (source 'user') are never touched by a rebuild.

CREATE TABLE todos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The user's local day this is on the list for.
  date        TEXT NOT NULL,
  text        TEXT NOT NULL,
  -- commitment / note / routine / carried / user
  source      TEXT NOT NULL,
  source_id   TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  score       REAL NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     INTEGER,
  -- Where it was copied to, if anywhere: google_tasks or apple_reminders, and its id there.
  synced_to   TEXT,
  external_id TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX todos_day ON todos (user_id, date, done);

-- Once-a-day things that must happen once and only once: the list was built for
-- this day, the bedtime buzz went out for this evening. Keyed by the local day,
-- so a two-minute cron can ask "done yet?" without a clock of its own.
CREATE TABLE daily_marks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  day     TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, day)
);
