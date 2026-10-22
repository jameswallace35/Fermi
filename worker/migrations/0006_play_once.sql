-- A question answered twice in the same timed run counts once. Any duplicates
-- already recorded are dropped and the runs' totals recomputed from their plays.
DELETE FROM plays WHERE run_id IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM plays WHERE run_id IS NOT NULL GROUP BY run_id, question_id
);
CREATE UNIQUE INDEX IF NOT EXISTS plays_run_question ON plays(run_id, question_id) WHERE run_id IS NOT NULL;
UPDATE runs SET
  answered = (SELECT COUNT(*) FROM plays WHERE plays.run_id = runs.id),
  ballpark = (SELECT COUNT(*) FROM plays WHERE plays.run_id = runs.id AND plays.multiple <= 10),
  sum_multiple = (SELECT COALESCE(SUM(plays.multiple), 0) FROM plays WHERE plays.run_id = runs.id)
WHERE mode = 'timed';
