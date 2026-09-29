-- The browser agent (src/browser.ts): OVOA driving a real cloud browser for
-- someone, on sites with no API.

-- One errand. Its steps are the durable object's; this is what the person can
-- ask about and what survives a restart. status: running | waiting | done | failed.
-- waiting = stopped for a YES (pending_actions.tool = 'browser_continue') or
-- for them to sign in through a live view.
CREATE TABLE browser_tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal        TEXT NOT NULL,
  start_url   TEXT,
  status      TEXT NOT NULL,
  result      TEXT,
  steps       INTEGER NOT NULL DEFAULT 0,
  source      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_browser_tasks_user ON browser_tasks(user_id, created_at DESC);

-- What the person signed in to, kept so the next errand starts signed in:
-- the site's cookies, AES-GCM encrypted with TOKEN_ENC_KEY. Never a password.
-- "Forget my logins" deletes these rows.
CREATE TABLE browser_logins (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host        TEXT NOT NULL,
  cookies_enc TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, host)
);
