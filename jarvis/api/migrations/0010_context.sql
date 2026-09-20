-- The context timeline: what the day was made of, so the assistant can answer
-- "what did I do Tuesday" and "did I ever call Sarah back".
--
-- Capture is explicit only. A block exists because the user pressed the clip,
-- twisted it, tapped record, talked to the assistant, or because something they
-- already share (calendar, location, steps) says where they were. Nothing is
-- recorded in the background.
--
-- Verbatim transcripts are deliberately NOT here. They stay in the phone's own
-- store and are dropped after two weeks. What syncs is the summary written from
-- them, which is what the assistant actually reads and is small enough to keep
-- for good.

CREATE TABLE context_blocks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  -- voice: the user chose to record. chat: a turn with the assistant.
  -- calendar / location / health: signals they already share, no microphone.
  source      TEXT NOT NULL CHECK (source IN ('voice', 'chat', 'calendar', 'location', 'health')),
  title       TEXT,
  summary     TEXT,
  category    TEXT,
  -- JSON arrays, written by the on-device model alongside the summary.
  people      TEXT,
  places      TEXT,
  facts       TEXT,
  -- The phone still holds the words. Goes back to 0 once they expire there.
  has_transcript INTEGER NOT NULL DEFAULT 0,
  -- Pinned blocks keep their verbatim past the two weeks.
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX context_blocks_when ON context_blocks (user_id, started_at);
CREATE INDEX context_blocks_category ON context_blocks (user_id, category, started_at);

-- Promises worth chasing: "call Sarah back Thursday". Pulled out while the words
-- are still around, with the words attached, so they outlive the transcript.
-- This is the part people actually want back.
CREATE TABLE context_commitments (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  block_id   TEXT NOT NULL REFERENCES context_blocks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  quote      TEXT,
  who        TEXT,
  due_hint   TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  created_at INTEGER NOT NULL
);
CREATE INDEX context_commitments_open ON context_commitments (user_id, status, created_at);

-- Hour, day and week titles. Each one is written from the titles below it, never
-- from the transcripts, which is what keeps them cheap enough for the small
-- on-device model and keeps them readable after the words are gone.
CREATE TABLE context_rollups (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grain      TEXT NOT NULL CHECK (grain IN ('hour', 'day', 'week')),
  -- Local to the user: 2026-09-20T14, 2026-09-20, 2026-W38.
  bucket     TEXT NOT NULL,
  title      TEXT,
  summary    TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, grain, bucket)
);

-- Searching summaries by word, for "when did I mention Dr. Chen". The phone
-- searches its own transcripts; this covers everything that outlives them.
CREATE VIRTUAL TABLE context_search USING fts5(
  title, summary, people, places,
  content='context_blocks', content_rowid='rowid'
);

CREATE TRIGGER context_blocks_ai AFTER INSERT ON context_blocks BEGIN
  INSERT INTO context_search(rowid, title, summary, people, places)
  VALUES (new.rowid, new.title, new.summary, new.people, new.places);
END;
CREATE TRIGGER context_blocks_ad AFTER DELETE ON context_blocks BEGIN
  INSERT INTO context_search(context_search, rowid, title, summary, people, places)
  VALUES ('delete', old.rowid, old.title, old.summary, old.people, old.places);
END;
CREATE TRIGGER context_blocks_au AFTER UPDATE ON context_blocks BEGIN
  INSERT INTO context_search(context_search, rowid, title, summary, people, places)
  VALUES ('delete', old.rowid, old.title, old.summary, old.people, old.places);
  INSERT INTO context_search(rowid, title, summary, people, places)
  VALUES (new.rowid, new.title, new.summary, new.people, new.places);
END;

-- Off until asked for, per user.
ALTER TABLE settings ADD COLUMN context_enabled INTEGER NOT NULL DEFAULT 0;
-- How long the phone keeps the words. 0 means keep them.
ALTER TABLE settings ADD COLUMN context_retain_days INTEGER NOT NULL DEFAULT 14;
