-- One guess per player per question, used for the "how others guessed" stats.
-- player_key is "u:<user id>" for signed-in players or "a:<anonymous id>" for everyone else.
CREATE TABLE IF NOT EXISTS guesses (
  question_id TEXT NOT NULL,
  player_key TEXT NOT NULL,
  guess REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (question_id, player_key)
);
