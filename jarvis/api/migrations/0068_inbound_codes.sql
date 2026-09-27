-- Opt-in inbound for creators (inbound.ts): "text JAKE to OVOA". Anyone who
-- texts a code to OVOA's line is opting in to that person's short screener;
-- OVOA asks the questions one at a time and keeps the answers for the owner.
-- OVOA never texts anyone who didn't text the code first.
CREATE TABLE inbound_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intro      TEXT NOT NULL,
  questions  TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  daily_cap  INTEGER NOT NULL DEFAULT 1000,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX inbound_codes_user ON inbound_codes (user_id);

CREATE TABLE inbound_respondents (
  code       TEXT NOT NULL REFERENCES inbound_codes(code) ON DELETE CASCADE,
  phone      TEXT NOT NULL,
  step       INTEGER NOT NULL DEFAULT 0,
  answers    TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at    INTEGER,
  PRIMARY KEY (code, phone)
) WITHOUT ROWID;

CREATE INDEX inbound_respondents_phone ON inbound_respondents (phone, updated_at);
