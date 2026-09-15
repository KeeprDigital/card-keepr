// Named fixed SQL; migration tests own values, execution and transactions.
export function scryfallRegistration(database) {
  return database.prepare("SELECT * FROM source_adapter_versions WHERE adapter_version='scryfall-magic-en@1'");
}

export function completeCollection(database) {
  return database.prepare("UPDATE ingestion_evidence_plans SET collection_completed_at=? WHERE ingestion_run_id=?");
}

export function removeReservation(database) {
  return database.prepare("DELETE FROM ingestion_collection_reservations WHERE ingestion_run_id=?");
}

export function removeCurrent(database) {
  return database.prepare("DELETE FROM ingestion_run_current WHERE ingestion_run_id=?");
}

export function disagreeingCurrent(database) {
  return database.prepare("UPDATE ingestion_run_current SET state=? WHERE ingestion_run_id=?");
}

export function unrecordedCurrent(database) {
  return database.prepare(`INSERT INTO ingestion_run_current
    (ingestion_run_id,last_event_sequence,last_event_id,state,completed_stage_count)
    VALUES (:ingestion_run_id,:last_event_sequence,:last_event_id,:state,:completed_stage_count)`);
}

export function retainClassification(database) {
  return database.prepare(`INSERT INTO catalogue_recovery_collection_classifications
    (recovery_id,ingestion_run_id,prior_state,classification) VALUES (?,?,?,?)`);
}

export function retainAuthorityDecision(database) {
  return database.prepare(`INSERT INTO source_authority_decisions
    (idempotency_key,game,locale,release_region,area,source_lineage,generation,rationale,request_json,decided_at)
    VALUES (:idempotency_key,:game,:locale,:release_region,:area,:source_lineage,:generation,:rationale,:request_json,:decided_at)`);
}

export function stalePredecessor(database) {
  return database.prepare("UPDATE catalogue_schema_state SET migration_level=? WHERE singleton=1");
}

export function prepareHandoff(database) {
  return database.prepare(`INSERT INTO administration_idempotency
    (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at)
    VALUES (:idempotency_key,:operation,:request_json,:response_json,:http_status,:outcome,:created_at)`);
}

export function reserveHandoff(database) {
  return database.prepare(`UPDATE operation_state SET active_production_release_id=?,
    active_production_release_expires_at=? WHERE singleton=1`);
}

export function claimHandoff(database) {
  return database.prepare(`INSERT INTO fresh_baseline_handoffs
    (release_id,role,dispatch_digest,execution_id,request_json,preparation_json,phase,evidence_json,created_at)
    VALUES (:release_id,:role,:dispatch_digest,:execution_id,:request_json,:preparation_json,:phase,:evidence_json,:created_at)`);
}
