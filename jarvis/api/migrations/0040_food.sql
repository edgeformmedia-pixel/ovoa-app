-- Food: what someone ate, noted by talking about it (src/food.ts, docs/food.md).
--
-- Every Base user has food memory with nothing to install: "I had a burrito"
-- is noted quietly. The Calorie add-on shows it, and sets how closely OVOA asks
-- (profile.food_detail below).
--
-- Retention (14 days, docs/release-v1-prompt.md Phase 6; the purge itself is
-- Phase 6's to add, once this table exists):
--   food_log      deleted 14 days after `ts`. The day's total lives on only
--                 inside that day's summary (foodDayLine in src/food.ts).
--   food_catalog  deleted once unused for 14 days (`used_at`), so "the same meal
--                 costs the same" holds inside that window.
--   profile.food_* and the targets are kept: the user set them up.
-- There is no table of day totals: they are summed from food_log, which is
-- small, and a stored copy would only be deleted at 14 days too.

-- What a food costs, per 100 g, as first worked out. `key` is the name
-- lowercased and stripped to letters, digits and single spaces, so "Olive Oil"
-- and "olive oil " are one row. The second time round the catalog answers
-- instead of a fresh guess, so the same meal costs the same number.
-- `source`: model (first estimate) | user (they corrected it).
CREATE TABLE food_catalog (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  kcal_100g    REAL NOT NULL,
  protein_100g REAL,
  carbs_100g   REAL,
  fat_100g     REAL,
  -- fat | grain | protein | veg | fruit | dairy | drink | sweet | mixed:
  -- picks the sanity bounds in src/food.ts.
  category     TEXT NOT NULL,
  -- The last portion eaten, in grams.
  serving_g    REAL,
  source       TEXT NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 1,
  used_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX food_catalog_used ON food_catalog (used_at);

-- One thing eaten or drunk.
CREATE TABLE food_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The user's local day (YYYY-MM-DD). A food day starts at local midnight,
  -- like every other day in OVOA.
  day        TEXT NOT NULL,
  -- When it was eaten, epoch ms.
  ts         INTEGER NOT NULL,
  name       TEXT NOT NULL,
  -- The catalog key, for the catalog and for "most eaten".
  key        TEXT NOT NULL,
  grams      REAL,
  kcal       REAL NOT NULL,
  protein_g  REAL,
  carbs_g    REAL,
  fat_g      REAL,
  category   TEXT,
  -- model | catalog | user
  source     TEXT NOT NULL,
  -- ok | clamped: clamped when the estimate was outside the category's bounds
  -- and was corrected; said as "roughly".
  estimated  TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);
CREATE INDEX food_log_day ON food_log (user_id, day, ts);
CREATE INDEX food_log_ts ON food_log (ts);

-- How closely OVOA asks about food: quick (never asks), normal (one question
-- when it matters) or strict (asks what it needs for a tight number).
-- NULL means no tracking level is set: food is noted quietly, as quick, and no
-- number is said. Installing Calorie, an eating goal in setup or saying "be
-- more exact" sets it; removing Calorie clears it.
ALTER TABLE profile ADD COLUMN food_detail TEXT;
-- The last level they chose (on the add-on's first open, by voice or in
-- setup), so removing Calorie and adding it back keeps it. NULL until they
-- choose: the add-on asks on its first open while this is NULL.
ALTER TABLE profile ADD COLUMN food_detail_last TEXT;
-- A daily goal they stated ("keep me to 2,000"). NULL = no target.
ALTER TABLE profile ADD COLUMN kcal_target REAL;
ALTER TABLE profile ADD COLUMN protein_target REAL;
