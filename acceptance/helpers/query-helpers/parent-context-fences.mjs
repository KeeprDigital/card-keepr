import { createHash } from "node:crypto";

// Populated storage fixture for writer fences, not source parsing/qualification.
export function seedParentContextFenceRows(database, run) {
  const digest = createHash("sha256").update("{}").digest("hex");
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    const id = `${run}-${ordinal}`,
      parent = ordinal === 0 ? null : `${run}-0`;
    const url = `https://source.invalid/fence/${ordinal}`;
    database
      .prepare(
        `INSERT INTO source_requests
      (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state,request_role,discovered_from_request_id)
      VALUES (?,?,?,'GET',?,'{}','fixture','captured','listing',?)`,
      )
      .run(run, id, ordinal, url, parent);
    database
      .prepare(
        `INSERT INTO source_fetch_attempts
      (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
      VALUES (?,?,?,1,'2026-09-15T00:00:00.000Z','2026-09-15T00:00:00.000Z','success','{}')`,
      )
      .run(id, run, id);
    database
      .prepare(
        `INSERT INTO source_snapshots
      (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
      VALUES (?,?,?,?,'GET',?,'{}','fixture','[]','2026-09-15T00:00:00.000Z',200,'{}','application/json',?,2,?,'tcgdex-pokemon-en','pokemon','pokemon@1','tcgdex-pokemon-en@1')`,
      )
      .run(id, run, id, id, url, digest, `source-snapshots/${id}`);
    database
      .prepare("UPDATE source_requests SET source_snapshot_id=? WHERE ingestion_run_id=? AND request_id=?")
      .run(id, run, id);
    database
      .prepare(
        `INSERT INTO source_parse_operations
      (id,source_snapshot_id,adapter_version,intent,idempotency_key,observation_set_id,content_object_key,parsed_at,state)
      VALUES (?,?,'tcgdex-pokemon-en@1','collection',?,?,?,'2026-09-15T00:00:00.000Z','planned')`,
      )
      .run(id, id, id, `${id}-obs`, `source-observations/${id}`);
    if (parent) database.prepare("INSERT INTO source_parse_dependencies VALUES (?,0,?)").run(id, parent);
    database.prepare("INSERT INTO source_parse_contexts VALUES (?,?,1024)").run(id, ordinal);
    database
      .prepare(
        `INSERT INTO source_observation_sets
      (id,parse_operation_id,source_snapshot_id,source_lineage,supported_game,game_profile_version,adapter_version,parsed_at,content_digest,content_byte_length,content_object_key,observation_count)
      VALUES (?,?,?,'tcgdex-pokemon-en','pokemon','pokemon@1','tcgdex-pokemon-en@1','2026-09-15T00:00:00.000Z',?,2,?,0)`,
      )
      .run(`${id}-obs`, id, id, digest, `source-observations/${id}`);
    database
      .prepare(
        "INSERT INTO source_record_progress (observation_set_id,next_ordinal,digest,header_json,sealed,requests_complete) VALUES (?,0,?,'{}',1,1)",
      )
      .run(`${id}-obs`, digest);
    database
      .prepare(
        "UPDATE source_parse_operations SET state='finalized',content_digest=?,content_byte_length=2,observation_count=0 WHERE id=?",
      )
      .run(digest, id);
    database
      .prepare("UPDATE source_requests SET state='observed' WHERE ingestion_run_id=? AND request_id=?")
      .run(run, id);
  }
}

export function parentContextFenceRows(database) {
  return {
    contexts: database.prepare("SELECT * FROM source_parse_contexts ORDER BY parse_operation_id").all(),
    dependencies: database.prepare("SELECT * FROM source_parse_dependencies ORDER BY parse_operation_id,ordinal").all(),
  };
}

export function parentContextLateWrites(database, run) {
  const mutations = [
    ["INSERT INTO source_parse_contexts VALUES (?,0,1024)", `${run}-0`],
    [
      "UPDATE source_parse_contexts SET maximum_context_bytes=maximum_context_bytes WHERE parse_operation_id=?",
      `${run}-1`,
    ],
    ["DELETE FROM source_parse_contexts WHERE parse_operation_id=?", `${run}-1`],
    ["INSERT INTO source_parse_dependencies VALUES (?,1,?)", `${run}-1`, `${run}-0`],
    ["UPDATE source_parse_dependencies SET ordinal=ordinal WHERE parse_operation_id=?", `${run}-1`],
    ["DELETE FROM source_parse_dependencies WHERE parse_operation_id=?", `${run}-1`],
  ];
  return mutations.map(([sql, ...values]) => ({ run: () => database.prepare(sql).run(...values) }));
}

export function seedParentRecoveryClassificationOperation(database, recoveryId) {
  // Only the classifier's owning journal identity is supplied here. No fake
  // verified backup, accepted recovery or source-qualification result is seeded.
  database
    .prepare(
      `INSERT INTO catalogue_backup_attempts
    (idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,started_at)
    VALUES (?,'{}',?,'catrev_spine_000','pending',?,'2026-09-15T00:00:00.000Z')`,
    )
    .run(recoveryId, recoveryId, `backups/${recoveryId}`);
  database
    .prepare(
      `INSERT INTO catalogue_recovery_operations
    (id,state,method,request_json,idempotency_key,target_revision_id,target_bookmark,target_digest,source_backup_attempt_id,expected_current_revision_id,original_database_id,expected_schema_migration_level,expected_verification_json,started_at)
    VALUES (?,'validating','replacement_database','{}',?,'catrev_spine_000','fixture-bookmark',?,?,'catrev_spine_000','fixture-source',
      (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1),'{}','2026-09-15T00:00:00.000Z')`,
    )
    .run(recoveryId, recoveryId, "a".repeat(64), recoveryId);
}

export function parentRecoveryClassifications(database, recoveryId) {
  return database
    .prepare(
      "SELECT ingestion_run_id,classification FROM catalogue_recovery_collection_classifications WHERE recovery_id=? ORDER BY ingestion_run_id",
    )
    .all(recoveryId);
}
