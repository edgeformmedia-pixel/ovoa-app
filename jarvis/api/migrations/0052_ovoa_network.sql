-- OVOA to OVOA (2026-09-26, network.ts, docs/ovoa-network.md): people's OVOAs
-- talking to each other, each as its owner's agent. Everyone is on this one
-- Worker and database, so it's messages between accounts: no federation.
-- Nothing moves until both people agreed to connect, the other side only ever
-- sees free/busy, and anything that commits someone waits for their yes.

-- Who may talk to whom. One row per pair, whichever way it was asked
-- (network.ts pairOf looks both ways).
--   pending   asked, not answered
--   accepted  their OVOAs may talk
--   declined  said no: asked again within 30 days, nothing happens
--   blocked   never again; silent to the other person, who still sees "waiting"
--   ended     disconnected; either can ask again
CREATE TABLE connections (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'blocked', 'ended')),
  blocked_by   TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX connections_addressee ON connections (addressee_id, status);

-- What each owner lets their OVOA do for one connection. Made with the
-- defaults when the connection is accepted.
CREATE TABLE connection_perms (
  connection_id         TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Their calendar's free and busy times, never what's in it.
  share_free_busy       INTEGER NOT NULL DEFAULT 1,
  -- Answer a question without asking, from share_note only.
  auto_answer_questions INTEGER NOT NULL DEFAULT 0,
  -- Take a meeting at a free time without asking.
  auto_accept_meetings  INTEGER NOT NULL DEFAULT 0,
  -- In their words, what may be shared with this person: the only facts an
  -- automatic answer can use.
  share_note            TEXT,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (connection_id, user_id)
);

-- One exchange: a meeting to find, a question, a reminder, something shared.
-- open until it's settled, then done; dropped when a limit or a disconnect
-- ended it.
CREATE TABLE ovoa_threads (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  started_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  subject       TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  -- Messages so far: at most 6 (network.ts MAX_HOPS).
  hops          INTEGER NOT NULL DEFAULT 0,
  -- The one who started it asked for it to be booked on their calendar once agreed.
  book          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX ovoa_threads_connection ON ovoa_threads (connection_id, status);

-- Every message one OVOA sent another: the log of what each said for its owner
-- (ovoa_log, GET /ovoa/log). The cron's network lane (network.ts networkTick)
-- takes the queued ones to the other side.
CREATE TABLE ovoa_messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES ovoa_threads(id) ON DELETE CASCADE,
  from_user     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('schedule', 'question', 'share', 'reminder', 'reply', 'decline')),
  -- JSON, at most 2,000 characters (network.ts BODY_MAX).
  body          TEXT NOT NULL,
  -- queued, waiting (on the owner's yes), done, dropped.
  status        TEXT NOT NULL DEFAULT 'queued',
  hop           INTEGER NOT NULL,
  -- A reminder for later isn't handed over before then.
  deliver_after INTEGER,
  created_at    INTEGER NOT NULL,
  handled_at    INTEGER,
  detail        TEXT
);
CREATE INDEX ovoa_messages_queue ON ovoa_messages (status, created_at);
CREATE INDEX ovoa_messages_from ON ovoa_messages (from_user, created_at);
CREATE INDEX ovoa_messages_to ON ovoa_messages (to_user, created_at);
CREATE INDEX ovoa_messages_thread ON ovoa_messages (thread_id, created_at);

-- What waits for an owner's yes: taking a meeting, answering a question,
-- putting an agreed meeting on their calendar. Answered in the conversation
-- (ovoa_approve) or in the app; after 3 days it lapses and the other side is
-- told there was no answer.
CREATE TABLE ovoa_approvals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ovoa_messages(id) ON DELETE CASCADE,
  thread_id  TEXT NOT NULL REFERENCES ovoa_threads(id) ON DELETE CASCADE,
  -- accept_meeting, answer_question, book_meeting.
  kind       TEXT NOT NULL,
  -- What they're asked, in a sentence.
  summary    TEXT NOT NULL,
  -- JSON: the times offered.
  options    TEXT,
  -- pending, yes, no, changes, lapsed.
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ovoa_approvals_user ON ovoa_approvals (user_id, status);
CREATE INDEX ovoa_approvals_expiry ON ovoa_approvals (status, expires_at);
