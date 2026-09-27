-- Shared lists with Friends (lists.ts, 2026-09-27): "share my grocery list with
-- Maria". The owner keeps the list (user_lists); a share lets one Friend's OVOA
-- read it, add rows and tick them, for as long as the owner's access for that
-- Friend allows it (share_lists below) and they stay connected. Unsharing,
-- deleting the list or either account going removes the share.
CREATE TABLE list_shares (
  owner_id   TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 1: the owner asked to be told when this Friend adds to it.
  tell_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, name, friend_id),
  FOREIGN KEY (owner_id, name) REFERENCES user_lists(user_id, name) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX list_shares_friend ON list_shares(friend_id);

-- A Friend's OVOA may read and add to the lists shared with them. On for Best
-- friend, Partner and Full access; Basic can have it as its own switch
-- (Advanced). Connections already at one of those presets get it, so their
-- level still reads the same.
ALTER TABLE connection_perms ADD COLUMN share_lists INTEGER NOT NULL DEFAULT 0;
UPDATE connection_perms SET share_lists = 1
 WHERE share_free_busy = 1 AND take_reminders = 1 AND auto_accept_meetings = 1 AND auto_answer_questions = 1
   AND ((calendar_details = 0 AND share_location = 0 AND answer_from_memory = 0)
     OR (calendar_details = 1 AND share_location = 1));
