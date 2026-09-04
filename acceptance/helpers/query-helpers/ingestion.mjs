// Named SQLite statements; tests retain bindings, execution, and assertions.

export function insertTransitionMatrixRun(database) {
  return database.prepare("INSERT INTO ingestion_runs VALUES ('run', ?, NULL)");
}

export function updateTransitionMatrixRun(database) {
  return database.prepare("UPDATE ingestion_runs SET state = ?, failure_code = ? WHERE id = 'run'");
}

export function transitionMatrixRunState(database) {
  return database.prepare("SELECT state FROM ingestion_runs WHERE id = 'run'");
}
