-- When a promise is actually due.
--
-- context_commitments already keeps what someone said they would do, in their
-- own words. What it kept about *when* was `due_hint`: the words "Thursday" or
-- "before the end of the month", which is what they said but not something you
-- can sort by, index, or wake up for. So the sweep that chases commitments had
-- to guess from prose every time it ran, and a promise with a time on it was
-- treated the same as one without.
--
-- due_at is that hint resolved to a moment, worked out once, while the
-- surrounding conversation is still there to say which Thursday. It is null
-- whenever the words don't carry a time, which is most of them — an open-ended
-- promise is still a promise, and null is the honest answer rather than a
-- guess three weeks out.

ALTER TABLE context_commitments ADD COLUMN due_at INTEGER;
CREATE INDEX context_commitments_due ON context_commitments (user_id, status, due_at);

-- What a job is chasing, when it exists because of one particular thing rather
-- than because of the clock. Set to a context_commitments id for the one-off
-- nudges the assistant schedules for itself, and used to avoid scheduling a
-- second nudge for a promise it is already watching.
ALTER TABLE agent_jobs ADD COLUMN about TEXT;
CREATE INDEX agent_jobs_about ON agent_jobs (user_id, about);
