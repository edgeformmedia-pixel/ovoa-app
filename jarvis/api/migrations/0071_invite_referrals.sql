-- Invite a friend (invites.ts): a number that texted OVOA naming who sent it
-- ("@tigh sent me"), one inviter per number, and when that number linked an
-- account. Numbers that never join are dropped by the retention sweep.
CREATE TABLE invite_referrals (
  phone          TEXT PRIMARY KEY,
  inviter_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_at     INTEGER NOT NULL,
  joined_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  joined_at      INTEGER
);
CREATE INDEX invite_referrals_inviter ON invite_referrals (inviter_id);
