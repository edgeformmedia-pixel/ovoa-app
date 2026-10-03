-- What OVOA Fit measured on its own for a day (src/healthdays.ts bandDays).
--
-- Since 2026-10-02 the band measures by itself: heart rate on its own timer,
-- blood oxygen every so often, and sleep stages overnight. The phone copies
-- that history off the band whenever it can (it's kept on the band while the
-- app is asleep) and sends heart rate to hr_samples like before; the rest is
-- one row a day here. Where Apple Health has the same number for a day, Health
-- wins (a watch is the better sensor); the band fills what Health leaves empty.
--
-- Same rules as health_days: kept only for accounts that agreed to AI, and
-- deleted 14 days after `day` (retention.ts).
CREATE TABLE band_days (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- YYYY-MM-DD, the phone's local day.
  day        TEXT NOT NULL,
  -- Blood oxygen: the day's average and lowest reading, percent.
  spo2_pct   REAL,
  spo2_low   REAL,
  -- JSON, health_days.sleep_json's shape: the night that ended this day.
  sleep_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
