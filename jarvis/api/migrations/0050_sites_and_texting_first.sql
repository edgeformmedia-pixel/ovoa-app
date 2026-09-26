-- Instinct, grown up (2026-09-26): OVOA texts first, does more on its own, and
-- builds websites that live at <name>.ovoa.ai, for the person or for their
-- clients. The websites are api/src/sites.ts (docs/sites.md); the texts it
-- sends first are api/src/reach.ts (docs/texting.md).

-- A website OVOA built and hosts at <slug>.ovoa.ai. The page is one HTML
-- document the model wrote (sites.ts runBuild), cleaned before it's kept and
-- served under a policy that runs no script at all (docs/sites.md).
CREATE TABLE sites (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The subdomain: lowercase letters, digits and single hyphens (sites.ts slugProblem).
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  -- Who it's for, when it's a client's site rather than their own.
  client       TEXT,
  -- What they said it should say and look like, with each change they asked
  -- for added: enough to build it again from nothing.
  brief        TEXT NOT NULL,
  html         TEXT,
  title        TEXT,
  -- building: no page yet. live. offline: taken down, can go back up.
  -- failed: the first build never worked.
  status       TEXT NOT NULL DEFAULT 'building',
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  published_at INTEGER,
  -- Deleted: offline at once and gone for good 30 days later (retention.ts);
  -- until then it can be put back, and nobody else can take its name.
  deleted_at   INTEGER
);
CREATE INDEX sites_user ON sites (user_id, created_at);

-- Every build and every change, in order. The cron's sites lane works through
-- them (sites.ts sitesTick), a site's own in the order they were asked for.
CREATE TABLE site_builds (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- create: the first page. change: a change to it, in their words (request).
  kind        TEXT NOT NULL CHECK (kind IN ('create', 'change')),
  request     TEXT NOT NULL,
  -- queued, running, done, failed, refused (the designer wouldn't build it).
  status      TEXT NOT NULL DEFAULT 'queued',
  detail      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX site_builds_queue ON site_builds (status, created_at);
CREATE INDEX site_builds_site ON site_builds (site_id, created_at);
CREATE INDEX site_builds_user ON site_builds (user_id, created_at);

-- What visitors sent through a site's contact form. Texted (or pushed) and
-- emailed to the site's owner as it arrives, and kept 14 days like everything
-- else (retention.ts).
CREATE TABLE site_leads (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT,
  email      TEXT,
  phone      TEXT,
  message    TEXT NOT NULL,
  -- The sender's address as a keyed hash that changes every day, for the
  -- per-sender limit. Never the address itself.
  sender_tag TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX site_leads_site ON site_leads (site_id, created_at);
CREATE INDEX site_leads_user ON site_leads (user_id, created_at);
CREATE INDEX site_leads_sender ON site_leads (sender_tag, created_at);

-- Every text OVOA sent first (reach.ts): which kind, when, and whether
-- Sendblue took it. No words: those are in messages, with the rest of the
-- conversation. Read for the day's cap.
CREATE TABLE text_outbox (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  ok      INTEGER NOT NULL
);
CREATE INDEX text_outbox_user ON text_outbox (user_id, sent_at);

-- Texting first: on for everyone who links a number, until they turn it off
-- (by text, texting.ts texting_first, or PUT /texting).
ALTER TABLE text_links ADD COLUMN proactive INTEGER NOT NULL DEFAULT 1;
-- Until when a YES counts: half an hour after a reply, longer after something
-- OVOA proposed in a text it sent first. NULL: approvals_at plus half an hour.
ALTER TABLE text_links ADD COLUMN approvals_until INTEGER;
-- The newest of OVOA's unanswered questions that has had its one follow-up
-- (agent.ts followUpDropped): none is chased twice.
ALTER TABLE text_links ADD COLUMN followed_up_at INTEGER;
