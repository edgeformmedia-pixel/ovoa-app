-- Apps people make themselves from the app's Apps → Create (src/myapps.ts).
--
-- A made app is a name, one line about it, an icon, and the instructions the
-- assistant follows while it's open in Talk. It is not code: it runs on the
-- assistant like any other message, so it needs nothing else stored.
CREATE TABLE user_apps (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  about        TEXT NOT NULL,
  icon         TEXT NOT NULL,
  tone         TEXT NOT NULL,
  instructions TEXT NOT NULL,
  opener       TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX user_apps_user ON user_apps (user_id, created_at);
