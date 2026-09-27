-- The "Made with OVOA" gallery on ovoa.ai/websites (2026-09-27, sites.ts
-- site_manage showcase / unshowcase, GET /sites/showcase): when the owner asked
-- for the site to be shown there. NULL: not shown. Only ever set because they
-- asked; deleting the site clears it.
ALTER TABLE sites ADD COLUMN showcased_at INTEGER;
