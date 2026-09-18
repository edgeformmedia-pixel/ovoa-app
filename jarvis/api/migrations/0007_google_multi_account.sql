-- Several Google accounts per user (e.g. work and personal). `label` is a short tag the
-- user or the assistant picks; `is_default` marks the account used when a request doesn't
-- say which. Existing connections carry over as each user's default.
CREATE TABLE google_accounts_new (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  name              TEXT,
  label             TEXT,
  is_default        INTEGER NOT NULL DEFAULT 0,
  scopes            TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc  TEXT,
  access_expires_at INTEGER,
  connected_at      INTEGER NOT NULL
);

INSERT INTO google_accounts_new
  (id, user_id, email, name, label, is_default, scopes, refresh_token_enc, access_token_enc, access_expires_at, connected_at)
SELECT lower(hex(randomblob(16))), user_id, email, name, NULL, 1, scopes, refresh_token_enc, access_token_enc,
       access_expires_at, connected_at
FROM google_accounts;

DROP TABLE google_accounts;
ALTER TABLE google_accounts_new RENAME TO google_accounts;

CREATE UNIQUE INDEX idx_google_user_email ON google_accounts(user_id, email);
CREATE UNIQUE INDEX idx_google_user_label ON google_accounts(user_id, label COLLATE NOCASE);
