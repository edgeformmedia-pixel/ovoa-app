-- Levels, repeat counts and per-row context for the app's log (app/src/lib/devlog.ts).
-- A single three-second retry loop wrote 7,150 identical rows in one day and the
-- phone sent 90,103 rows in 24 hours, which is more than can be read. The app now
-- collapses repeats into one row with a count, and these columns carry what it kept:
-- `level` so "what went wrong" is one query, `count` so a loop is findable by size,
-- `seq` (gapless per session) so a lost upload shows as a hole, and route/app_state
-- so an error says which screen it happened on.
--
-- Every column is optional: a build still on a tester's phone keeps uploading fine.
ALTER TABLE device_logs ADD COLUMN level TEXT;
ALTER TABLE device_logs ADD COLUMN count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE device_logs ADD COLUMN seq INTEGER;
ALTER TABLE device_logs ADD COLUMN route TEXT;
ALTER TABLE device_logs ADD COLUMN app_state TEXT;
ALTER TABLE device_logs ADD COLUMN context TEXT;

CREATE INDEX device_logs_level ON device_logs (level, time);
