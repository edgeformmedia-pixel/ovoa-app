-- A ring's key (src/ring.ts): what the Pebble Index 01's webhook signs in
-- with, so what's said into the ring reaches this account's Text OVOA thread.
--
-- Shown once when made and kept only as its SHA-256, like sessions. One per
-- account; making a new one replaces it. Goes with the account.
CREATE TABLE ring_keys (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
