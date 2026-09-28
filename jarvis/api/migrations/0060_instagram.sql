-- Instagram accounts people connect to OVOA (src/instagram.ts), through
-- Meta's "Instagram API with Instagram Login". Business or Creator accounts
-- only; the token is the 60-day long-lived one, AES-GCM encrypted with
-- TOKEN_ENC_KEY and refreshed before it runs out.
CREATE TABLE instagram_accounts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ig_user_id       TEXT NOT NULL,
  username         TEXT NOT NULL,
  scopes           TEXT NOT NULL,
  token_enc        TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  connected_at     INTEGER NOT NULL,
  UNIQUE (user_id, ig_user_id)
);
CREATE INDEX idx_instagram_ig_user ON instagram_accounts(ig_user_id);

-- A connect link, from the app or from a text ("connect my instagram"). No
-- session behind a text, so the link is the proof: it's only ever texted to
-- the number linked to the account, and it lasts fifteen minutes.
CREATE TABLE instagram_states (
  state      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- DMs and comments Meta's webhook delivered, so "any new IG DMs?" has an
-- answer without a round trip per conversation. Kept 14 days (retention.ts).
CREATE TABLE instagram_events (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- 'dm' | 'comment'
  from_id     TEXT,
  from_name   TEXT,
  text        TEXT,
  ref_id      TEXT,            -- the comment's id, or the DM's message id
  media_id    TEXT,
  created_at  INTEGER NOT NULL,
  seen        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_instagram_events ON instagram_events(account_id, created_at);
