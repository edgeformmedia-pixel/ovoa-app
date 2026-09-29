-- Group actions over OVOA to OVOA (network.ts ovoa_group): a poll asked of
-- several connections at once, answered one by one and told to the owner as
-- one tally once everyone answered or a day passed. A bill split needs no
-- table: each share goes out as an ordinary share message.
CREATE TABLE ovoa_groups (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  options     TEXT,              -- JSON array of strings, or NULL for an open question
  members     INTEGER NOT NULL,  -- how many were asked
  status      TEXT NOT NULL,     -- open | told
  closes_at   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_ovoa_groups_open ON ovoa_groups(status, closes_at);

CREATE TABLE ovoa_group_answers (
  group_id    TEXT NOT NULL REFERENCES ovoa_groups(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  who         TEXT NOT NULL,     -- "Maria (@maria)"
  answer      TEXT,              -- NULL: declined or never answered
  at          INTEGER NOT NULL,
  PRIMARY KEY (group_id, thread_id)
);

ALTER TABLE ovoa_threads ADD COLUMN group_id TEXT;
