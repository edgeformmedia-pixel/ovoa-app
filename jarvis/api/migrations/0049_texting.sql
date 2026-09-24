-- Texting OVOA over iMessage, through Sendblue (api/src/texting.ts,
-- docs/texting.md), 2026-09-24.
--
-- Someone links their phone number to their account once, by sending OVOA's
-- number a code the app writes into the text for them. From then on a text
-- from that number is a turn on their account: the same conversation,
-- memories, tools and apps as the app, answered by text.

-- The number each account texts from: one per account, and one account per number.
CREATE TABLE text_links (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL UNIQUE,
  linked_at    INTEGER NOT NULL,
  -- A made app open in the text conversation (myapps.ts), and when it was last
  -- used: it closes itself after an hour without a text.
  app_id       TEXT,
  app_at       INTEGER,
  -- Google actions waiting for a YES by text (pending_actions ids, JSON), and since when.
  approvals    TEXT,
  approvals_at INTEGER,
  -- A turn is being answered for this person until then: the lock that keeps
  -- their texts in order, one reply at a time.
  busy_until   INTEGER
);

-- The code in the text that links a number, made by the app's Link button.
-- Works once, for 15 minutes.
CREATE TABLE text_link_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX text_link_codes_user ON text_link_codes (user_id);

-- Every text that came in, once: Sendblue may deliver the same one twice
-- (message_handle), and a linked person's texts wait here for their turn.
-- status: new, claimed, done, failed for a turn; for anything else, what was
-- done with it (linked, unlinked, stranger, told, bad_code, sms, sms_told,
-- ignored). A text that isn't a turn keeps no words (content ''). Kept two days.
CREATE TABLE text_inbox (
  handle      TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  -- The Sendblue number it came in on, which answers it.
  line        TEXT,
  content     TEXT NOT NULL DEFAULT '',
  media       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  claimed_at  INTEGER
);
CREATE INDEX text_inbox_user_status ON text_inbox (user_id, status, received_at);
CREATE INDEX text_inbox_status ON text_inbox (status, received_at);
CREATE INDEX text_inbox_phone ON text_inbox (phone, received_at);
