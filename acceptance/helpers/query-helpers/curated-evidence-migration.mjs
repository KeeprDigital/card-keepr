// Fixed schema-migration fixtures; tests supply the acknowledged values.
export function finalizedCuratedParse(database) {
  return database.prepare(`INSERT INTO source_parse_operations
    (id,source_snapshot_id,adapter_version,intent,idempotency_key,observation_set_id,content_object_key,parsed_at,state,content_digest,content_byte_length,observation_count)
    VALUES (?,?,'riftbound-en@1','collection',?,?,?,'2026-08-01T00:00:00.000Z','finalized',?,1,1)`);
}
export function sealedCuratedSet(database) {
  return database.prepare(`INSERT INTO source_observation_sets
    (id,parse_operation_id,source_snapshot_id,source_lineage,supported_game,game_profile_version,adapter_version,parsed_at,content_digest,content_byte_length,content_object_key,observation_count)
    VALUES (?,?,?,'riftbound-en','riftbound','riftbound@1','riftbound-en@1','2026-08-01T00:00:00.000Z',?,1,?,1)`);
}
export function historicalCleanup(database) {
  return database.prepare(`INSERT INTO evidence_cleanup_operations
    (id,ingestion_run_id,idempotency_key,retention_days,terminal_at,eligible_at,created_at)
    VALUES (?,?,?,30,'2026-08-01T00:00:00.000Z','2026-08-31T00:00:00.000Z','2026-09-08T00:00:00.000Z')`);
}
export function historicalTombstone(database) {
  return database.prepare(`INSERT INTO evidence_cleanup_objects(object_key,cleanup_id,state,claimed_at,deleted_at)
    VALUES (?,?,?,'2026-09-08T00:00:00.000Z',?)`);
}
export function retainedCuratedKeys(database) {
  return database.prepare("SELECT object_key FROM evidence_cleanup_retained_keys ORDER BY object_key");
}
