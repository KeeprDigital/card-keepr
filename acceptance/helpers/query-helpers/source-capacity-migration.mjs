// Named fixed SQL; tests supply fixture values and own execution.
export function insertIngestionRun(database) {
  return database.prepare(`INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key)
    VALUES (:id,:started_at,:expected_current_revision_id,:idempotency_key)`);
}

export function insertEvidencePlan(database) {
  return database.prepare(`INSERT INTO ingestion_evidence_plans(ingestion_run_id,source_lineage,supported_game,
    game_profile_version,adapter_version,request_plan_json)
    VALUES (:ingestion_run_id,:source_lineage,:supported_game,:game_profile_version,:adapter_version,:request_plan_json)`);
}

export function insertSourceRequest(database) {
  return database.prepare(`INSERT INTO source_requests(ingestion_run_id,request_id,sequence_number,method,url,
    request_headers_json,representation_fingerprint,state)
    VALUES (:ingestion_run_id,:request_id,:sequence_number,:method,:url,:request_headers_json,:representation_fingerprint,:state)`);
}

export function insertFetchAttempt(database) {
  return database.prepare(`INSERT INTO source_fetch_attempts(id,ingestion_run_id,request_id,attempt_number,requested_at,
    completed_at,outcome,http_status,response_headers_json)
    VALUES (:id,:ingestion_run_id,:request_id,:attempt_number,:requested_at,:completed_at,:outcome,:http_status,:response_headers_json)`);
}

export function insertSourceSnapshot(database) {
  return database.prepare(`INSERT INTO source_snapshots(id,ingestion_run_id,request_id,fetch_attempt_id,request_method,
    request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,
    http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,
    source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (:id,:ingestion_run_id,:request_id,:fetch_attempt_id,:request_method,:request_url,:request_headers_json,
    :representation_fingerprint,:response_vary_json,:retrieved_at,:http_status,:response_headers_json,:media_type,
    :content_digest,:content_byte_length,:content_object_key,:source_lineage,:supported_game,:game_profile_version,:adapter_version)`);
}

export function insertParseOperation(database) {
  return database.prepare(`INSERT INTO source_parse_operations(id,source_snapshot_id,adapter_version,intent,idempotency_key,
    observation_set_id,content_object_key,parsed_at,state,content_digest,content_byte_length,observation_count)
    VALUES (:id,:source_snapshot_id,:adapter_version,:intent,:idempotency_key,:observation_set_id,:content_object_key,
    :parsed_at,:state,:content_digest,:content_byte_length,:observation_count)`);
}

export function insertObservationSet(database) {
  return database.prepare(`INSERT INTO source_observation_sets(id,parse_operation_id,source_snapshot_id,source_lineage,
    supported_game,game_profile_version,adapter_version,parsed_at,content_digest,content_byte_length,
    content_object_key,observation_count)
    VALUES (:id,:parse_operation_id,:source_snapshot_id,:source_lineage,:supported_game,:game_profile_version,
    :adapter_version,:parsed_at,:content_digest,:content_byte_length,:content_object_key,:observation_count)`);
}

export function insertCapacityExtension(database) {
  return database.prepare(`INSERT INTO ingestion_run_capacity_extensions(ingestion_run_id,
    capacity_generation,previous_request_capacity,request_capacity,source_lineage,extended_at,
    idempotency_key,request_digest,response_json)
    VALUES (:ingestion_run_id,:capacity_generation,:previous_request_capacity,:request_capacity,:source_lineage,
    :extended_at,:idempotency_key,:request_digest,:response_json)`);
}

export function insertAdapter(database) {
  return database.prepare(`INSERT INTO source_adapter_versions(adapter_version,source_lineage,
    supported_game,game_profile_version,parser_contract,request_capacity)
    VALUES (:adapter_version,:source_lineage,:supported_game,:game_profile_version,:parser_contract,:request_capacity)`);
}

export function mutateRetainedAdapter(database) {
  return database.prepare("UPDATE source_adapter_versions SET request_capacity=? WHERE adapter_version=?");
}

export function mutateRetainedExtension(database) {
  return database.prepare(
    "UPDATE ingestion_run_capacity_extensions SET request_capacity=? WHERE capacity_generation=?",
  );
}

export function deleteRetainedExtension(database) {
  return database.prepare("DELETE FROM ingestion_run_capacity_extensions WHERE capacity_generation=?");
}

export function recoveryFence(database) {
  return database.prepare("UPDATE operation_state SET recovery_restore_guard=? WHERE singleton=1");
}

export function inboundForeignKeys(database) {
  return database.prepare(`SELECT m.name,f.id,f.seq,f."table",f."from",f."to",f.on_delete
    FROM sqlite_schema m,pragma_foreign_key_list(m.name) f
    WHERE m.type='table' AND f."table" IN ('source_adapter_versions','ingestion_run_capacity_extensions')
    ORDER BY m.name,f.id,f.seq`);
}
