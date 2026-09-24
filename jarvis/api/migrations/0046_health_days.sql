-- Apple Health's numbers for a day, as the phone read them (src/healthdays.ts).
--
-- The assistant answers health questions from the server, so it works with the
-- phone locked: Apple Health can't be read on a locked iPhone (HealthKit Code=6
-- "Protected health data is inaccessible", /chat/resume on 2026-09-21).
--
-- Only what nothing else holds. Heart rate stays in hr_samples (0021), where
-- the band and a watch meet, and every heart number is worked out from it; the
-- band does measure heart rate (verified 2026-09-21, build 51), whatever 0021
-- says. Steps stay in step_days (0002). Workouts a watch recorded go in the
-- workouts table as source 'health', id 'hk:<user>:<HealthKit uuid>', so
-- detection sees them and doesn't find the same run again.
--
-- One row per local day, overwritten by the phone each time it reads Health
-- (PUT /health/days), and only for accounts that agreed to AI: these numbers
-- serve the assistant alone. Deleted 14 days after `day` (retention.ts).
CREATE TABLE health_days (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- YYYY-MM-DD, the phone's local day.
  day          TEXT NOT NULL,
  active_kcal  INTEGER,
  exercise_min INTEGER,
  stand_hours  INTEGER,
  -- Apple's own resting heart rate (a watch works it out).
  resting_hr   INTEGER,
  hrv_ms       INTEGER,
  spo2_pct     REAL,
  -- Breaths a minute.
  resp_rate    REAL,
  weight_kg    REAL,
  -- JSON: the night that ended this day. {asleepMin, inBedMin?, start, end,
  -- stages?: {core?, deep?, rem?, awake?}, source}; "in bed" is never asleep.
  sleep_json   TEXT,
  -- JSON: which apps and devices wrote them. {heart?, sleep?, steps?}: names.
  sources_json TEXT,
  -- When the phone last sent the day. It sends today on every read of Health,
  -- changed or not, so the newest is its last read (healthdays.ts STALE_MS).
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
