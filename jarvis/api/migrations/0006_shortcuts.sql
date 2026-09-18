-- iPhone shortcuts the assistant wrote. `file` is the signed .shortcut; the
-- Shortcuts app downloads it with `download_token` (no login) until it expires.
CREATE TABLE shortcuts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  color               TEXT,
  steps               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  warnings            TEXT NOT NULL,
  file                BLOB NOT NULL,
  download_token      TEXT,
  download_expires_at INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_shortcuts_user ON shortcuts(user_id, created_at);
CREATE UNIQUE INDEX idx_shortcuts_token ON shortcuts(download_token);
