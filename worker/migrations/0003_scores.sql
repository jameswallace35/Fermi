-- Server-computed daily score (average times-off) for finished puzzles, used by the leaderboards.
ALTER TABLE puzzles ADD COLUMN score REAL;
CREATE INDEX IF NOT EXISTS puzzles_n_score ON puzzles(n, score);
