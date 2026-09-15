export function retainedRunIds(database) {
  return database.prepare("SELECT id FROM ingestion_runs");
}

export function recoveryRestoreGuard(database) {
  return database.prepare("SELECT recovery_restore_guard FROM operation_state WHERE singleton=1");
}

export function insertRun(database) {
  return database.prepare("INSERT INTO ingestion_runs VALUES (?)");
}

export function retainedIndex(database) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name=?");
}

export function retainedSplitValues(database) {
  return database.prepare("SELECT value FROM split_values ORDER BY rowid");
}
