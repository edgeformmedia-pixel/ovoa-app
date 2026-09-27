-- Outlook and Microsoft 365 (microsoft.ts): one connected Microsoft account per
-- person, like google_accounts. Tokens are encrypted with TOKEN_ENC_KEY; the
-- refresh token is replaced each time Microsoft hands back a new one.
CREATE TABLE microsoft_accounts (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  name              TEXT,
  scopes            TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc  TEXT,
  access_expires_at INTEGER,
  connected_at      INTEGER NOT NULL
);
