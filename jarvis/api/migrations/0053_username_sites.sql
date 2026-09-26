-- Websites at <username>.ovoa.ai/<project> (2026-09-26, docs/sites.md): a
-- username's address is a page listing its projects, and each project is a
-- site under it. The flat sites from before (tonys-pizza.ovoa.ai) keep path
-- NULL and their addresses.
--
-- A project's slug is "<username>/<project>", so slug stays the one unique
-- name of a site and says where it lives (sites.ts siteAddress). A username
-- change rewrites these (usernames.ts rename), and the old address answers 301
-- for 90 days.
ALTER TABLE sites ADD COLUMN owner_username TEXT;
ALTER TABLE sites ADD COLUMN path TEXT;
CREATE UNIQUE INDEX sites_project ON sites (owner_username, path) WHERE path IS NOT NULL;
