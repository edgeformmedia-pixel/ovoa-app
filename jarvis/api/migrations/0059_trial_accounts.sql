-- A hidden account for each number on the texting trial (guest.ts), so a
-- trial texter gets the whole OVOA (tools, websites, reminders) by text. It
-- has no password and an address that can't receive mail; linking the number
-- to a real account moves what it made there and deletes it.
ALTER TABLE users ADD COLUMN trial_phone TEXT;
CREATE UNIQUE INDEX users_trial_phone ON users (trial_phone);
