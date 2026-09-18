-- One connected Google account per user. Tokens are AES-GCM encrypted with TOKEN_ENC_KEY.
CREATE TABLE google_accounts (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  name              TEXT,
  scopes            TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc  TEXT,
  access_expires_at INTEGER,
  connected_at      INTEGER NOT NULL
);

-- Short-lived OAuth handshakes (state + PKCE verifier).
CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  return_url    TEXT,
  expires_at    INTEGER NOT NULL
);

-- Risky assistant actions (send email, delete, invite) wait here for the user to approve.
CREATE TABLE pending_actions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  args       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_user ON pending_actions(user_id, created_at);
