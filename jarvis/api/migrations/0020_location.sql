-- Where the day happened.
--
-- The phone sends a point every few hundred metres (only with "Always" location
-- and only once the user turned the timeline on). Points that stay put for a
-- while become a visit; places visited again and again become a place — home,
-- work, the gym — which the user can name. Points and visits are kept 14 days;
-- places are kept until the user removes them, because "home" is worth
-- remembering and last Tuesday's walk isn't.

CREATE TABLE location_points (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL,
  -- Metres, as the phone reported them.
  accuracy REAL,
  -- Metres per second, when the phone knew.
  speed   REAL
);
CREATE INDEX location_points_user ON location_points (user_id, ts);

CREATE TABLE places (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Null until the user names it (or it was obviously home or work).
  name        TEXT,
  kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('home', 'work', 'gym', 'other')),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  radius      REAL NOT NULL DEFAULT 100,
  -- Filled in by the phone's own reverse geocoder: "Elm St, Ferndale".
  address     TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  asked_at    INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX places_user ON places (user_id);

CREATE TABLE visits (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  arrived  INTEGER NOT NULL,
  -- The latest point seen here. A visit is "still going" while this is recent.
  left_at  INTEGER NOT NULL,
  points   INTEGER NOT NULL DEFAULT 1,
  place_id TEXT REFERENCES places(id) ON DELETE SET NULL
);
CREATE INDEX visits_user ON visits (user_id, arrived);

-- Arriving and leaving, from the phone's geofences around the places.
-- What the leaving-home checklist and place reminders run on.
CREATE TABLE place_events (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('enter', 'exit')),
  ts       INTEGER NOT NULL
);
CREATE INDEX place_events_user ON place_events (user_id, ts);

-- Place reminders: a note can now point at a place, not just name one.
ALTER TABLE notes ADD COLUMN place_id TEXT;
