-- Signing in to the app with Google or Apple (src/signin.ts).
--
-- 1. A sign-in in progress. For Google: the OAuth state Google hands back to
--    /google/callback, the PKCE verifier, where to send the app back to, and a
--    hash of the key the app was given to redeem the result with. (The connect
--    flow's oauth_states needs a signed-in user, which a sign-in hasn't got.)
--    For Apple: a hash of the nonce the app passes to Apple. Ten minutes.
CREATE TABLE signin_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL, -- 'google' or 'apple'
  code_verifier TEXT,
  return_url    TEXT,
  key_hash      TEXT,
  expires_at    INTEGER NOT NULL
) WITHOUT ROWID;

-- 2. Who Google said this was, behind the one-time code in the app's return
--    URL: sixty seconds, once, and only with the key from 1. Only hashes of the
--    code and the key are kept, and nothing here is a session: the account is
--    looked up, or a signup ticket issued, when the app redeems it.
CREATE TABLE signin_codes (
  code_hash  TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

-- 3. Apple's own id for a person ("sub"), so a returning Apple sign-in finds
--    its account even after the address behind the Apple ID has changed. A
--    signup ticket from an Apple sign-in carries it to the account it makes.
--    NULLs don't collide in a UNIQUE index, so every other account is fine.
ALTER TABLE users ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX idx_users_apple_sub ON users(apple_sub);
ALTER TABLE signup_tickets ADD COLUMN apple_sub TEXT;
