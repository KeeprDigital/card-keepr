// Fixed retained metadata exercises every inbound adapter foreign key during
// the capacity-table rebuild. It does not stand in for capture or publication.
export function seedRetainedSourceHistory(database) {
  return [
    `INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key)
      VALUES ('capacity-migration','2026-09-15T00:00:00.000Z','catrev_spine_000','capacity-migration')`,
    `INSERT INTO ingestion_evidence_plans(ingestion_run_id,source_lineage,supported_game,
      game_profile_version,adapter_version,request_plan_json)
      VALUES ('capacity-migration','one-piece-en','one-piece','one-piece@1','one-piece-en@6','{}')`,
    `INSERT INTO source_requests(ingestion_run_id,request_id,sequence_number,method,url,
      request_headers_json,representation_fingerprint,state)
      VALUES ('capacity-migration','root',0,'GET','https://official-source.invalid/cards','{}','fingerprint','observed')`,
    `INSERT INTO source_fetch_attempts(id,ingestion_run_id,request_id,attempt_number,requested_at,
      completed_at,outcome,http_status,response_headers_json)
      VALUES ('capacity-fetch','capacity-migration','root',1,'2026-09-15','2026-09-15','success',200,'{}')`,
    `INSERT INTO source_snapshots(id,ingestion_run_id,request_id,fetch_attempt_id,request_method,
      request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,
      http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,
      source_lineage,supported_game,game_profile_version,adapter_version)
      VALUES ('capacity-snapshot','capacity-migration','root','capacity-fetch','GET',
      'https://official-source.invalid/cards','{}','fingerprint','[]','2026-09-15',200,'{}',
      'application/json','digest',2,'capacity-raw','one-piece-en','one-piece','one-piece@1','one-piece-en@6')`,
    `INSERT INTO source_parse_operations(id,source_snapshot_id,adapter_version,intent,idempotency_key,
      observation_set_id,content_object_key,parsed_at,state,content_digest,content_byte_length,observation_count)
      VALUES ('capacity-parse','capacity-snapshot','one-piece-en@6','collection','capacity-parse',
      'capacity-observation','capacity-observation-object','2026-09-15','finalized','digest',2,1)`,
    `INSERT INTO source_observation_sets(id,parse_operation_id,source_snapshot_id,source_lineage,
      supported_game,game_profile_version,adapter_version,parsed_at,content_digest,content_byte_length,
      content_object_key,observation_count)
      VALUES ('capacity-observation','capacity-parse','capacity-snapshot','one-piece-en','one-piece',
      'one-piece@1','one-piece-en@6','2026-09-15','digest',2,'capacity-observation-object',1)`,
  ].map((sql) => database.prepare(sql));
}

export function insertCapacityExtension(database) {
  return database.prepare(`INSERT INTO ingestion_run_capacity_extensions(ingestion_run_id,
    capacity_generation,previous_request_capacity,request_capacity,source_lineage,extended_at,
    idempotency_key,request_digest,response_json)
    VALUES ('capacity-migration',?,10000,?,'one-piece-en','2026-09-15',?,?,'{}')`);
}

export function insertAdapter(database) {
  return database.prepare(`INSERT INTO source_adapter_versions(adapter_version,source_lineage,
    supported_game,game_profile_version,parser_contract,request_capacity)
    VALUES (?,'one-piece-en','one-piece','one-piece@1','migration-probe',?)`);
}

export function mutateRetainedAdapter(database) {
  return database.prepare(
    "UPDATE source_adapter_versions SET request_capacity=12000 WHERE adapter_version='one-piece-en@6'",
  );
}

export function mutateRetainedExtension(database) {
  return database.prepare(
    "UPDATE ingestion_run_capacity_extensions SET request_capacity=22000 WHERE capacity_generation=2",
  );
}

export function deleteRetainedExtension(database) {
  return database.prepare("DELETE FROM ingestion_run_capacity_extensions WHERE capacity_generation=2");
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
