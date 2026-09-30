-- The photos a website shows (src/sites.ts hostPhotos): the owner's own, texted
-- to OVOA, copied here at build time, made web-sized (a phone's photo is 3-8 MB,
-- sometimes HEIC), and served at <PUBLIC_URL>/site-photos/<id>.jpg rather than
-- from Sendblue's store. They go with the site.
CREATE TABLE site_photos (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  type        TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_site_photos_source ON site_photos(site_id, source);
