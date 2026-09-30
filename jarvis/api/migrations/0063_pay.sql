-- OVOA paying for what they approve (src/pay.ts, docs/pay.md).
--
-- Their card, saved once through Stripe Checkout (setup mode): only Stripe's
-- ids and what to call it ("Visa ending 4242"). The number never reaches OVOA.
CREATE TABLE pay_cards (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  customer_id       TEXT NOT NULL,
  payment_method_id TEXT NOT NULL,
  brand             TEXT,
  last4             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- The one-time link that opens the save-a-card page. The token is the proof.
CREATE TABLE pay_setups (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- A purchase OVOA pays for itself. After their YES: a hold on their card
-- (hold_intent_id, a manual-capture PaymentIntent for hold_cents), a one-time
-- Issuing card limited to the same amount (issuing_card_id), and a browser
-- errand that checks out with it (browser_task_id). The merchant's charge on
-- that card (Stripe's issuing_transaction webhook) captures what it cost
-- (charged_cents) and closes the card.
-- pay_status: holding | authorized | paid | released | failed. NULL = not paid by OVOA.
ALTER TABLE purchases ADD COLUMN details TEXT;
ALTER TABLE purchases ADD COLUMN pay_status TEXT;
ALTER TABLE purchases ADD COLUMN hold_intent_id TEXT;
ALTER TABLE purchases ADD COLUMN hold_cents INTEGER;
ALTER TABLE purchases ADD COLUMN issuing_card_id TEXT;
ALTER TABLE purchases ADD COLUMN authorized_cents INTEGER;
ALTER TABLE purchases ADD COLUMN charged_cents INTEGER;
ALTER TABLE purchases ADD COLUMN browser_task_id TEXT;
ALTER TABLE purchases ADD COLUMN paid_at INTEGER;
CREATE INDEX purchases_card ON purchases (issuing_card_id);
CREATE INDEX purchases_paying ON purchases (pay_status, decided_at);

-- Stripe webhook events already handled, so a retry does nothing twice.
CREATE TABLE pay_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
