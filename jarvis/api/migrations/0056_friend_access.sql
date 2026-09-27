-- Friends and what each may reach (2026-09-27, network.ts ACCESS_LEVELS,
-- docs/ovoa-network.md): the Friends tab gives each connection a level (Basic,
-- Best friend, Partner, Full access) that sets these, and Advanced sets them
-- one at a time. The level itself isn't kept: it's whichever preset the
-- switches match, or Custom.

-- An automatic answer may use what's in their calendar (titles, places, times), not only free/busy.
ALTER TABLE connection_perms ADD COLUMN calendar_details INTEGER NOT NULL DEFAULT 0;
-- An automatic answer may say roughly where they are (the phone's last place).
ALTER TABLE connection_perms ADD COLUMN share_location INTEGER NOT NULL DEFAULT 0;
-- Reminders and things shared from this person reach them. Off: turned away.
ALTER TABLE connection_perms ADD COLUMN take_reminders INTEGER NOT NULL DEFAULT 1;
-- An automatic answer may use what OVOA remembers about them. Full access only, and marked as dangerous.
ALTER TABLE connection_perms ADD COLUMN answer_from_memory INTEGER NOT NULL DEFAULT 0;
