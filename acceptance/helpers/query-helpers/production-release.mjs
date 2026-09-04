// Named SQLite statements; tests retain bindings, execution, and assertions.

export function countDispatchClaims(database) {
  return database.prepare(
    "SELECT COUNT(*) AS count FROM administration_idempotency WHERE operation='claim_production_release'",
  );
}

export function activeIngestionIdentity(database) {
  return database.prepare("SELECT active_ingestion_run_id FROM operation_state");
}

export function setCurrentCatalogueRevision(database) {
  return database.prepare("UPDATE catalogue_state SET current_revision_id=? WHERE singleton=1");
}

export function replacementOperationState(database) {
  return database.prepare(
    "SELECT active_ingestion_run_id,active_release_id AS active_production_release_id,recovery_health,active_recovery_id,recovery_restore_guard FROM operation_state WHERE singleton=1",
  );
}

export function recoveryStatesByStart(database) {
  return database.prepare("SELECT id,state FROM catalogue_recovery_operations ORDER BY started_at");
}

export function countVerifiedBackups(database) {
  return database.prepare("SELECT COUNT(*) AS count FROM catalogue_backup_attempts WHERE state='verified'");
}

export function release47State(database) {
  return database.prepare("SELECT state FROM production_releases WHERE id='release-47'");
}

export function release47TransitionCount(database) {
  return database.prepare("SELECT COUNT(*) AS count FROM production_release_transitions WHERE release_id='release-47'");
}

export function insertBlockedIngestionRun(database) {
  return database.prepare(
    "INSERT INTO ingestion_runs (id,state,selected_games_json,started_at,expected_current_revision_id,idempotency_key,candidate_json) VALUES ('blocked-ingestion','planning','[]','2026-08-05T00:03:00.000Z','catrev_spine_000','blocked-ingestion','{}')",
  );
}

export function recoveryHealth(database) {
  return database.prepare("SELECT recovery_health FROM operation_state WHERE singleton=1");
}

export function replacementLeaseAndRecoveryState(database) {
  return database.prepare(
    "SELECT active_release_id AS active_production_release_id,recovery_health,active_recovery_id,recovery_restore_guard FROM operation_state WHERE singleton=1",
  );
}

export function replacementRecoveryState(database) {
  return database.prepare("SELECT state FROM catalogue_recovery_operations WHERE id='recovery-replacement'");
}

export function release47ExecutionEvidence(database) {
  return database.prepare(
    "SELECT state,binding_observation_json,smoke_evidence_json FROM production_releases WHERE id='release-47'",
  );
}

export function countMigrationStartedEvidence(database) {
  return database.prepare(
    "SELECT COUNT(*) AS count FROM administration_idempotency WHERE operation='production_release_migration_started'",
  );
}

export function migrationFailureResponse(database) {
  return database.prepare(
    "SELECT response_json FROM administration_idempotency WHERE operation='production_release_migration_failed'",
  );
}

export function release47FailureState(database) {
  return database.prepare("SELECT state,roll_forward_required FROM production_releases WHERE id='release-47'");
}

export function activeOperationIdentities(database) {
  return database.prepare(
    "SELECT active_ingestion_run_id,active_release_id AS active_production_release_id FROM operation_state WHERE singleton=1",
  );
}

export function countBootstrapFenceRuns(database) {
  return database.prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE id LIKE 'release-bootstrap|%'");
}

export function setLegacyReleaseLease(database) {
  return database.prepare(`UPDATE operation_state
     SET active_release_id = ?, active_release_expires_at = ?
     WHERE singleton = 1`);
}

export function bothReleaseLeaseColumns(database) {
  return database.prepare(`SELECT active_release_id, active_release_expires_at,
              active_production_release_id,
              active_production_release_expires_at
       FROM operation_state WHERE singleton = 1`);
}

export function setProductionReleaseLease(database) {
  return database.prepare(`UPDATE operation_state
     SET active_production_release_id = ?,
         active_production_release_expires_at = ?
     WHERE singleton = 1`);
}

export function legacyReleaseLease(database) {
  return database.prepare(`SELECT active_release_id, active_release_expires_at
       FROM operation_state WHERE singleton = 1`);
}

export function productionReleaseLease(database) {
  return database.prepare(`SELECT active_production_release_id,
              active_production_release_expires_at
       FROM operation_state WHERE singleton = 1`);
}

export function activeLegacyReleaseIdentity(database) {
  return database.prepare("SELECT active_release_id FROM operation_state");
}

export function activeLegacyOperationIdentities(database) {
  return database.prepare("SELECT active_ingestion_run_id,active_release_id FROM operation_state WHERE singleton=1");
}

export function countIngestionRuns(database) {
  return database.prepare("SELECT COUNT(*) AS count FROM ingestion_runs");
}

export function legacyOperationLease(database) {
  return database.prepare(
    "SELECT active_ingestion_run_id,active_release_id,active_release_expires_at FROM operation_state WHERE singleton=1",
  );
}

export function countProductionReleases(database) {
  return database.prepare("SELECT COUNT(*) AS count FROM production_releases");
}

export function administrationOperationsInOrder(database) {
  return database.prepare("SELECT operation FROM administration_idempotency ORDER BY created_at, rowid");
}

export function activeSingletonIngestionIdentity(database) {
  return database.prepare("SELECT active_ingestion_run_id FROM operation_state WHERE singleton=1");
}

export function insertBootstrapAdministrationEvidence(database) {
  return database.prepare(
    "INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,?,?,?,201,'success','2026-09-03T00:00:00.000Z')",
  );
}

export function insertFirstIngestionRun(database) {
  return database.prepare(
    "INSERT INTO ingestion_runs (id,state,selected_games_json,started_at,expected_current_revision_id,idempotency_key,candidate_json) VALUES ('run_first','planning','[\"one-piece\"]','2026-09-03T00:00:00.000Z','catrev_spine_000','run-first','{}')",
  );
}

export function insertFirstCatalogueRevision(database) {
  return database.prepare(
    "INSERT INTO catalogue_revisions (id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest) VALUES (?,'run_first','2026-09-03T00:01:00.000Z',?,'catrev_spine_000',?)",
  );
}

export function publishFirstCatalogueRevision(database) {
  return database.prepare(
    "UPDATE catalogue_state SET current_revision_id=?,published_at='2026-09-03T00:01:00.000Z' WHERE singleton=1",
  );
}

export function insertVerifiedHandoffBackup(database) {
  return database.prepare(`INSERT INTO catalogue_backup_attempts
       (idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,d1_bookmark,
        failure_code,failure_detail,started_at,completed_at,manifest_key,content_sha256,manifest_sha256,
        export_bytes,schema_migration_level,linked_attempt_id,publication_ingestion_run_id,
        disposable_database_id,restore_generation,restore_phase)
       VALUES (?,'{}',?,?,'verified',?, ?,NULL,NULL,?,?,?, ?,?,100,?,NULL,NULL,?,1,'verified')`);
}

export function insertTimedAdministrationEvidence(database) {
  return database.prepare(
    "INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,?,?,?,201,'success',?)",
  );
}

export function insertHandoffProductionRelease(database) {
  return database.prepare(`INSERT INTO production_releases
     (id,state,request_json,idempotency_key,expected_current_revision_id,expected_head_sha,
      production_target_digest,expected_migration_level,recovery_bookmark,recovery_backup_attempt_id,
      replacement_recovery_id,replacement_database_id,retained_database_id,requested_at)
     VALUES (?,'requested',?,?,?,?,?,?,?,?,?,?,?,?)`);
}

export function advanceReleaseToPreflight(database) {
  return database.prepare("UPDATE production_releases SET state='preflight' WHERE id=?");
}

export function advanceReleaseToMigrating(database) {
  return database.prepare("UPDATE production_releases SET state='migrating' WHERE id=?");
}

export function reserveReplacementRecoveryLease(database) {
  return database.prepare(
    "UPDATE operation_state SET active_ingestion_run_id=NULL,active_release_id=?,active_release_expires_at='2026-08-05T01:00:00.000Z',recovery_health='blocked',active_recovery_id=?,recovery_restore_guard='blocked' WHERE singleton=1",
  );
}

export function insertLegacyAdministrationEvidence(database) {
  return database.prepare(
    "INSERT INTO administration_idempotency VALUES (?,?,?,?,201,'success','2026-08-05T00:00:00.000Z')",
  );
}

export function insertPreparedAdministrationEvidence(database) {
  return database.prepare(
    "INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,?,?,?,201,'success','2026-08-05T00:00:00.000Z')",
  );
}

export function insertClaimedAdministrationEvidence(database) {
  return database.prepare(
    "INSERT INTO administration_idempotency (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at) VALUES (?,?,?,?,201,'success','2026-08-05T00:00:01.000Z')",
  );
}

export function insertBootstrapFence(database) {
  return database.prepare(`INSERT INTO ingestion_runs (id,state,selected_games_json,started_at,
     expected_current_revision_id,idempotency_key,candidate_json)
     VALUES (?,'planning','[]','2026-08-05T00:00:01.000Z',?,?,
     '{"production_release_bootstrap":true}')`);
}

export function reserveActiveIngestionIdentity(database) {
  return database.prepare("UPDATE operation_state SET active_ingestion_run_id=? WHERE singleton=1");
}

export function insertReleaseRecoveryBackup(database) {
  return database.prepare(`INSERT INTO catalogue_backup_attempts
     (idempotency_key,request_json,owner_token,catalogue_revision_id,state,
      object_key,d1_bookmark,failure_code,failure_detail,started_at,completed_at)
     VALUES (?,'{}','release-backup-owner',?,'pending',?,NULL,NULL,NULL,
     '2026-08-05T00:00:00.000Z',NULL)`);
}

export function insertHandoffRecovery(database) {
  return database.prepare(`INSERT INTO catalogue_recovery_operations
    (id,state,method,request_json,idempotency_key,target_revision_id,target_bookmark,target_digest,
     source_backup_attempt_id,linked_operation_id,expected_current_revision_id,current_bookmark,
     restored_bookmark,undo_bookmark,original_database_id,restored_database_id,retained_database_id,
     expected_schema_migration_level,expected_verification_json,verification_json,
     verification_idempotency_key,verification_request_digest,acceptance_idempotency_key,
     acceptance_request_digest,started_at,restored_at,verified_at,accepted_at,failure_code,failure_detail,failed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
}
