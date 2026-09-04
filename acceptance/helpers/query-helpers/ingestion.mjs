// Named SQLite statements; tests retain bindings, execution, and assertions.

export function insertTransitionMatrixRun(database) {
  return database.prepare(`INSERT INTO ingestion_run_current (
    ingestion_run_id, state, failure_code, candidate_digest, candidate_catalogue_digest,
    candidate_created_at, approval_deadline, approved_candidate_digest, approved_expected_revision_id, approved_at
  ) VALUES ('run', ?, NULL, 'candidate', 'catalogue',
    '2026-09-04T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'candidate', 'revision', '2026-09-05T00:00:00.000Z')`);
}

export function updateTransitionMatrixRun(database) {
  return database.prepare(
    "UPDATE ingestion_run_current SET state = ?, failure_code = ? WHERE ingestion_run_id = 'run' AND state = ?",
  );
}

export function transitionMatrixRunState(database) {
  return database.prepare("SELECT state FROM ingestion_run_current WHERE ingestion_run_id = 'run'");
}
