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

export function retainedParseIds(database) {
  return database.prepare("SELECT parse_operation_id FROM source_parse_contexts");
}

export function insertParseContext(database) {
  return database.prepare("INSERT INTO source_parse_contexts VALUES (?)");
}

export function retainedKeywordSuffixValues(database) {
  return database.prepare("SELECT long_prefix_BEGIN, éCASE, long_prefix_END FROM keyword_suffix_values");
}

export function retainedWithdrawalAssertionIds(database) {
  return database.prepare(
    "SELECT source_observation_id FROM reconciled_withdrawal_assertions ORDER BY source_observation_id",
  );
}

export function insertWithdrawalAssertion(database) {
  return database.prepare("INSERT INTO reconciled_withdrawal_assertions VALUES (?, ?, ?)");
}
