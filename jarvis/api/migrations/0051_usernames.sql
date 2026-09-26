-- Usernames (2026-09-26, docs/ovoa-network.md): @thomas, which is also the
-- address thomas.ovoa.ai, where their websites live as projects
-- (thomas.ovoa.ai/tonys-pizza) and how other people's OVOAs find theirs.
-- Usernames and the older flat website names (tonys-pizza.ovoa.ai) are one
-- namespace, since both are a <name>.ovoa.ai: usernames.ts and sites.ts
-- labelTaken check both, and this table, before either is given out.

-- NULL until they pick one. 3-30 lowercase letters, digits and single hyphens,
-- none of OVOA's own names and nothing that looks like a brand or a sign-in page
-- (usernames.ts usernameProblem). SQLite can't add a UNIQUE column, so the
-- index is what keeps two people off one name.
ALTER TABLE users ADD COLUMN username TEXT;
-- When it was last set or changed: a change waits 30 days after the last one.
ALTER TABLE users ADD COLUMN username_at INTEGER;
CREATE UNIQUE INDEX users_username ON users (username);

-- A username someone moved away from. For 90 days nobody else can take it and
-- <old>.ovoa.ai/* answers 301 to where they are now (sites.ts resolveSite);
-- then it's forgotten (retention.ts). Their own old name they can take back.
CREATE TABLE usernames_history (
  username    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  released_at INTEGER NOT NULL
);
CREATE INDEX usernames_history_user ON usernames_history (user_id);
