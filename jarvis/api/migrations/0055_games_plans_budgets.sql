-- Instinct, more useful (2026-09-26): games OVOA makes for two people
-- (sites.ts, kind 'game'; together.ts), plans it follows up on (plans_life.ts),
-- and spending budgets with purchases that wait for a YES (budget.ts).
-- docs/instinct-more.md.

-- A game is a site of kind 'game': a small two-player page built by the same
-- lane, the only kind of page served with inline script (sandboxed, no network).
ALTER TABLE sites ADD COLUMN kind TEXT NOT NULL DEFAULT 'site';
-- Who it's for: the other person's @username when their OVOAs are connected
-- (the finished link is shared to their OVOA), and their name either way.
ALTER TABLE sites ADD COLUMN share_to TEXT;
ALTER TABLE sites ADD COLUMN share_for TEXT;
-- When the finished game was handed to the other side (so it's done once).
ALTER TABLE sites ADD COLUMN shared_at INTEGER;

-- Something they're planning: a trip, an event, a move. OVOA asks one
-- specific question about it on followup_on (plans_life.ts plansTick).
CREATE TABLE life_plans (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  -- trip, event, other.
  kind            TEXT NOT NULL DEFAULT 'trip',
  place           TEXT,
  starts_on       TEXT,
  ends_on         TEXT,
  detail          TEXT,
  -- The one follow-up: its day (their time) and its question, written when the plan was.
  followup_on     TEXT,
  followup_text   TEXT,
  followed_up_at  INTEGER,
  -- active, done, cancelled.
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX life_plans_user ON life_plans (user_id, status);
CREATE INDEX life_plans_due ON life_plans (status, followup_on);

-- A spending budget they set by text: an amount a period (or once), for a
-- category, with a cap on any one purchase. Nothing here can pay for anything.
CREATE TABLE spend_budgets (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category           TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  -- week, month, once.
  period             TEXT NOT NULL DEFAULT 'month',
  per_purchase_cents INTEGER,
  currency           TEXT NOT NULL DEFAULT 'USD',
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX spend_budgets_user ON spend_budgets (user_id, active);

-- A purchase OVOA prepared: proposed ("Book this for $X? Reply YES"), then
-- approved (counted against the budget; they complete it at the link) or declined.
CREATE TABLE purchases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id   TEXT REFERENCES spend_budgets(id) ON DELETE SET NULL,
  what        TEXT NOT NULL,
  merchant    TEXT,
  url         TEXT,
  price_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  -- proposed, approved, declined, expired.
  status      TEXT NOT NULL DEFAULT 'proposed',
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);
CREATE INDEX purchases_user ON purchases (user_id, status, created_at);

-- Ideas OVOA offered on its own (a game for two), so each is offered rarely.
CREATE TABLE ovoa_suggestions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
