-- Which partner a Text OVOA trial came from. The site's Text OVOA buttons end
-- the first hello with the visitor's ?ref= code ("Hi OVOA! #maya"); texting.ts
-- reads it off that first text (the words themselves are wiped once answered)
-- and guest.ts trialAccount keeps it here. It stays when the trial becomes a
-- real account, so trials and paid accounts can be counted per code:
--   SELECT signup_ref, COUNT(*) trials FROM users WHERE signup_ref IS NOT NULL GROUP BY 1;
ALTER TABLE users ADD COLUMN signup_ref TEXT;
CREATE INDEX users_signup_ref ON users (signup_ref);
