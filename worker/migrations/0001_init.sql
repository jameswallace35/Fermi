-- Fermi accounts: users, sessions, saved puzzles and a small rate-limit table.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS puzzles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, n)
);

CREATE TABLE IF NOT EXISTS attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
