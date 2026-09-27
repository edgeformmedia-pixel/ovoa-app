-- Signed-in sessions someone lent OVOA's browser (sitesessions.ts): after they
-- log into a site themselves in the OVOA app, the app sends that site's cookies
-- here. OVOA never sees or keeps a password. Cookies are AES-GCM encrypted with
-- TOKEN_ENC_KEY; each session lasts at most 30 days and can be removed anytime.
CREATE TABLE site_sessions (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host        TEXT NOT NULL,
  cookies_enc TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  PRIMARY KEY (user_id, host)
) WITHOUT ROWID;
