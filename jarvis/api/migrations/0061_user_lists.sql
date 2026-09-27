-- Named lists OVOA keeps for someone between steps and across days (lists.ts):
-- "every office and its number", "the places we liked", results of a batch.
-- Rows are a JSON array of plain objects. Theirs until they delete it or the
-- account goes (CASCADE).
CREATE TABLE user_lists (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL COLLATE NOCASE,
  rows       TEXT NOT NULL DEFAULT '[]',
  row_count  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
) WITHOUT ROWID;
