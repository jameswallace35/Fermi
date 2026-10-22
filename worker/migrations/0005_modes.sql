-- Unlimited and timed modes, plus player suggestions for the game's owner.
-- A run is one timed session; plays are individual answers in either mode.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  answered INTEGER NOT NULL DEFAULT 0,
  ballpark INTEGER NOT NULL DEFAULT 0,
  sum_multiple REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, mode);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  guess REAL NOT NULL,
  multiple REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_user ON plays(user_id, mode);
CREATE INDEX IF NOT EXISTS plays_run ON plays(run_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  player_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
