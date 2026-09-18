-- "Approve for me": run assistant actions without asking first.
ALTER TABLE settings ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;
