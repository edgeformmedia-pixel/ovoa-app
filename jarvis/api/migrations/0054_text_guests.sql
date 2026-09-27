-- Texts from numbers not linked to an account: a free trial (guest.ts).
-- 5 AI replies, 5 more once they give an email, then Base.
CREATE TABLE text_guests (
  phone       TEXT PRIMARY KEY,
  used        INTEGER NOT NULL DEFAULT 0,
  email       TEXT,
  -- The last few turns, JSON [{role,text}], so replies follow the conversation.
  history     TEXT NOT NULL DEFAULT '[]',
  -- When they were last told they're out of free texts (once every 6 hours).
  told_at     INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
