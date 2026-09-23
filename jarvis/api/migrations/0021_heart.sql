-- Heart rate, and the workouts found in it.
--
-- Samples come from whatever writes heart rate to Apple Health (a watch; the
-- ES100 has no confirmed heart-rate sensor), or from the band if its heart-rate
-- test ever returns readings. Kept 30 days: enough for a resting baseline and a
-- month of workouts, not a medical record. (14 days since the v1 release, and
-- detected workouts with them; one logged by voice stays. src/retention.ts.)

CREATE TABLE hr_samples (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  bpm     INTEGER NOT NULL,
  -- health / band
  source  TEXT NOT NULL,
  PRIMARY KEY (user_id, ts, source)
);

-- A stretch of raised heart rate, or one logged by voice.
CREATE TABLE workouts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at       INTEGER NOT NULL,
  end_at         INTEGER NOT NULL,
  -- What detection guessed: strength / run_walk / cardio; or what they said.
  kind           TEXT NOT NULL,
  avg_hr         INTEGER,
  peak_hr        INTEGER,
  -- JSON: minutes in each of five zones.
  zones_json     TEXT,
  place_id       TEXT REFERENCES places(id) ON DELETE SET NULL,
  -- What they said it was, when asked ("legs day"). Used to tune the guess.
  confirmed_kind TEXT,
  summary        TEXT,
  -- detected / manual
  source         TEXT NOT NULL DEFAULT 'detected',
  created_at     INTEGER NOT NULL
);
CREATE INDEX workouts_user ON workouts (user_id, start_at);
