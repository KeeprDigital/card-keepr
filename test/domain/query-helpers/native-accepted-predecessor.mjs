export function seedPinnedNativeEvidence(db) {
  db.exec(`CREATE TABLE reconciliation_operations(id TEXT PRIMARY KEY,supported_game TEXT);
    CREATE TABLE game_candidates(id TEXT PRIMARY KEY,preparation_id TEXT,partition_count INTEGER,
      supported_game TEXT,expected_game_revision_id TEXT);
    CREATE TABLE game_candidate_predecessors(candidate_id TEXT PRIMARY KEY,predecessor_candidate_id TEXT);
    CREATE TABLE catalogue_composition_games(catalogue_revision_id TEXT,supported_game TEXT,candidate_id TEXT);
    INSERT INTO game_candidates VALUES('public','public',1,'one-piece','spine'),
      ('accepted','accepted',2,'one-piece','revision'),('proposed','proposed',3,'one-piece','revision'),
      ('later','later',4,'one-piece','revision');
    INSERT INTO catalogue_composition_games VALUES('revision','one-piece','public');
    INSERT INTO game_candidate_predecessors VALUES('proposed','accepted'),('later','proposed');
    INSERT INTO reconciliation_operations VALUES('historical-run',NULL);`);
}
