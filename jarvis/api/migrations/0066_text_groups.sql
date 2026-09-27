-- iMessage groups OVOA was asked into (textgroups.ts): only the lines that
-- named OVOA and OVOA's own answers, so a follow-up has context. Nothing else
-- said in the group is kept. Swept after 14 days (retention.ts).
CREATE TABLE text_groups (
  group_id   TEXT PRIMARY KEY,
  history    TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
