-- Money: enough of a picture to answer "can I get these?" in a shop.
--
-- Not accounting. Nothing here tries to be a ledger or to reconcile to the
-- penny, because a ledger needs a bank connection and a bank connection needs
-- a signup the user hasn't done. What it needs instead is the handful of facts
-- a friend who knew your situation would have in their head: roughly what's in
-- the account, when you next get paid and how much, what's due before then,
-- and what you've already said you want to do this week.
--
-- Everything is in cents, as integers, because floating point money is a bug
-- waiting for a quiet afternoon. Dates that belong to the user's calendar
-- (a payday, a due date) are local YYYY-MM-DD; moments are epoch milliseconds.

-- How close to zero they're willing to run, and what the numbers are in.
CREATE TABLE money_settings (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency     TEXT NOT NULL DEFAULT 'USD',
  -- The cushion. Money above this is spendable; money below it is the thing
  -- that stops a card being declined at the wrong moment.
  buffer_cents INTEGER NOT NULL DEFAULT 10000,
  updated_at   INTEGER NOT NULL
);

-- A balance the user told us, with when they told us. The age matters as much
-- as the number: a week-old balance is a guess, and OVOA should say so rather
-- than do confident arithmetic on it.
CREATE TABLE money_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- checking / savings / cash / credit. Only checking and cash are counted as
  -- spendable; savings is named but held back, and credit isn't money.
  kind          TEXT NOT NULL DEFAULT 'checking',
  balance_cents INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX money_accounts_user ON money_accounts (user_id);

-- The shape of a paycheck: how often and, if they know it, how much.
CREATE TABLE money_income (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'Pay',
  -- Net, what lands. Null when it varies: then the average of real paychecks
  -- is used instead, which is the honest number for shift and gig work.
  amount_cents INTEGER,
  -- weekly / biweekly / semimonthly / monthly
  cadence      TEXT NOT NULL,
  -- A local date a payday actually fell on. Every future payday is counted from it.
  anchor       TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX money_income_user ON money_income (user_id, active);

-- Paychecks as they actually landed. This is what makes "you got paid ten
-- percent less than your three-month average" a fact rather than a feeling.
CREATE TABLE money_paychecks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  income_id    TEXT,
  date         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX money_paychecks_user ON money_paychecks (user_id, date);

-- What's owed and when. `next_due` is the authoritative date and is rolled
-- forward as each one passes, so a bill that was never marked paid doesn't sit
-- in the past forever making every answer wrong.
CREATE TABLE money_bills (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- Null when it varies (a utility bill). The last amount paid is used as the guess.
  amount_cents INTEGER,
  -- monthly / weekly / biweekly / yearly / once
  cadence      TEXT NOT NULL DEFAULT 'monthly',
  next_due     TEXT NOT NULL,
  -- Autopay still comes out of the account; the flag only changes the wording.
  autopay      INTEGER NOT NULL DEFAULT 0,
  -- user / mail. Bills found in mail (extras.ts) land here too, so the
  -- affordability answer knows about them without being told twice.
  source       TEXT NOT NULL DEFAULT 'user',
  active       INTEGER NOT NULL DEFAULT 1,
  last_paid    TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX money_bills_user ON money_bills (user_id, active, next_due);

-- Money that went out, as they mentioned it. Never complete, and not meant to
-- be: it's used only for a rough daily rate, so the days before payday aren't
-- assumed to cost nothing.
CREATE TABLE money_spend (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  what         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX money_spend_user ON money_spend (user_id, ts);

-- Things they've said they're going to do and roughly what it'll cost: the
-- date on Saturday, the tank of gas. This is the whole point of the feature —
-- without it "you can't afford that" is a scold, and with it OVOA can name
-- what the purchase would actually cost them and let them choose.
CREATE TABLE money_plans (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  on_date      TEXT,
  -- planned / done / dropped
  status       TEXT NOT NULL DEFAULT 'planned',
  created_at   INTEGER NOT NULL
);
CREATE INDEX money_plans_user ON money_plans (user_id, status);
