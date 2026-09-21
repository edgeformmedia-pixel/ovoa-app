-- A push token that failed three times was left out of every later send, and
-- fail_count was only ever cleared by a successful send -- which could then
-- never happen. The token was buried rather than rested, and with it went the
-- agent's command channel, routine buzzes and every note it wanted to push.
--
-- Remember when a token last failed, so push.ts can try a rested one again.
ALTER TABLE push_tokens ADD COLUMN last_fail_at INTEGER;

-- And wake the ones already stuck that way.
UPDATE push_tokens SET fail_count = 0 WHERE fail_count >= 3;
