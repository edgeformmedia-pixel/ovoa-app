-- Plans: which of free, base and pro each person is on (src/plans.ts).
--
-- The site (ovoa.ai) owns memberships and answers "what tier is this email?"
-- (docs/paywall/SPEC.md §2). The app server asks it, and keeps the last good
-- answer here so that it asks at most once every ten minutes per person, and
-- so that a paying person keeps what they paid for when the site has a blip:
-- the last good answer stands for 24 hours before the server falls back to free.
--
--   plan_tier           'free' | 'base' | 'pro' as the site last said it; NULL = never asked
--   plan_status         'trialing' | 'active' | 'past_due' | 'canceled' | 'comp' | 'none'
--   plan_checked_at     ms, when the site last ANSWERED (a failed ask leaves it alone)
--   plan_trial_ends_at  ISO date from the site, or NULL
--   plan_renews_at      ISO date from the site, or NULL
--   plan_override       'free' | 'base' | 'pro', set with the debug key for the
--                       developer, App Review and testers; beats the site. NULL = none.
ALTER TABLE users ADD COLUMN plan_tier TEXT;
ALTER TABLE users ADD COLUMN plan_status TEXT;
ALTER TABLE users ADD COLUMN plan_checked_at INTEGER;
ALTER TABLE users ADD COLUMN plan_trial_ends_at TEXT;
ALTER TABLE users ADD COLUMN plan_renews_at TEXT;
ALTER TABLE users ADD COLUMN plan_override TEXT;

-- Where a note's words came from. Free notes are transcribed on the iPhone
-- (docs/paywall/05), so the server only ever sees their text: 'on_device'.
-- 'typed' is everything before this column existed and anything typed.
ALTER TABLE notes ADD COLUMN source TEXT NOT NULL DEFAULT 'typed';
