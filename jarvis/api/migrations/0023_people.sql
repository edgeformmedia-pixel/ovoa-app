-- Social memory: who people are, what they asked, where things were left.
--
-- Everything here is pulled out of the transcripts (0022) as each five-minute
-- block is titled, or said outright ("remember Jake's birthday is in March",
-- "my keys are in the drawer"). Background speech only reaches it for the
-- development accounts that capture it at all.

-- A person the user knows, and what OVOA has learned about them.
CREATE TABLE people (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- JSON array of other names for them: "Mum", "Jakey".
  aliases    TEXT NOT NULL DEFAULT '[]',
  -- JSON array of {fact, at, from}: from 'said' (told OVOA) or 'heard' (a transcript).
  facts      TEXT NOT NULL DEFAULT '[]',
  relation   TEXT,
  birthday   TEXT,
  last_seen  INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX people_user ON people (user_id, name);

-- Where something was put down. The latest row for a name is where it is.
CREATE TABLE objects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  location_text TEXT NOT NULL,
  place_id      TEXT,
  lat           REAL,
  lng           REAL,
  ts            INTEGER NOT NULL
);
CREATE INDEX objects_user ON objects (user_id, name, ts);

-- Names someone seemed to call the user by. Asked about once it has come up twice.
CREATE TABLE name_candidates (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  asked_at INTEGER,
  PRIMARY KEY (user_id, name)
);

-- Each titled five-minute block is filed in the timeline too, so "Your days"
-- shows what was said, not only what was recorded on purpose.
ALTER TABLE transcript_titles ADD COLUMN block_id TEXT;

-- Favors: something someone asked of the user, caught from a transcript. How
-- sure the model was (below 0.8 it asks before treating it as real), and where
-- it came from ('said' is the old path: the user's own promises).
ALTER TABLE context_commitments ADD COLUMN confidence REAL;
ALTER TABLE context_commitments ADD COLUMN origin TEXT;
