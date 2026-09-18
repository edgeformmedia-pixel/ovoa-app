-- Accounts
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Login sessions. Only a SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One row per user
CREATE TABLE settings (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assistant_name TEXT NOT NULL DEFAULT 'Jarvis',
  personality    TEXT NOT NULL DEFAULT 'Witty, concise, and genuinely helpful.',
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);

-- Chat history (short-term memory)
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_user_time ON messages(user_id, created_at);

-- Durable facts Jarvis has learned (long-term memory)
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_user ON memories(user_id, created_at);
