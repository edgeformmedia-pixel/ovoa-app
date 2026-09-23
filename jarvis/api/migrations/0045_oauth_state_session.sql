-- A Google connect belongs to the session that started it (src/google/oauth.ts).
--
-- POST /google/connect writes a hash of the signed-in session's token here, and
-- /google/callback connects the Google account only while that session still
-- exists. An address taken back from whoever registered it (index.ts disown)
-- ends their sessions, so a consent page they opened before, or in the minute
-- another isolate still trusts their cached session (auth.ts SESSION_CACHE_MS),
-- can't attach their Google account to it afterwards. Rows from before this
-- have none and are refused: they last ten minutes. The copy between
-- Cloudflare accounts skips this table (scripts/move-db-lib.mjs).
ALTER TABLE oauth_states ADD COLUMN session_hash TEXT;

-- users.must_verify (0041) gets a third value, written by /auth/signup on a
-- Worker that can't send codes: 2, made since sign-ups had to prove their
-- address but not held, because no code could go. 0 still means an account
-- from before, 1 one held until its code is typed. Only 1 holds (verify.ts
-- mustVerifyNow); 1 and 2 are taken back when someone else proves the address
-- (index.ts provenAccount), 0 is stamped proven instead. No schema change.
