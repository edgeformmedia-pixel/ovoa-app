-- Campaigns (campaigns.ts): one approval, many targets. campaign_start parks ONE
-- pending action; approving it (approvers.ts) is the only thing that sets
-- approved_at, and the cron only works campaigns that are running with it set.
-- Items are worked a few per tick, inside the person's daytime hours.
CREATE TABLE campaigns (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('email', 'research', 'friends')),
  title         TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  subject       TEXT,
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'running', 'done', 'stopped')),
  action_id     TEXT,
  approved_at   INTEGER,
  item_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX campaigns_user ON campaigns (user_id, created_at);
CREATE INDEX campaigns_running ON campaigns (status) WHERE status = 'running';

CREATE TABLE campaign_items (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  data        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'done', 'skipped', 'failed')),
  result      TEXT,
  done_at     INTEGER,
  PRIMARY KEY (campaign_id, idx)
) WITHOUT ROWID;
CREATE INDEX campaign_items_done ON campaign_items (status, done_at);
