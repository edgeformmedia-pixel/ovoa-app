-- 14-day retention (the v1 release, 2026-09-23; docs/retention.md is the
-- table, src/retention.ts the purge, src/daysummary.ts the day summary).
--
-- After 14 days everything is deleted except each day's summary and what the
-- person entered or set up themselves. A nightly writer keeps one summary per
-- day first; the nightly purge then deletes the rest. What the rules need that
-- the tables didn't have:
--
-- No UPDATE backfills here on purpose: the copy between Cloudflare accounts
-- (scripts/move-db.mjs) writes the old rows after the migrations ran, so they
-- get these columns' defaults, and the purge treats a NULL as "no clock yet"
-- rather than "old".

-- 1. Where a memory came from. 'asked': they told OVOA to remember it
--    ("remember that I'm vegan"), and it is kept. 'learned': the background
--    memory pass picked it up from a conversation, and it is deleted 14 days
--    after it was written. Every memory until now came from that pass.
ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'learned';

-- 2. When a name someone seemed to call the user by was last heard, so a name
--    nobody has used for 14 days ages out on its own. The count isn't wiped
--    while it's still being heard. NULL (rows from before): the purge starts
--    their clock the first night.
ALTER TABLE name_candidates ADD COLUMN last_heard_at INTEGER;

-- 3. A routine's streak, kept on the routine so it outlives its events, which
--    go at 14 days. `streak` is days in a row with everything done, ending on
--    `streak_day` (a local YYYY-MM-DD); days after it are counted from
--    routine_events. Brought forward as events are written and before the
--    purge takes them (routines.ts settleStreak). NULL: nothing folded yet.
ALTER TABLE routines ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN streak_day TEXT;

-- 4. When a promise was marked done or dropped, so it is kept for 14 days
--    from then rather than from when it was heard. NULL for ones settled
--    before this: the purge falls back to created_at.
ALTER TABLE context_commitments ADD COLUMN settled_at INTEGER;

-- 5. The day's summary. A grain='day' row with this set is the one summary
--    kept for that day, written nightly from everything the day held
--    (daysummary.ts). A day row without it is only the transcript's own title,
--    which that summary replaces; the transcript titler leaves a summarised
--    day alone.
ALTER TABLE transcript_titles ADD COLUMN summarised_at INTEGER;

-- 6. Time-first indexes for the tables the purge and the summary writer read
--    across everyone by time. Each had only (user_id, time), so a nightly
--    "older than 14 days" read the whole table, once per batch.
CREATE INDEX messages_created ON messages (created_at);
CREATE INDEX context_blocks_started ON context_blocks (started_at);
CREATE INDEX action_log_ts ON action_log (ts);
CREATE INDEX hr_samples_ts ON hr_samples (ts);
CREATE INDEX location_points_ts ON location_points (ts);
CREATE INDEX visits_left ON visits (left_at);
