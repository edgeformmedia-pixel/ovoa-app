-- The AI-led setup (src/setup/, 2026-09-23): the conversation's state, kept
-- between turns on the profile row it sets up.
--
-- setup_state: one JSON blob (src/setup/state.ts SetupState): what each
--   objective holds, what the last reply asked, the last lines said. Written
--   only by src/setup/ (turn.ts, state.ts), compare-and-swap on setup_rev. The
--   lines are cleared at finish; the whole blob goes 14 days after its last
--   change (retention.ts, sweepStaleSetup).
-- setup_rev: moved on by every save of setup_state. A save that finds it moved
--   reloads and merges again, so two racing turns both land.
-- setup_apps: the apps being made for their goals, a JSON object keyed by goal.
--   Written only by the background app job (src/setup/turn.ts makeApp), one key
--   per statement with json_insert/json_set, so a save of setup_state never
--   overwrites a result. Cleared on restart, and with setup_state by the sweep.
ALTER TABLE profile ADD COLUMN setup_state TEXT;
ALTER TABLE profile ADD COLUMN setup_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profile ADD COLUMN setup_apps TEXT;
