-- The game's owner: an account that claimed the owner key can see every player's answers.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
