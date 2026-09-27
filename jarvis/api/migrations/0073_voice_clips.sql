-- Voice-note replies (voicereply.ts, off unless TEXT_VOICE_REPLIES=1): a reply
-- spoken as audio, served to Sendblue by a random token for an hour, then gone.
CREATE TABLE voice_clips (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mp3        BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX voice_clips_expires ON voice_clips (expires_at);
