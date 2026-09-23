-- What each person's day cost to serve.
--
-- Until now the only way to know what OVOA cost per person was to pull
-- Cloudflare's account-wide analytics and Deepgram's invoice and divide by a
-- guess. Neither knows which person a token belonged to, and neither sees what
-- the phone streams straight to Deepgram. This table does: every model call,
-- every voiced sentence, every second of microphone sent, counted against the
-- person it was for, on the day it happened.
--
-- One row per (person, day, kind, engine, model), upserted, the way obs.ts
-- keeps engine_stats: a heavy day is a few dozen rows per person, not one per
-- event. Writing a row never fails the request it describes. Rows older than
-- 90 days go in the nightly tidy-up (35 days since the v1 release: the
-- nightly purge, src/retention.ts).
--
-- `kind` is one of:
--   turn        one message answered (n counts turns; the cost is on the rows below)
--   llm_call    one model call, with its tokens; engine = gemini/deepseek/glm/workers
--   tts         characters voiced; engine = deepgram-aura-2, workers-aura-1, device...
--   stt_stream  seconds of microphone the phone streamed to live transcription
--   stt_clip    seconds of recorded audio transcribed on the server
--   search      web searches; engine = gemini or duckduckgo
--
-- est_micro_usd is the cost at list price in millionths of a dollar, an
-- integer so that a thousand additions a day never drift (src/pricing.ts).
CREATE TABLE usage_daily (
  -- The person, or '' for work the server did for nobody in particular (a
  -- nightly job, a debug call). Not a foreign key: a deleted account's cost
  -- was still a cost, and the row says nothing about who they were.
  user_id        TEXT NOT NULL,
  -- UTC, 'YYYY-MM-DD'. Days are the operator's days, like the other rollups.
  day            TEXT NOT NULL,
  kind           TEXT NOT NULL,
  engine         TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  n              INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  -- How many of input_tokens the provider had cached and charged less for.
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  chars          INTEGER NOT NULL DEFAULT 0,
  -- Audio seconds, with the fraction: a 1.8 s clip is not 1 s and not 2 s.
  seconds        REAL NOT NULL DEFAULT 0,
  est_micro_usd  INTEGER NOT NULL DEFAULT 0,
  last_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, kind, engine, model)
) WITHOUT ROWID;
-- The nightly prune and "everyone, last seven days" both read by day.
CREATE INDEX usage_daily_day ON usage_daily (day);
