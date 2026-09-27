-- How many AI replies free-trial guests (guest.ts) got across all numbers, per
-- UTC day. Per-number limits stop one person; this stops the trial as a whole
-- from running up an unbounded bill (guest calls have no account, so the model
-- gate's plan and spend checks don't see them). Counts only, no numbers or words.
CREATE TABLE guest_daily (
  day     TEXT PRIMARY KEY,
  replies INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
