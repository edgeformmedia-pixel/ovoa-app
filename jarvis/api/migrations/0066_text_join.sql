-- The join link a trial number is texted when its free texts run out
-- (guest.ts joinLink): ovoa.ai/join?id=TOKEN makes an account and links the
-- number to it, no code to text. Only that number was ever sent the token.
ALTER TABLE text_guests ADD COLUMN join_token TEXT;
CREATE UNIQUE INDEX text_guests_join_token ON text_guests (join_token);
