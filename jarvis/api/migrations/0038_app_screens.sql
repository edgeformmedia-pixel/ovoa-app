-- Made apps get a screen of their own (src/myapps.ts).
--
-- `blocks` is the layout the person can rearrange: quick buttons, a checklist,
-- a counter, a log, a note, a timer. `state` is what's in them (the items on
-- the list, today's count, the log's entries), changed by taps on the phone and
-- by the assistant's app_update tool while the app is open. `speak` is whether
-- the app reads its answers aloud.
ALTER TABLE user_apps ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]';
ALTER TABLE user_apps ADD COLUMN state TEXT NOT NULL DEFAULT '{}';
ALTER TABLE user_apps ADD COLUMN speak INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_apps ADD COLUMN updated_at INTEGER;
