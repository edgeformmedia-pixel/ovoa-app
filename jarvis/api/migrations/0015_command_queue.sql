-- Things the server wants the phone to do.
--
-- Some of what OVOA can do only exists on the phone: Apple Reminders, the phone's
-- calendar, Health. The background agent runs on the server and can't touch any
-- of it. So it writes the request here as ordinary words ("add 'call the vet' to
-- my reminders for 9am"), sends a silent push, and the app runs it as a chat turn
-- with a label saying the agent asked.
--
-- The push is only a doorbell. iOS won't wake an app the user swiped away, so
-- the row is what guarantees the command runs: the app drains the queue when it
-- next opens, comes forward, or the band reconnects.

CREATE TABLE command_queue (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What to do, as the user would have said it.
  text       TEXT NOT NULL,
  -- agent: the background agent asked. system: the scheduler.
  source     TEXT NOT NULL CHECK (source IN ('agent', 'system')),
  -- Why, for the log and the feed.
  reason     TEXT,
  -- pending -> running (claimed by a phone) -> done / failed. expired: nobody
  -- opened the app within a day, and a day-old "do this now" is worse than none.
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'expired')),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  ran_at     INTEGER,
  -- What the assistant replied, or what went wrong.
  result     TEXT
);
CREATE INDEX command_queue_user ON command_queue (user_id, status, created_at);

-- Who started a chat turn. NULL is the user; 'agent' is a command from the queue,
-- which runs without send or delete tools and is shown with the agent's label.
ALTER TABLE messages ADD COLUMN source TEXT;
