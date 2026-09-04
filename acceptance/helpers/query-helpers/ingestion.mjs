// Named SQLite statements; tests retain bindings, execution, and assertions.

export function insertTransitionMatrixRun(database) {
  return database.prepare(`INSERT INTO ingestion_runs (
    id, state, failure_code, candidate_digest, candidate_catalogue_digest,
    candidate_created_at, approval_deadline, expected_current_revision_id, approval_json
  ) VALUES ('run', ?, NULL, 'candidate', 'catalogue',
    '2026-09-04T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'revision',
    '{"candidate_digest":"candidate","expected_current_revision_id":"revision","approved_at":"2026-09-05T00:00:00.000Z"}')`);
}

export function updateTransitionMatrixRun(database) {
  return database.prepare("UPDATE ingestion_runs SET state = ?, failure_code = ? WHERE id = 'run' AND state = ?");
}

export function transitionMatrixRunState(database) {
  return database.prepare("SELECT state FROM ingestion_runs WHERE id = 'run'");
}
