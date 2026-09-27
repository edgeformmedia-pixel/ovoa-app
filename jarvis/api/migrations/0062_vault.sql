-- The vault (vault.ts): details OVOA uses to act for someone, like a home
-- address for a delivery form, a frequent-flyer number for a booking, shoe size,
-- seat preference. The value is AES-GCM encrypted with TOKEN_ENC_KEY
-- (crypto.ts), like Google tokens; the label and category are not secret.
-- Never card numbers, bank numbers, SSNs, passwords or codes (refused in code).
CREATE TABLE vault_items (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  label      TEXT NOT NULL COLLATE NOCASE,
  value_enc  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, label)
);
