-- What OVOA actually did, one row per thing.
--
-- agent_runs already says what the background agent decided. This is wider and
-- flatter: every change a tool made, every reminder that fired, every buzz, every
-- autonomous run, whoever started it. It is what the home screen's feed is built
-- from, and what "what did you do for me today" is answered from.
--
-- minutes_saved is an estimate, set from a fixed table in actionlog.ts at the
-- moment the row is written, and always shown to the user as "~estimated". It is
-- stored rather than computed on read so that changing the table later doesn't
-- quietly rewrite last month's numbers.

CREATE TABLE action_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  -- email_send, event, reminder, note, buzz, agent_run, routine_done, ...
  kind          TEXT NOT NULL,
  -- One line, in plain words: "Added Dentist to your calendar".
  summary       TEXT NOT NULL,
  -- chat: the user asked. agent: the background agent. system: the scheduler.
  -- approval: the user tapped Approve on something parked earlier.
  source        TEXT NOT NULL CHECK (source IN ('chat', 'agent', 'system', 'approval')),
  -- The row this is about, when there is one (a routine, a job, a note).
  ref_id        TEXT,
  minutes_saved REAL NOT NULL DEFAULT 0
);
CREATE INDEX action_log_user ON action_log (user_id, ts);
CREATE INDEX action_log_kind ON action_log (user_id, kind, ts);
