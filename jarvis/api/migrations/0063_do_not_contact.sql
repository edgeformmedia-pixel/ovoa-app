-- Numbers that asked OVOA to stop (keywords.ts): anyone who texts STOP to
-- OVOA's line. OVOA never texts them first (reach.ts) and no campaign reaches
-- them. They can still text OVOA and get answers; START takes them off.
CREATE TABLE do_not_contact (
  phone      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
