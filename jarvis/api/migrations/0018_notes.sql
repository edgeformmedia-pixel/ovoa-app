-- Mental notes: "remember the Wi-Fi password is on the fridge", "Jake's
-- birthday is in March", "ask the dentist about the crown".
--
-- Different from memories, which the model keeps on its own about the user, and
-- from context blocks, which are summaries of what was recorded. A note is
-- something the user deliberately handed over to be kept, word for word, and
-- found again. It can carry a time (remind me then) or a place (remind me
-- there, once location tracking exists — until then the place is only kept).

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  text        TEXT NOT NULL,
  -- JSON array of short lowercase tags: ["todo", "house"]. "todo" feeds tomorrow's list.
  tags        TEXT NOT NULL DEFAULT '[]',
  -- Free text for now ("the pharmacy"); becomes a places row with F10.
  place       TEXT,
  remind_at   INTEGER,
  reminded_at INTEGER,
  done        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notes_user ON notes (user_id, ts);
CREATE INDEX notes_remind ON notes (remind_at) WHERE remind_at IS NOT NULL AND reminded_at IS NULL;
