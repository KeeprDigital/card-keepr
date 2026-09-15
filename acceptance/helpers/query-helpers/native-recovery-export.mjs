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

export function retainedBracketValue(database) {
  return database.prepare("SELECT [END] FROM split_values");
}

// Minimal export shape from #329: a retained row precedes the guard's view.
export const laterViewGuardExport = `
  CREATE TABLE source_parse_contexts (parse_operation_id TEXT PRIMARY KEY);
  CREATE TRIGGER handoff_fence_source_parse_contexts_insert BEFORE INSERT ON source_parse_contexts
    WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
    BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
  INSERT INTO source_parse_contexts VALUES('retained-parse');
  CREATE VIEW fresh_baseline_mutation_fence AS SELECT 1 AS blocked;
`;

export function retainedParseIds(database) {
  return database.prepare("SELECT parse_operation_id FROM source_parse_contexts");
}

export function insertParseContext(database) {
  return database.prepare("INSERT INTO source_parse_contexts VALUES (?)");
}

export function retainedKeywordSuffixValues(database) {
  return database.prepare("SELECT long_prefix_BEGIN, éCASE, long_prefix_END FROM keyword_suffix_values");
}
