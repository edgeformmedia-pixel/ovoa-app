-- Standing approvals (rules.ts): "don't ask before emailing my wife", "just add
-- things to my calendar". Each rule covers one kind of action (email, text,
-- call, calendar), for one recipient or, when recipient is '', for anyone.
-- Checked before an action is parked for a YES; deletes, money and anything the
-- agent starts on its own always ask.
CREATE TABLE approval_rules (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  recipient  TEXT NOT NULL DEFAULT '',
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, recipient)
);
