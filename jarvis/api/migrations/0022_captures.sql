-- Transcripts: everything said, kept word for word, and titled.
--
-- Every line is kept with where it came from:
--   mic        said to OVOA, into the phone or the band
--   assistant  what OVOA said back
--   recording  a recording made on purpose (Record tab, the clip)
--   background overheard while Always listen was on and not meant for OVOA.
--              Only ever stored for a DEV_EMAILS account with
--              settings.capture_everything on: ambient capture was ruled out for
--              the product on 2026-09-20 (consent law), and stays a development
--              experiment.
--
-- Lines fall into five-minute blocks. Each block gets a title and a short
-- summary; each hour a title written from its blocks' titles; each day one
-- written from its hours. That is the whole index: browsing goes day, hour,
-- block, words.
--
-- Everything is deleted after 14 days (src/retention.ts, docs/retention.md)
-- except two things. A recording made on purpose ('recording') keeps its words
-- until the user deletes them. And the day's row becomes the day's summary
-- (0042_retention.sql, src/daysummary.ts), which is kept.

CREATE TABLE raw_captures (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  text    TEXT NOT NULL,
  source  TEXT NOT NULL CHECK (source IN ('mic', 'assistant', 'recording', 'background'))
);
CREATE INDEX raw_captures_user ON raw_captures (user_id, ts);

-- Titles at three grains. bucket: the five-minute block's start as an ISO
-- string, or the local hour (2026-09-21T14) or day (2026-09-21).
CREATE TABLE transcript_titles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grain      TEXT NOT NULL CHECK (grain IN ('5m', 'hour', 'day')),
  bucket     TEXT NOT NULL,
  start      INTEGER NOT NULL,
  title      TEXT,
  summary    TEXT,
  -- Which sources the lines came from, comma-separated: "mic,assistant".
  sources    TEXT,
  -- Lines (for 5m) or blocks (for hour/day) it was written from; a new line
  -- arriving late makes it out of date and it is written again.
  covers     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, grain, bucket)
);
CREATE INDEX transcript_titles_start ON transcript_titles (user_id, grain, start);
