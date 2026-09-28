-- Numbers that have had the texting trial (guest.ts). Kept after their
-- text_guests row (and its chat) is deleted for age, so a number gets the
-- free texts once, ever.
CREATE TABLE text_trial_numbers (
  phone       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
INSERT OR IGNORE INTO text_trial_numbers (phone, created_at) SELECT phone, created_at FROM text_guests;
