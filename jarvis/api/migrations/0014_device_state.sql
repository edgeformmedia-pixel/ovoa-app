-- What the phone has, as it last told us.
--
-- Every feature from here on is meant to work on its own and get better with
-- more: a reminder buzzes the band when there is one and is an ordinary
-- notification when there isn't. The server can't see the band, the Health
-- permissions or the location setting, so the app reports them here and
-- capabilities.ts reads them back. One row per user — the phone they used last.

CREATE TABLE device_state (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The app's own linked flag, not the vendor SDK's status (which says
  -- "connected" by default).
  band_linked   INTEGER NOT NULL DEFAULT 0,
  -- Refreshed every few minutes while linked. A linked flag that stopped being
  -- refreshed means the app was killed, and a buzz would go nowhere.
  band_seen_at  INTEGER,
  -- granted / denied / undetermined
  notifications TEXT,
  health        INTEGER NOT NULL DEFAULT 0,
  -- A heart-rate source (a watch) has written to Health recently.
  watch_hr      INTEGER NOT NULL DEFAULT 0,
  -- none / when_in_use / always
  location      TEXT,
  -- Which of the clip's three vibrations actually reaches the wrist.
  buzz_option   INTEGER,
  app_build     TEXT,
  updated_at    INTEGER NOT NULL
);

-- The [AL] experiments (docs/feature-plan.md F13-F15): store everything that is
-- heard, not only what the user chose to record. Ruled out for the product on
-- 2026-09-20 on legal grounds, so this can only be switched on for the accounts
-- listed in the DEV_EMAILS var, and is refused for everyone else in code.
ALTER TABLE settings ADD COLUMN capture_everything INTEGER NOT NULL DEFAULT 0;
