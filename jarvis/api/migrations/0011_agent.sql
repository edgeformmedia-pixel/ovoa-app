-- The agent: what OVOA does when nobody is talking to it.
--
-- Everything before this migration is reactive. A turn exists because the user
-- said something, and when the reply is written the assistant stops existing
-- until they speak again. That is a chatbot. The tables here are what turn it
-- into an assistant: standing work with a due time, a record of every time it
-- acted on its own, and an outbox it can put something in when it has news.
--
-- Three rules are built into the schema rather than left to the prompt:
--
--   1. Nothing runs unless the user turned the agent on (agent_enabled = 0).
--   2. Every autonomous run is written down in agent_runs, whether or not it
--      told the user anything. An agent you cannot audit is one you cannot
--      trust with a calendar, let alone a microphone.
--   3. A run cannot outspend agent_daily_runs. A loop that wakes itself would
--      otherwise quietly burn a free-tier key overnight.

-- Standing work. One row is one thing the agent does on a schedule, in the
-- user's own words: "every morning tell me what's actually on today".
CREATE TABLE agent_jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Shown in Settings. Six words, the user's framing, not the prompt.
  title       TEXT NOT NULL,
  -- What the autonomous turn is asked to do. Written by the model from what the
  -- user said, so it survives being read back months later with no conversation
  -- around it.
  instruction TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('once', 'daily', 'weekly', 'interval')),
  -- Minutes past local midnight, for daily and weekly.
  at_minutes  INTEGER,
  -- 0 = Sunday, for weekly.
  weekday     INTEGER,
  -- For interval jobs. Floored at 15 so a job cannot become a busy loop.
  every_minutes INTEGER,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  run_count   INTEGER NOT NULL DEFAULT 0,
  -- Consecutive failures. A job that keeps failing is paused rather than
  -- retried forever.
  fail_count  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  -- always: say something every time. ifuseful: only when there is news, which
  -- is what keeps a daily job from becoming daily noise. never: act silently,
  -- it still lands in the log.
  notify      TEXT NOT NULL DEFAULT 'ifuseful' CHECK (notify IN ('always', 'ifuseful', 'never')),
  -- user: they asked for it. agent: it proposed it and they kept it.
  -- system: the built-in ones (commitment sweep, maintenance).
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent', 'system')),
  created_at  INTEGER NOT NULL
);
-- The scan every cron tick makes: due, active, oldest first.
CREATE INDEX agent_jobs_due ON agent_jobs (status, next_run_at);
CREATE INDEX agent_jobs_user ON agent_jobs (user_id, status);

-- Standing intent, as opposed to standing work. A goal has no due time; it is
-- something the agent should keep in mind on every run and act on when the
-- chance appears. "Keep Thursday evenings clear." "I'm trying to call my mother
-- more." These are what make the difference between a scheduler and an
-- assistant, and they are read into every autonomous turn.
CREATE TABLE agent_goals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  -- Why they want it, when they said why. Kept because a goal without its
  -- reason gets applied stupidly.
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'met', 'dropped')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_goals_active ON agent_goals (user_id, status);

-- Every autonomous run, including the ones that decided to stay quiet. This is
-- the audit log: it answers "what has this thing been doing while I wasn't
-- looking", which the user is entitled to ask at any time.
CREATE TABLE agent_runs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
  -- job: a scheduled job came due. commitment: the sweep found something owed.
  -- manual: the user tapped Run now. event: something happened worth reacting to.
  trigger    TEXT NOT NULL CHECK (trigger IN ('job', 'commitment', 'manual', 'event')),
  started_at INTEGER NOT NULL,
  ms         INTEGER,
  engine     TEXT,
  -- JSON array of the tools it called, in order. The honest answer to "what did
  -- it actually touch".
  tools_used TEXT,
  outcome    TEXT NOT NULL DEFAULT 'quiet' CHECK (outcome IN ('spoke', 'quiet', 'acted', 'error', 'skipped')),
  -- What it decided, or what went wrong. One or two sentences.
  detail     TEXT
);
CREATE INDEX agent_runs_user ON agent_runs (user_id, started_at);

-- The outbox. When the agent has something to say it writes it here rather than
-- pushing straight to the phone, so the note survives a failed push, a phone
-- that is off, and quiet hours.
CREATE TABLE agent_notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
  run_id     TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  -- brief: the scheduled summary. nudge: something owed or about to be missed.
  -- finding: it went looking and found something. done: it did a thing.
  -- question: it needs an answer before it can continue.
  kind       TEXT NOT NULL CHECK (kind IN ('brief', 'nudge', 'finding', 'done', 'question')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  -- low sits in the app until opened. normal pushes, unless it is quiet hours.
  -- high pushes through quiet hours, and is meant for things with a deadline
  -- tonight, not for anything the agent merely finds interesting.
  urgency    TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high')),
  -- A pending_actions id when the note is a proposal the user can approve, or a
  -- context_commitments id when it is a nudge about something they owe.
  action_id  TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  dismissed_at INTEGER,
  pushed_at  INTEGER
);
CREATE INDEX agent_notes_unread ON agent_notes (user_id, read_at, created_at);
-- The queue the push sweep drains: written, never sent.
CREATE INDEX agent_notes_unpushed ON agent_notes (pushed_at, created_at);

-- Expo push tokens. One row per install; a user with a phone and an iPad has two.
CREATE TABLE push_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  -- Expo says DeviceNotRegistered: the app was deleted. Dropped after that.
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_tokens_user ON push_tokens (user_id);

-- The ceiling. One row per user per UTC day, counting autonomous runs only:
-- turns the user asked for are never refused for budget.
CREATE TABLE agent_budget (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  runs    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Off until asked for, like context. An assistant that starts acting on its own
-- the moment you sign up is a worse product and a worse citizen.
ALTER TABLE settings ADD COLUMN agent_enabled INTEGER NOT NULL DEFAULT 0;
-- suggest: it may read anything and propose anything, but every change waits
-- for a tap. act: it may also make reversible changes on its own — an event, a
-- reminder, a draft. Sending a message to another person and deleting anything
-- always wait for approval, at every level, and that is enforced in code rather
-- than asked for in the prompt.
ALTER TABLE settings ADD COLUMN agent_autonomy TEXT NOT NULL DEFAULT 'suggest';
-- Minutes past local midnight. Default 22:00 to 07:00: notes still get written
-- during quiet hours, they just wait to be pushed unless they are urgent.
ALTER TABLE settings ADD COLUMN quiet_start INTEGER NOT NULL DEFAULT 1320;
ALTER TABLE settings ADD COLUMN quiet_end INTEGER NOT NULL DEFAULT 420;
-- Autonomous runs per UTC day.
ALTER TABLE settings ADD COLUMN agent_daily_runs INTEGER NOT NULL DEFAULT 40;
