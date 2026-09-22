-- What the two-minute tick needs once there is more than one person.
--
-- 1. A lease, so a tick that runs long can't overlap the next one. Cloudflare
--    starts a new tick every two minutes whether or not the last has finished,
--    and the agent's part alone can take many minutes of model calls. Two ticks
--    at once picked up the same due job, the same ringing alarm and the same
--    unpushed note, and sent each twice. One row per lane (index.ts runTick).
CREATE TABLE cron_lock (
  name  TEXT PRIMARY KEY,
  until INTEGER NOT NULL
) WITHOUT ROWID;

-- 2. A note held for someone's quiet hours now says until when, so it stops
--    taking one of the 40 places in the push queue. Held notes were skipped but
--    never marked, and 40 of them (everyone asleep in one time zone) meant no
--    one else's notes went out at all.
ALTER TABLE agent_notes ADD COLUMN hold_until INTEGER;

-- 3. Scans that read the whole table every two minutes.
-- Alarms still going off (alarms.ts nagTick).
CREATE INDEX alarms_ringing ON alarms (ringing_at) WHERE ringing_at IS NOT NULL AND stopped_at IS NULL;
-- Urgent reminders that fired and aren't done (alarms.ts nagTick).
CREATE INDEX notes_nagging ON notes (reminded_at) WHERE urgent = 1 AND done = 0 AND reminded_at IS NOT NULL;
-- The last fortnight of captured lines, across everyone (transcripts.ts titleTranscripts).
CREATE INDEX raw_captures_ts ON raw_captures (ts);
-- The nightly and 1-in-50 clear-out of old phone logs (logs.ts, index.ts nightly).
CREATE INDEX IF NOT EXISTS device_logs_received ON device_logs (received_at);

-- 4. Child rows with no index on their parent. Each deleted job, run, block or
--    place read the whole child table to find what hung off it.
CREATE INDEX agent_notes_run ON agent_notes (run_id);
CREATE INDEX agent_notes_job ON agent_notes (job_id);
CREATE INDEX agent_runs_job ON agent_runs (job_id);
CREATE INDEX context_commitments_block ON context_commitments (block_id);
CREATE INDEX visits_place ON visits (place_id);
CREATE INDEX place_events_place ON place_events (place_id);
CREATE INDEX workouts_place ON workouts (place_id);
CREATE INDEX expectations_place ON expectations (place_id);
