-- Page watchers (watches.ts): "tell me when tickets go on sale", "watch this
-- price". OVOA reads the page on a schedule and tells its owner when what they
-- asked about happens. Read-only: a watch never buys, books or sends anything
-- to anyone but its owner.
CREATE TABLE page_watches (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  looking_for TEXT NOT NULL,
  every_min   INTEGER NOT NULL,
  until_at    INTEGER NOT NULL,
  next_at     INTEGER NOT NULL,
  last_seen   TEXT,
  last_note   TEXT,
  checks      INTEGER NOT NULL DEFAULT 0,
  fails       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'met', 'ended', 'failed')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX page_watches_due ON page_watches (status, next_at);
CREATE INDEX page_watches_user ON page_watches (user_id, status);
