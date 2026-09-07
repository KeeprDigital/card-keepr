SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=24
THEN 1 ELSE json_extract('schema_level_mismatch_expected_24','$') END;

-- Durable authority survives lease expiry, Workflow restart and failed activation.
CREATE TABLE fresh_baseline_handoffs (
 release_id TEXT PRIMARY KEY,
 role TEXT NOT NULL CHECK(role IN ('source','destination')),
 dispatch_digest TEXT NOT NULL UNIQUE,
 execution_id TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 preparation_json TEXT NOT NULL CHECK(json_valid(preparation_json)),
 phase INTEGER NOT NULL CHECK(phase BETWEEN 1 AND 7),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX fresh_baseline_single_authority ON fresh_baseline_handoffs((1)) WHERE role='destination' OR phase<>7;
CREATE TABLE fresh_baseline_cancellations (
 dispatch_digest TEXT PRIMARY KEY,
 response_json TEXT NOT NULL CHECK(json_valid(response_json)),
 created_at TEXT NOT NULL
);
CREATE TRIGGER fresh_baseline_cancel_guard BEFORE INSERT ON fresh_baseline_cancellations
WHEN NOT EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE dispatch_digest=NEW.dispatch_digest AND role='source' AND phase<4)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_cancellation_unsafe'); END;
CREATE TRIGGER fresh_baseline_cancel_immutable_update BEFORE UPDATE ON fresh_baseline_cancellations
BEGIN SELECT RAISE(ABORT,'fresh_baseline_cancellation_immutable'); END;
CREATE TRIGGER fresh_baseline_cancel_immutable_delete BEFORE DELETE ON fresh_baseline_cancellations
BEGIN SELECT RAISE(ABORT,'fresh_baseline_cancellation_immutable'); END;
-- Fresh owner confirmations form a monotonic repair chain; old approvals and
-- their execution/observation evidence are never overwritten by another SHA.
CREATE TABLE fresh_baseline_corrections (
 correction_digest TEXT PRIMARY KEY,
 handoff_dispatch_digest TEXT NOT NULL REFERENCES fresh_baseline_handoffs(dispatch_digest),
 idempotency_key TEXT NOT NULL UNIQUE,
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 100),
 previous_correction_digest TEXT REFERENCES fresh_baseline_corrections(correction_digest),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 response_json TEXT NOT NULL CHECK(json_valid(response_json)),
 execution_id TEXT,
 state INTEGER NOT NULL CHECK(state BETWEEN 0 AND 2),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL,
 UNIQUE(handoff_dispatch_digest,generation)
);
CREATE TRIGGER fresh_baseline_correction_chain BEFORE INSERT ON fresh_baseline_corrections
WHEN NEW.state<>0 OR NEW.execution_id IS NOT NULL OR NEW.generation<>(SELECT COALESCE(MAX(generation),0)+1 FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=NEW.handoff_dispatch_digest)
 OR NEW.previous_correction_digest IS NOT (SELECT correction_digest FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=NEW.handoff_dispatch_digest ORDER BY generation DESC LIMIT 1)
 OR NOT EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE dispatch_digest=NEW.handoff_dispatch_digest AND (phase BETWEEN 4 AND 6 OR (role='destination' AND phase=3)))
BEGIN SELECT RAISE(ABORT,'fresh_baseline_correction_predecessor_changed'); END;
CREATE TRIGGER fresh_baseline_correction_immutable BEFORE UPDATE ON fresh_baseline_corrections
WHEN NEW.correction_digest<>OLD.correction_digest OR NEW.handoff_dispatch_digest<>OLD.handoff_dispatch_digest
 OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.generation<>OLD.generation OR NEW.previous_correction_digest IS NOT OLD.previous_correction_digest
 OR NEW.request_json<>OLD.request_json OR NEW.response_json<>OLD.response_json OR NEW.created_at<>OLD.created_at
 OR OLD.generation<>(SELECT MAX(generation) FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=OLD.handoff_dispatch_digest)
 OR NOT (
  (NEW.state=OLD.state AND NEW.evidence_json=OLD.evidence_json AND (OLD.execution_id IS NULL OR NEW.execution_id=OLD.execution_id OR EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
  OR (NEW.state=OLD.state+1 AND NEW.execution_id=OLD.execution_id AND EXISTS(SELECT 1 FROM fresh_baseline_handoffs h JOIN operation_state o ON o.active_production_release_id=h.release_id WHERE h.dispatch_digest=OLD.handoff_dispatch_digest AND h.execution_id=OLD.execution_id AND o.active_production_release_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 )
BEGIN SELECT RAISE(ABORT,'fresh_baseline_correction_owner_changed'); END;
CREATE TRIGGER fresh_baseline_correction_retained BEFORE DELETE ON fresh_baseline_corrections
BEGIN SELECT RAISE(ABORT,'fresh_baseline_correction_retained'); END;
CREATE TRIGGER fresh_baseline_identity BEFORE UPDATE ON fresh_baseline_handoffs
WHEN NEW.release_id<>OLD.release_id OR NEW.role<>OLD.role OR NEW.dispatch_digest<>OLD.dispatch_digest
 OR NEW.request_json<>OLD.request_json OR NEW.preparation_json<>OLD.preparation_json OR NEW.created_at<>OLD.created_at
 OR NOT (
 (NEW.phase=7 AND OLD.phase<4 AND NEW.execution_id=OLD.execution_id AND json_extract(NEW.evidence_json,'$[#-1].source_still_active')=1)
 OR (OLD.phase<6 AND NEW.phase=OLD.phase+1 AND NEW.execution_id=OLD.execution_id AND EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id=OLD.release_id AND active_production_release_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 OR (NEW.phase=OLD.phase AND NEW.evidence_json=OLD.evidence_json AND EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id=OLD.release_id AND (NEW.execution_id=OLD.execution_id OR active_production_release_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR EXISTS(SELECT 1 FROM fresh_baseline_corrections c WHERE c.handoff_dispatch_digest=OLD.dispatch_digest AND c.generation=(SELECT MAX(generation) FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=OLD.dispatch_digest) AND c.execution_id=NEW.execution_id))))
 )
BEGIN SELECT RAISE(ABORT,'fresh_baseline_transition_invalid'); END;
CREATE TRIGGER fresh_baseline_correction_fence BEFORE UPDATE ON fresh_baseline_handoffs
WHEN EXISTS(SELECT 1 FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=OLD.dispatch_digest)
 AND NOT EXISTS(SELECT 1 FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=OLD.dispatch_digest
 AND generation=(SELECT MAX(generation) FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=OLD.dispatch_digest)
 AND execution_id=NEW.execution_id AND (NEW.phase=OLD.phase OR state=2 OR (OLD.role='destination' AND OLD.phase=3 AND NEW.phase=4 AND state=1)))
BEGIN SELECT RAISE(ABORT,'fresh_baseline_correction_superseded'); END;
CREATE TRIGGER fresh_baseline_retained BEFORE DELETE ON fresh_baseline_handoffs
BEGIN SELECT RAISE(ABORT,'fresh_baseline_authority_retained'); END;
CREATE VIEW fresh_baseline_mutation_fence AS
 SELECT release_id,role,phase FROM fresh_baseline_handoffs WHERE (role='source' AND phase<>7) OR (role='destination' AND phase<>6);
CREATE VIEW fresh_baseline_quiescence AS SELECT
 NOT EXISTS(SELECT 1 FROM ingestion_collection_reservations)
 AND NOT EXISTS(SELECT 1 FROM evidence_object_writers WHERE completed_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE state='deleting')
 AND NOT EXISTS(SELECT 1 FROM staging_object_writes WHERE completed_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM staging_object_deletes WHERE completed_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM staging_objects WHERE state='deleting')
 AND NOT EXISTS(SELECT 1 FROM ingestion_publication_cleanup WHERE state='cleaning')
 AND NOT EXISTS(SELECT 1 FROM catalogue_export_deletions WHERE state='deleting')
 AND NOT EXISTS(SELECT 1 FROM catalogue_backup_attempts WHERE state NOT IN ('verified','failed'))
 AND NOT EXISTS(SELECT 1 FROM card_search_fts_state WHERE state<>'ready')
 AND NOT EXISTS(SELECT 1 FROM reconciliation_operations WHERE state NOT IN ('sealed','failed','abandoned'))
 AND NOT EXISTS(SELECT 1 FROM publication_preparations WHERE state IN ('preparing','retry_paused'))
 AND NOT EXISTS(SELECT 1 FROM game_publication_operations WHERE state NOT IN ('published','failed')) AS ready;
CREATE TRIGGER fresh_baseline_claim_guard BEFORE INSERT ON fresh_baseline_handoffs
WHEN NEW.phase<>1
 OR NOT EXISTS(SELECT 1 FROM administration_idempotency WHERE operation='prepare_production_release'
 AND request_json=NEW.request_json AND response_json=NEW.preparation_json
 AND json_extract(response_json,'$.dispatch_digest')=NEW.dispatch_digest
 AND json_extract(response_json,'$.release_id')=NEW.release_id)
 OR NOT EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id=NEW.release_id)
 OR NOT EXISTS(SELECT 1 FROM fresh_baseline_quiescence WHERE ready=1)
 OR EXISTS(SELECT 1 FROM operation_state WHERE recovery_health<>'healthy' OR recovery_restore_guard<>'clear' OR active_recovery_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_not_quiescent'); END;
CREATE TRIGGER handoff_fence_administration_idempotency_insert BEFORE INSERT ON administration_idempotency
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_administration_idempotency_update BEFORE UPDATE ON administration_idempotency
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_administration_idempotency_delete BEFORE DELETE ON administration_idempotency
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_administration_idempotency_claims_insert BEFORE INSERT ON administration_idempotency_claims
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_administration_idempotency_claims_update BEFORE UPDATE ON administration_idempotency_claims
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_administration_idempotency_claims_delete BEFORE DELETE ON administration_idempotency_claims
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_allocations_insert BEFORE INSERT ON canonical_identity_allocations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_allocations_update BEFORE UPDATE ON canonical_identity_allocations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_allocations_delete BEFORE DELETE ON canonical_identity_allocations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_decisions_insert BEFORE INSERT ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_decisions_update BEFORE UPDATE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_decisions_delete BEFORE DELETE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_review_runs_insert BEFORE INSERT ON canonical_identity_review_runs
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_review_runs_update BEFORE UPDATE ON canonical_identity_review_runs
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_review_runs_delete BEFORE DELETE ON canonical_identity_review_runs
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_reviews_insert BEFORE INSERT ON canonical_identity_reviews
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_reviews_update BEFORE UPDATE ON canonical_identity_reviews
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_reviews_delete BEFORE DELETE ON canonical_identity_reviews
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_source_mappings_insert BEFORE INSERT ON canonical_source_mappings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_source_mappings_update BEFORE UPDATE ON canonical_source_mappings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_source_mappings_delete BEFORE DELETE ON canonical_source_mappings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_attempts_insert BEFORE INSERT ON catalogue_backup_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_attempts_update BEFORE UPDATE ON catalogue_backup_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_attempts_delete BEFORE DELETE ON catalogue_backup_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_dispatch_insert BEFORE INSERT ON catalogue_backup_dispatch
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_dispatch_update BEFORE UPDATE ON catalogue_backup_dispatch
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_dispatch_delete BEFORE DELETE ON catalogue_backup_dispatch
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_retention_insert BEFORE INSERT ON catalogue_backup_retention
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_retention_update BEFORE UPDATE ON catalogue_backup_retention
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_retention_delete BEFORE DELETE ON catalogue_backup_retention
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_workflow_requests_insert BEFORE INSERT ON catalogue_backup_workflow_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_workflow_requests_update BEFORE UPDATE ON catalogue_backup_workflow_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_backup_workflow_requests_delete BEFORE DELETE ON catalogue_backup_workflow_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_candidate_publications_insert BEFORE INSERT ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_candidate_publications_update BEFORE UPDATE ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_candidate_publications_delete BEFORE DELETE ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_composition_games_insert BEFORE INSERT ON catalogue_composition_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_composition_games_update BEFORE UPDATE ON catalogue_composition_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_composition_games_delete BEFORE DELETE ON catalogue_composition_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_curated_provenance_insert BEFORE INSERT ON catalogue_curated_provenance
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_curated_provenance_update BEFORE UPDATE ON catalogue_curated_provenance
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_curated_provenance_delete BEFORE DELETE ON catalogue_curated_provenance
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_plans_insert BEFORE INSERT ON catalogue_export_deletion_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_plans_update BEFORE UPDATE ON catalogue_export_deletion_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_plans_delete BEFORE DELETE ON catalogue_export_deletion_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_retries_insert BEFORE INSERT ON catalogue_export_deletion_retries
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_retries_update BEFORE UPDATE ON catalogue_export_deletion_retries
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_retries_delete BEFORE DELETE ON catalogue_export_deletion_retries
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_tombstones_insert BEFORE INSERT ON catalogue_export_deletion_tombstones
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_tombstones_update BEFORE UPDATE ON catalogue_export_deletion_tombstones
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletion_tombstones_delete BEFORE DELETE ON catalogue_export_deletion_tombstones
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletions_insert BEFORE INSERT ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletions_update BEFORE UPDATE ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_export_deletions_delete BEFORE DELETE ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_exports_insert BEFORE INSERT ON catalogue_exports
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_exports_update BEFORE UPDATE ON catalogue_exports
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_exports_delete BEFORE DELETE ON catalogue_exports
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_query_revisions_insert BEFORE INSERT ON catalogue_query_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_query_revisions_update BEFORE UPDATE ON catalogue_query_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_query_revisions_delete BEFORE DELETE ON catalogue_query_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_collection_classifications_insert BEFORE INSERT ON catalogue_recovery_collection_classifications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_collection_classifications_update BEFORE UPDATE ON catalogue_recovery_collection_classifications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_collection_classifications_delete BEFORE DELETE ON catalogue_recovery_collection_classifications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_operations_insert BEFORE INSERT ON catalogue_recovery_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_operations_update BEFORE UPDATE ON catalogue_recovery_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_operations_delete BEFORE DELETE ON catalogue_recovery_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_work_classifications_insert BEFORE INSERT ON catalogue_recovery_work_classifications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_work_classifications_update BEFORE UPDATE ON catalogue_recovery_work_classifications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_recovery_work_classifications_delete BEFORE DELETE ON catalogue_recovery_work_classifications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_revisions_insert BEFORE INSERT ON catalogue_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_revisions_update BEFORE UPDATE ON catalogue_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_revisions_delete BEFORE DELETE ON catalogue_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_schema_state_insert BEFORE INSERT ON catalogue_schema_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_schema_state_update BEFORE UPDATE ON catalogue_schema_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_schema_state_delete BEFORE DELETE ON catalogue_schema_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_search_repair_requests_insert BEFORE INSERT ON catalogue_search_repair_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_search_repair_requests_update BEFORE UPDATE ON catalogue_search_repair_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_search_repair_requests_delete BEFORE DELETE ON catalogue_search_repair_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_state_insert BEFORE INSERT ON catalogue_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_state_update BEFORE UPDATE ON catalogue_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_state_delete BEFORE DELETE ON catalogue_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revision_events_insert BEFORE INSERT ON curated_revision_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revision_events_update BEFORE UPDATE ON curated_revision_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revision_events_delete BEFORE DELETE ON curated_revision_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revision_idempotency_insert BEFORE INSERT ON curated_revision_idempotency
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revision_idempotency_update BEFORE UPDATE ON curated_revision_idempotency
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revision_idempotency_delete BEFORE DELETE ON curated_revision_idempotency
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revisions_insert BEFORE INSERT ON curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revisions_update BEFORE UPDATE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revisions_delete BEFORE DELETE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_decisions_insert BEFORE INSERT ON entity_admission_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_decisions_update BEFORE UPDATE ON entity_admission_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_decisions_delete BEFORE DELETE ON entity_admission_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_events_insert BEFORE INSERT ON entity_admission_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_events_update BEFORE UPDATE ON entity_admission_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_events_delete BEFORE DELETE ON entity_admission_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_pinned_decisions_insert BEFORE INSERT ON entity_admission_pinned_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_pinned_decisions_update BEFORE UPDATE ON entity_admission_pinned_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_pinned_decisions_delete BEFORE DELETE ON entity_admission_pinned_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_run_pins_insert BEFORE INSERT ON entity_admission_run_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_run_pins_update BEFORE UPDATE ON entity_admission_run_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_admission_run_pins_delete BEFORE DELETE ON entity_admission_run_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_proposal_source_evidence_insert BEFORE INSERT ON entity_proposal_source_evidence
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_proposal_source_evidence_update BEFORE UPDATE ON entity_proposal_source_evidence
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_proposal_source_evidence_delete BEFORE DELETE ON entity_proposal_source_evidence
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_proposals_insert BEFORE INSERT ON entity_proposals
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_proposals_update BEFORE UPDATE ON entity_proposals
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_entity_proposals_delete BEFORE DELETE ON entity_proposals
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_erratum_provenance_insert BEFORE INSERT ON erratum_provenance
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_erratum_provenance_update BEFORE UPDATE ON erratum_provenance
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_erratum_provenance_delete BEFORE DELETE ON erratum_provenance
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_objects_insert BEFORE INSERT ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_objects_update BEFORE UPDATE ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_objects_delete BEFORE DELETE ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_operations_insert BEFORE INSERT ON evidence_cleanup_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_operations_update BEFORE UPDATE ON evidence_cleanup_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_operations_delete BEFORE DELETE ON evidence_cleanup_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_results_insert BEFORE INSERT ON evidence_cleanup_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_results_update BEFORE UPDATE ON evidence_cleanup_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_cleanup_results_delete BEFORE DELETE ON evidence_cleanup_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_object_references_insert BEFORE INSERT ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_object_references_update BEFORE UPDATE ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_object_references_delete BEFORE DELETE ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_object_writers_insert BEFORE INSERT ON evidence_object_writers
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_object_writers_update BEFORE UPDATE ON evidence_object_writers
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_evidence_object_writers_delete BEFORE DELETE ON evidence_object_writers
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_entity_scopes_insert BEFORE INSERT ON game_candidate_entity_scopes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_entity_scopes_update BEFORE UPDATE ON game_candidate_entity_scopes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_entity_scopes_delete BEFORE DELETE ON game_candidate_entity_scopes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_partitions_insert BEFORE INSERT ON game_candidate_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_partitions_update BEFORE UPDATE ON game_candidate_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_partitions_delete BEFORE DELETE ON game_candidate_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_slots_insert BEFORE INSERT ON game_candidate_slots
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_slots_update BEFORE UPDATE ON game_candidate_slots
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_slots_delete BEFORE DELETE ON game_candidate_slots
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidates_insert BEFORE INSERT ON game_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidates_update BEFORE UPDATE ON game_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidates_delete BEFORE DELETE ON game_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_catalogue_heads_insert BEFORE INSERT ON game_catalogue_heads
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_catalogue_heads_update BEFORE UPDATE ON game_catalogue_heads
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_catalogue_heads_delete BEFORE DELETE ON game_catalogue_heads
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_publication_actions_insert BEFORE INSERT ON game_publication_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_publication_actions_update BEFORE UPDATE ON game_publication_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_publication_actions_delete BEFORE DELETE ON game_publication_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_publication_operations_insert BEFORE INSERT ON game_publication_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_publication_operations_update BEFORE UPDATE ON game_publication_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_publication_operations_delete BEFORE DELETE ON game_publication_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_reconciliation_requests_insert BEFORE INSERT ON game_reconciliation_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_reconciliation_requests_update BEFORE UPDATE ON game_reconciliation_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_game_reconciliation_requests_delete BEFORE DELETE ON game_reconciliation_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_identity_correction_decisions_insert BEFORE INSERT ON identity_correction_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_identity_correction_decisions_update BEFORE UPDATE ON identity_correction_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_identity_correction_decisions_delete BEFORE DELETE ON identity_correction_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_identity_correction_run_pins_insert BEFORE INSERT ON identity_correction_run_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_identity_correction_run_pins_update BEFORE UPDATE ON identity_correction_run_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_identity_correction_run_pins_delete BEFORE DELETE ON identity_correction_run_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_collection_completions_insert BEFORE INSERT ON ingestion_collection_completions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_collection_completions_update BEFORE UPDATE ON ingestion_collection_completions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_collection_completions_delete BEFORE DELETE ON ingestion_collection_completions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_collection_reservations_insert BEFORE INSERT ON ingestion_collection_reservations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_collection_reservations_update BEFORE UPDATE ON ingestion_collection_reservations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_collection_reservations_delete BEFORE DELETE ON ingestion_collection_reservations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_evidence_plans_insert BEFORE INSERT ON ingestion_evidence_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_evidence_plans_update BEFORE UPDATE ON ingestion_evidence_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_evidence_plans_delete BEFORE DELETE ON ingestion_evidence_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_no_change_results_insert BEFORE INSERT ON ingestion_no_change_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_no_change_results_update BEFORE UPDATE ON ingestion_no_change_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_no_change_results_delete BEFORE DELETE ON ingestion_no_change_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_publication_cleanup_insert BEFORE INSERT ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_publication_cleanup_update BEFORE UPDATE ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_publication_cleanup_delete BEFORE DELETE ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_capacity_extensions_insert BEFORE INSERT ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_capacity_extensions_update BEFORE UPDATE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_capacity_extensions_delete BEFORE DELETE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_capacity_pauses_insert BEFORE INSERT ON ingestion_run_capacity_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_capacity_pauses_update BEFORE UPDATE ON ingestion_run_capacity_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_capacity_pauses_delete BEFORE DELETE ON ingestion_run_capacity_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_curated_revision_sets_insert BEFORE INSERT ON ingestion_run_curated_revision_sets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_curated_revision_sets_update BEFORE UPDATE ON ingestion_run_curated_revision_sets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_curated_revision_sets_delete BEFORE DELETE ON ingestion_run_curated_revision_sets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_curated_revisions_insert BEFORE INSERT ON ingestion_run_curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_curated_revisions_update BEFORE UPDATE ON ingestion_run_curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_curated_revisions_delete BEFORE DELETE ON ingestion_run_curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_current_insert BEFORE INSERT ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_current_update BEFORE UPDATE ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_current_delete BEFORE DELETE ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_event_payload_chunks_insert BEFORE INSERT ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_event_payload_chunks_update BEFORE UPDATE ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_event_payload_chunks_delete BEFORE DELETE ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_events_insert BEFORE INSERT ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_events_update BEFORE UPDATE ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_events_delete BEFORE DELETE ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_retry_pauses_insert BEFORE INSERT ON ingestion_run_retry_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_retry_pauses_update BEFORE UPDATE ON ingestion_run_retry_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_retry_pauses_delete BEFORE DELETE ON ingestion_run_retry_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_selected_games_insert BEFORE INSERT ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_selected_games_update BEFORE UPDATE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_selected_games_delete BEFORE DELETE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_terminations_insert BEFORE INSERT ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_terminations_update BEFORE UPDATE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_terminations_delete BEFORE DELETE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_workflow_pauses_insert BEFORE INSERT ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_workflow_pauses_update BEFORE UPDATE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_workflow_pauses_delete BEFORE DELETE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_runs_insert BEFORE INSERT ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_runs_update BEFORE UPDATE ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_runs_delete BEFORE DELETE ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_workflow_attempts_insert BEFORE INSERT ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_workflow_attempts_update BEFORE UPDATE ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_workflow_attempts_delete BEFORE DELETE ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_workflow_progress_insert BEFORE INSERT ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_workflow_progress_update BEFORE UPDATE ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_workflow_progress_delete BEFORE DELETE ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_official_source_collection_plans_insert BEFORE INSERT ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_official_source_collection_plans_update BEFORE UPDATE ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_official_source_collection_plans_delete BEFORE DELETE ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_production_releases_insert BEFORE INSERT ON production_releases
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_production_releases_update BEFORE UPDATE ON production_releases
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_production_releases_delete BEFORE DELETE ON production_releases
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_composition_nodes_insert BEFORE INSERT ON publication_composition_nodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_composition_nodes_update BEFORE UPDATE ON publication_composition_nodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_composition_nodes_delete BEFORE DELETE ON publication_composition_nodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_components_insert BEFORE INSERT ON publication_export_components
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_components_update BEFORE UPDATE ON publication_export_components
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_components_delete BEFORE DELETE ON publication_export_components
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_nodes_insert BEFORE INSERT ON publication_export_nodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_nodes_update BEFORE UPDATE ON publication_export_nodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_nodes_delete BEFORE DELETE ON publication_export_nodes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_preparations_insert BEFORE INSERT ON publication_export_preparations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_preparations_update BEFORE UPDATE ON publication_export_preparations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_export_preparations_delete BEFORE DELETE ON publication_export_preparations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparation_actions_insert BEFORE INSERT ON publication_preparation_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparation_actions_update BEFORE UPDATE ON publication_preparation_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparation_actions_delete BEFORE DELETE ON publication_preparation_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparation_artifacts_insert BEFORE INSERT ON publication_preparation_artifacts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparation_artifacts_update BEFORE UPDATE ON publication_preparation_artifacts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparation_artifacts_delete BEFORE DELETE ON publication_preparation_artifacts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparations_insert BEFORE INSERT ON publication_preparations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparations_update BEFORE UPDATE ON publication_preparations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_preparations_delete BEFORE DELETE ON publication_preparations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_projection_batches_insert BEFORE INSERT ON publication_projection_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_projection_batches_update BEFORE UPDATE ON publication_projection_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_projection_batches_delete BEFORE DELETE ON publication_projection_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_query_documents_insert BEFORE INSERT ON publication_query_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_query_documents_update BEFORE UPDATE ON publication_query_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_query_documents_delete BEFORE DELETE ON publication_query_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_attributes_insert BEFORE INSERT ON publication_read_attributes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_attributes_update BEFORE UPDATE ON publication_read_attributes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_attributes_delete BEFORE DELETE ON publication_read_attributes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_entities_insert BEFORE INSERT ON publication_read_entities
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_entities_update BEFORE UPDATE ON publication_read_entities
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_entities_delete BEFORE DELETE ON publication_read_entities
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_lifecycles_insert BEFORE INSERT ON publication_read_lifecycles
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_lifecycles_update BEFORE UPDATE ON publication_read_lifecycles
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_lifecycles_delete BEFORE DELETE ON publication_read_lifecycles
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_release_regions_insert BEFORE INSERT ON publication_read_release_regions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_release_regions_update BEFORE UPDATE ON publication_read_release_regions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_release_regions_delete BEFORE DELETE ON publication_read_release_regions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_text_chunks_insert BEFORE INSERT ON publication_read_text_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_text_chunks_update BEFORE UPDATE ON publication_read_text_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_read_text_chunks_delete BEFORE DELETE ON publication_read_text_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_search_chunks_insert BEFORE INSERT ON publication_search_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_search_chunks_update BEFORE UPDATE ON publication_search_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_search_chunks_delete BEFORE DELETE ON publication_search_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_workflow_budgets_insert BEFORE INSERT ON publication_workflow_budgets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_workflow_budgets_update BEFORE UPDATE ON publication_workflow_budgets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_publication_workflow_budgets_delete BEFORE DELETE ON publication_workflow_budgets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_card_observations_insert BEFORE INSERT ON reconciled_card_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_card_observations_update BEFORE UPDATE ON reconciled_card_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_card_observations_delete BEFORE DELETE ON reconciled_card_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_cards_insert BEFORE INSERT ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_cards_update BEFORE UPDATE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_cards_delete BEFORE DELETE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_distribution_contexts_insert BEFORE INSERT ON reconciled_distribution_contexts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_distribution_contexts_update BEFORE UPDATE ON reconciled_distribution_contexts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_distribution_contexts_delete BEFORE DELETE ON reconciled_distribution_contexts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_errata_insert BEFORE INSERT ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_errata_update BEFORE UPDATE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_errata_delete BEFORE DELETE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_images_insert BEFORE INSERT ON reconciled_printing_images
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_images_update BEFORE UPDATE ON reconciled_printing_images
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_images_delete BEFORE DELETE ON reconciled_printing_images
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_locators_insert BEFORE INSERT ON reconciled_printing_locators
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_locators_update BEFORE UPDATE ON reconciled_printing_locators
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_locators_delete BEFORE DELETE ON reconciled_printing_locators
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_memberships_insert BEFORE INSERT ON reconciled_printing_memberships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_memberships_update BEFORE UPDATE ON reconciled_printing_memberships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printing_memberships_delete BEFORE DELETE ON reconciled_printing_memberships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printings_insert BEFORE INSERT ON reconciled_printings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printings_update BEFORE UPDATE ON reconciled_printings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_printings_delete BEFORE DELETE ON reconciled_printings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_product_relationships_insert BEFORE INSERT ON reconciled_product_relationships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_product_relationships_update BEFORE UPDATE ON reconciled_product_relationships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_product_relationships_delete BEFORE DELETE ON reconciled_product_relationships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_products_insert BEFORE INSERT ON reconciled_products
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_products_update BEFORE UPDATE ON reconciled_products
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_products_delete BEFORE DELETE ON reconciled_products
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_releases_insert BEFORE INSERT ON reconciled_releases
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_releases_update BEFORE UPDATE ON reconciled_releases
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_releases_delete BEFORE DELETE ON reconciled_releases
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_withdrawal_assertions_insert BEFORE INSERT ON reconciled_withdrawal_assertions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_withdrawal_assertions_update BEFORE UPDATE ON reconciled_withdrawal_assertions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_withdrawal_assertions_delete BEFORE DELETE ON reconciled_withdrawal_assertions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_actions_insert BEFORE INSERT ON reconciliation_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_actions_update BEFORE UPDATE ON reconciliation_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_actions_delete BEFORE DELETE ON reconciliation_actions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_admission_decisions_insert BEFORE INSERT ON reconciliation_admission_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_admission_decisions_update BEFORE UPDATE ON reconciliation_admission_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_admission_decisions_delete BEFORE DELETE ON reconciliation_admission_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_admission_pins_insert BEFORE INSERT ON reconciliation_admission_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_admission_pins_update BEFORE UPDATE ON reconciliation_admission_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_admission_pins_delete BEFORE DELETE ON reconciliation_admission_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_automatic_admissions_insert BEFORE INSERT ON reconciliation_automatic_admissions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_automatic_admissions_update BEFORE UPDATE ON reconciliation_automatic_admissions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_automatic_admissions_delete BEFORE DELETE ON reconciliation_automatic_admissions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_candidates_insert BEFORE INSERT ON reconciliation_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_candidates_update BEFORE UPDATE ON reconciliation_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_candidates_delete BEFORE DELETE ON reconciliation_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_canonical_bytes_insert BEFORE INSERT ON reconciliation_canonical_bytes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_canonical_bytes_update BEFORE UPDATE ON reconciliation_canonical_bytes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_canonical_bytes_delete BEFORE DELETE ON reconciliation_canonical_bytes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_checkpoints_insert BEFORE INSERT ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_checkpoints_update BEFORE UPDATE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_checkpoints_delete BEFORE DELETE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_contexts_insert BEFORE INSERT ON reconciliation_contexts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_contexts_update BEFORE UPDATE ON reconciliation_contexts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_contexts_delete BEFORE DELETE ON reconciliation_contexts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_correction_pins_insert BEFORE INSERT ON reconciliation_correction_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_correction_pins_update BEFORE UPDATE ON reconciliation_correction_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_correction_pins_delete BEFORE DELETE ON reconciliation_correction_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_curated_conflicts_insert BEFORE INSERT ON reconciliation_curated_conflicts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_curated_conflicts_update BEFORE UPDATE ON reconciliation_curated_conflicts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_curated_conflicts_delete BEFORE DELETE ON reconciliation_curated_conflicts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_curated_pins_insert BEFORE INSERT ON reconciliation_curated_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_curated_pins_update BEFORE UPDATE ON reconciliation_curated_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_curated_pins_delete BEFORE DELETE ON reconciliation_curated_pins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_evidence_partitions_insert BEFORE INSERT ON reconciliation_evidence_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_evidence_partitions_update BEFORE UPDATE ON reconciliation_evidence_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_evidence_partitions_delete BEFORE DELETE ON reconciliation_evidence_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_evidence_selection_insert BEFORE INSERT ON reconciliation_evidence_selection
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_evidence_selection_update BEFORE UPDATE ON reconciliation_evidence_selection
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_evidence_selection_delete BEFORE DELETE ON reconciliation_evidence_selection
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_identity_reviews_insert BEFORE INSERT ON reconciliation_identity_reviews
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_identity_reviews_update BEFORE UPDATE ON reconciliation_identity_reviews
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_identity_reviews_delete BEFORE DELETE ON reconciliation_identity_reviews
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_input_partitions_insert BEFORE INSERT ON reconciliation_input_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_input_partitions_update BEFORE UPDATE ON reconciliation_input_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_input_partitions_delete BEFORE DELETE ON reconciliation_input_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_normalized_observations_insert BEFORE INSERT ON reconciliation_normalized_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_normalized_observations_update BEFORE UPDATE ON reconciliation_normalized_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_normalized_observations_delete BEFORE DELETE ON reconciliation_normalized_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_observation_origins_insert BEFORE INSERT ON reconciliation_observation_origins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_observation_origins_update BEFORE UPDATE ON reconciliation_observation_origins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_observation_origins_delete BEFORE DELETE ON reconciliation_observation_origins
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_operations_insert BEFORE INSERT ON reconciliation_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_operations_update BEFORE UPDATE ON reconciliation_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_operations_delete BEFORE DELETE ON reconciliation_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_payload_chunks_insert BEFORE INSERT ON reconciliation_payload_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_payload_chunks_update BEFORE UPDATE ON reconciliation_payload_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_payload_chunks_delete BEFORE DELETE ON reconciliation_payload_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_preparation_batches_insert BEFORE INSERT ON reconciliation_preparation_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_preparation_batches_update BEFORE UPDATE ON reconciliation_preparation_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_preparation_batches_delete BEFORE DELETE ON reconciliation_preparation_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_record_partitions_insert BEFORE INSERT ON reconciliation_record_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_record_partitions_update BEFORE UPDATE ON reconciliation_record_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_record_partitions_delete BEFORE DELETE ON reconciliation_record_partitions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_reducer_state_insert BEFORE INSERT ON reconciliation_reducer_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_reducer_state_update BEFORE UPDATE ON reconciliation_reducer_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_reducer_state_delete BEFORE DELETE ON reconciliation_reducer_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_sort_batches_insert BEFORE INSERT ON reconciliation_sort_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_sort_batches_update BEFORE UPDATE ON reconciliation_sort_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_sort_batches_delete BEFORE DELETE ON reconciliation_sort_batches
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_byte_chunks_insert BEFORE INSERT ON reconciliation_source_byte_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_byte_chunks_update BEFORE UPDATE ON reconciliation_source_byte_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_byte_chunks_delete BEFORE DELETE ON reconciliation_source_byte_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_documents_insert BEFORE INSERT ON reconciliation_source_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_documents_update BEFORE UPDATE ON reconciliation_source_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_documents_delete BEFORE DELETE ON reconciliation_source_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_mappings_insert BEFORE INSERT ON reconciliation_source_mappings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_mappings_update BEFORE UPDATE ON reconciliation_source_mappings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_mappings_delete BEFORE DELETE ON reconciliation_source_mappings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_observations_insert BEFORE INSERT ON reconciliation_source_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_observations_update BEFORE UPDATE ON reconciliation_source_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_source_observations_delete BEFORE DELETE ON reconciliation_source_observations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_terminal_results_insert BEFORE INSERT ON reconciliation_terminal_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_terminal_results_update BEFORE UPDATE ON reconciliation_terminal_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_terminal_results_delete BEFORE DELETE ON reconciliation_terminal_results
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_text_chunks_insert BEFORE INSERT ON reconciliation_text_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_text_chunks_update BEFORE UPDATE ON reconciliation_text_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_text_chunks_delete BEFORE DELETE ON reconciliation_text_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_workflow_budgets_insert BEFORE INSERT ON reconciliation_workflow_budgets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_workflow_budgets_update BEFORE UPDATE ON reconciliation_workflow_budgets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_workflow_budgets_delete BEFORE DELETE ON reconciliation_workflow_budgets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_workflow_requests_insert BEFORE INSERT ON reconciliation_workflow_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_workflow_requests_update BEFORE UPDATE ON reconciliation_workflow_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_workflow_requests_delete BEFORE DELETE ON reconciliation_workflow_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_retained_source_observation_evidence_insert BEFORE INSERT ON retained_source_observation_evidence
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_retained_source_observation_evidence_update BEFORE UPDATE ON retained_source_observation_evidence
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_retained_source_observation_evidence_delete BEFORE DELETE ON retained_source_observation_evidence
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_attributes_insert BEFORE INSERT ON revision_card_attributes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_attributes_update BEFORE UPDATE ON revision_card_attributes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_attributes_delete BEFORE DELETE ON revision_card_attributes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_query_documents_insert BEFORE INSERT ON revision_card_query_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_query_documents_update BEFORE UPDATE ON revision_card_query_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_query_documents_delete BEFORE DELETE ON revision_card_query_documents
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_search_chunks_insert BEFORE INSERT ON revision_card_search_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_search_chunks_update BEFORE UPDATE ON revision_card_search_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_card_search_chunks_delete BEFORE DELETE ON revision_card_search_chunks
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_cards_insert BEFORE INSERT ON revision_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_cards_update BEFORE UPDATE ON revision_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_cards_delete BEFORE DELETE ON revision_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_errata_insert BEFORE INSERT ON revision_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_errata_update BEFORE UPDATE ON revision_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_errata_delete BEFORE DELETE ON revision_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_identity_corrections_insert BEFORE INSERT ON revision_identity_corrections
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_identity_corrections_update BEFORE UPDATE ON revision_identity_corrections
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_identity_corrections_delete BEFORE DELETE ON revision_identity_corrections
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_images_insert BEFORE INSERT ON revision_printing_images
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_images_update BEFORE UPDATE ON revision_printing_images
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_images_delete BEFORE DELETE ON revision_printing_images
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_product_query_insert BEFORE INSERT ON revision_printing_product_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_product_query_update BEFORE UPDATE ON revision_printing_product_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_product_query_delete BEFORE DELETE ON revision_printing_product_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_query_insert BEFORE INSERT ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_query_update BEFORE UPDATE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_query_delete BEFORE DELETE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printings_insert BEFORE INSERT ON revision_printings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printings_update BEFORE UPDATE ON revision_printings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printings_delete BEFORE DELETE ON revision_printings
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_product_relationships_insert BEFORE INSERT ON revision_product_relationships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_product_relationships_update BEFORE UPDATE ON revision_product_relationships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_product_relationships_delete BEFORE DELETE ON revision_product_relationships
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_products_insert BEFORE INSERT ON revision_products
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_products_update BEFORE UPDATE ON revision_products
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_products_delete BEFORE DELETE ON revision_products
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_adapter_versions_insert BEFORE INSERT ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_adapter_versions_update BEFORE UPDATE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_adapter_versions_delete BEFORE DELETE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_authority_decisions_insert BEFORE INSERT ON source_authority_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_authority_decisions_update BEFORE UPDATE ON source_authority_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_authority_decisions_delete BEFORE DELETE ON source_authority_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_capture_operations_insert BEFORE INSERT ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_capture_operations_update BEFORE UPDATE ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_capture_operations_delete BEFORE DELETE ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_discovery_request_plans_insert BEFORE INSERT ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_discovery_request_plans_update BEFORE UPDATE ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_discovery_request_plans_delete BEFORE DELETE ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_fetch_attempts_insert BEFORE INSERT ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_fetch_attempts_update BEFORE UPDATE ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_fetch_attempts_delete BEFORE DELETE ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_freshness_insert BEFORE INSERT ON source_freshness
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_freshness_update BEFORE UPDATE ON source_freshness
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_freshness_delete BEFORE DELETE ON source_freshness
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_host_pacing_insert BEFORE INSERT ON source_host_pacing
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_host_pacing_update BEFORE UPDATE ON source_host_pacing
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_host_pacing_delete BEFORE DELETE ON source_host_pacing
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_lifecycle_decisions_insert BEFORE INSERT ON source_lifecycle_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_lifecycle_decisions_update BEFORE UPDATE ON source_lifecycle_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_lifecycle_decisions_delete BEFORE DELETE ON source_lifecycle_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_observation_sets_insert BEFORE INSERT ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_observation_sets_update BEFORE UPDATE ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_observation_sets_delete BEFORE DELETE ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_parse_operations_insert BEFORE INSERT ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_parse_operations_update BEFORE UPDATE ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_parse_operations_delete BEFORE DELETE ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_requests_insert BEFORE INSERT ON source_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_requests_update BEFORE UPDATE ON source_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_requests_delete BEFORE DELETE ON source_requests
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_snapshots_insert BEFORE INSERT ON source_snapshots
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_snapshots_update BEFORE UPDATE ON source_snapshots
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_snapshots_delete BEFORE DELETE ON source_snapshots
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_object_deletes_insert BEFORE INSERT ON staging_object_deletes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_object_deletes_update BEFORE UPDATE ON staging_object_deletes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_object_deletes_delete BEFORE DELETE ON staging_object_deletes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_object_writes_insert BEFORE INSERT ON staging_object_writes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_object_writes_update BEFORE UPDATE ON staging_object_writes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_object_writes_delete BEFORE DELETE ON staging_object_writes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_objects_insert BEFORE INSERT ON staging_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_objects_update BEFORE UPDATE ON staging_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_staging_objects_delete BEFORE DELETE ON staging_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_verified_publication_compositions_insert BEFORE INSERT ON verified_publication_compositions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_verified_publication_compositions_update BEFORE UPDATE ON verified_publication_compositions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_verified_publication_compositions_delete BEFORE DELETE ON verified_publication_compositions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_card_search_fts_state_insert BEFORE INSERT ON card_search_fts_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_card_search_fts_state_update BEFORE UPDATE ON card_search_fts_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_card_search_fts_state_delete BEFORE DELETE ON card_search_fts_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
-- Release scripts may renew the same lease, but no expired/failed owner can
-- reclaim source authority or change recovery state through ordinary cleanup.
CREATE TRIGGER handoff_fence_operation_state BEFORE UPDATE ON operation_state
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence) AND (
 NEW.active_ingestion_run_id IS NOT OLD.active_ingestion_run_id
 OR NEW.recovery_health IS NOT OLD.recovery_health OR NEW.active_recovery_id IS NOT OLD.active_recovery_id
 OR NEW.recovery_restore_guard IS NOT OLD.recovery_restore_guard
 OR NEW.active_production_release_id IS NOT OLD.active_production_release_id)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
-- Retained source D1 still owns shared R2 evidence. Destination maintenance must
-- not reclaim it merely because its fresh catalogue has no local references.
CREATE TRIGGER handoff_retention_evidence_cleanup_objects_insert BEFORE INSERT ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_evidence_cleanup_objects_update BEFORE UPDATE ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_evidence_cleanup_objects_delete BEFORE DELETE ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_staging_object_deletes_insert BEFORE INSERT ON staging_object_deletes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_staging_object_deletes_update BEFORE UPDATE ON staging_object_deletes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_staging_object_deletes_delete BEFORE DELETE ON staging_object_deletes
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_catalogue_export_deletions_insert BEFORE INSERT ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_catalogue_export_deletions_update BEFORE UPDATE ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_catalogue_export_deletions_delete BEFORE DELETE ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_catalogue_backup_retention_insert BEFORE INSERT ON catalogue_backup_retention
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_catalogue_backup_retention_update BEFORE UPDATE ON catalogue_backup_retention
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_catalogue_backup_retention_delete BEFORE DELETE ON catalogue_backup_retention
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_ingestion_publication_cleanup_insert BEFORE INSERT ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_ingestion_publication_cleanup_update BEFORE UPDATE ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;
CREATE TRIGGER handoff_retention_ingestion_publication_cleanup_delete BEFORE DELETE ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE role='destination')
BEGIN SELECT RAISE(ABORT,'fresh_baseline_retained_source_storage'); END;

UPDATE catalogue_schema_state SET migration_level=27 WHERE singleton=1;
