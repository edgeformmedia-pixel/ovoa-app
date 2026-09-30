-- When the OVOA iPhone app last spoke to the server (its x-ovoa-app header,
-- src/appSeen.ts), and which version: ovoa.ai/account shows "app installed"
-- from this instead of asking people to get the app they already have.
ALTER TABLE users ADD COLUMN app_seen_at INTEGER;
ALTER TABLE users ADD COLUMN app_version TEXT;
