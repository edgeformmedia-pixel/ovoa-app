-- What the server knows about itself.
--
-- Written after 2026-09-21, when all three model engines failed inside the same
-- hour. The phone wrote 166 "couldn't get a reply" into device_logs. The Worker
-- wrote nothing that outlived a `wrangler tail` session, and not one 5xx ever
-- reached the phone -- because a streamed /chat answers 200 and puts its error
-- inside the stream (streamTurn in src/index.ts), so app.onError never runs.
-- The only way to see any of it was `wrangler d1 execute` from a machine with
-- the right Cloudflare login.
--
-- device_logs is deliberately NOT reused for this:
--
--   * It is the phone's log. device_id and session_id are NOT NULL there
--     (0009_device_logs.sql) and the server has neither, so every server row
--     would need invented values.
--   * It cannot count. 166 copies of one failure would be 166 rows, which is
--     the exact shape that made this hard to read in the first place.
--   * It is pruned by a 1-in-50 roll inside a phone upload (src/logs.ts). The
--     moment the phone stops uploading -- which is when things are broken --
--     nothing prunes and nothing new arrives.
--
-- The reader endpoint spans both, because "the phone said X at 14:03" next to
-- "the server threw Y at 14:03" is the whole point.
--
-- Every table here is a rollup, so the worst possible day costs a few hundred
-- rows rather than tens of thousands. The nightly purge deletes them at 14
-- days (src/retention.ts).

-- One row per distinct failure, counted. 166 of the same thing is one row
-- saying 166, which is the sentence worth reading.
CREATE TABLE error_events (
  -- kind + route + the message with its ids, long numbers, quoted text and
  -- email addresses taken out. Two turns that failed because DeepSeek is out of
  -- credit have to land on the same row or the count means nothing.
  -- See fingerprint() in src/obs.ts.
  fingerprint     TEXT PRIMARY KEY,
  -- error: something threw. stall: a streamed turn produced no sentence for 45 s.
  -- gone: the phone stopped reading mid-reply. engines_down: nothing could
  -- answer at all. cron: a scheduled tick failed.
  kind            TEXT NOT NULL,
  -- The route as it was registered ("/agent/jobs/:id"), never as it was
  -- requested, so one row covers every job and no id lands in the log.
  route           TEXT NOT NULL,
  status          INTEGER,
  message         TEXT NOT NULL,
  stack           TEXT,
  count           INTEGER NOT NULL DEFAULT 1,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  -- The cf-ray of the most recent one. It is the same id the Workers Logs entry
  -- carries, so a row here can be found in the dashboard while it is still
  -- retained there (3 days on the free plan, 7 on paid).
  last_request_id TEXT,
  -- No foreign key on purpose: plenty of errors happen before anyone is signed
  -- in, and deleting an account should not delete the record that it broke.
  last_user_id    TEXT,
  last_ms         INTEGER
);
CREATE INDEX error_events_recent ON error_events (last_seen);
CREATE INDEX error_events_kind ON error_events (kind, last_seen);

-- Every engine attempt, rolled up by the hour, including the ones that were
-- skipped because the engine was already in cooldown. "Which engine answered
-- and which were dead at 3pm" is one SELECT against this.
CREATE TABLE engine_stats (
  hour       TEXT NOT NULL,  -- UTC, "2026-09-21T14"
  engine     TEXT NOT NULL,  -- gemini / deepseek / workers
  model      TEXT NOT NULL,
  -- ok, or the failure in one word: out_of_free, no_credit, quota,
  -- rate_limited, bad_key, no_model, upstream_5xx, timeout, empty,
  -- too_many_rounds, skipped, failed. See classifyEngineError in src/llm.ts.
  outcome    TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  ms_total   INTEGER NOT NULL DEFAULT 0,
  ms_max     INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_at    INTEGER NOT NULL,
  PRIMARY KEY (hour, engine, model, outcome)
);
CREATE INDEX engine_stats_recent ON engine_stats (last_at);

-- One row per cron per hour. The two-minute beat should show 30 ticks in a
-- complete hour; a `hour` that is three hours old means it stopped three hours
-- ago, which no amount of reading agent_runs would have told you (agent_runs
-- only gets a row when an autonomous turn actually runs, and it had 2).
--
-- Rolled up rather than appended because a row every two minutes forever is
-- 262,800 rows a year for a number nobody reads twice: 24 rows a day, pruned at
-- 14 days, answers the same question.
CREATE TABLE cron_ticks (
  hour        TEXT NOT NULL,
  cron        TEXT NOT NULL,
  ticks       INTEGER NOT NULL DEFAULT 0,
  -- Everything the ticks in this hour decided, added up: jobs run, notes
  -- pushed, routines fired. Zero across a whole hour is normal and fine; it is
  -- `ticks` that says whether the beat is beating.
  did         INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  ms_total    INTEGER NOT NULL DEFAULT 0,
  ms_max      INTEGER NOT NULL DEFAULT 0,
  -- The last tick in this hour that decided anything, as JSON, so a quiet hour
  -- still says what the most recent decision was.
  last_detail TEXT,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (hour, cron)
);
CREATE INDEX cron_ticks_recent ON cron_ticks (last_at);
