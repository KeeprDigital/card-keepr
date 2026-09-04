SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 10
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_10', '$') END;

-- Runtime repositories now own state/authority guards and transactional materialization.
-- Keep immutable evidence protection in SQLite, including the identity portion
-- formerly mixed into the Export Deletion state transition trigger.
DROP TRIGGER archive_removed_card_query_material;
DROP TRIGGER catalogue_backup_attempts_legal_transition;
DROP TRIGGER catalogue_backup_verified_evidence_required;
DROP TRIGGER catalogue_export_deletion_operation_guard;
DROP TRIGGER catalogue_export_deletion_operation_transition_guard;
DROP TRIGGER catalogue_export_maintenance_transition_guard;
DROP TRIGGER catalogue_recovery_health_remains_blocked;
DROP TRIGGER catalogue_recovery_transition_is_legal;
DROP TRIGGER curated_revision_catalogue_revision_guard;
DROP TRIGGER curated_revision_mutation_guard;
DROP TRIGGER curated_revision_owner_event_catalogue_guard;
DROP TRIGGER curated_revision_owner_event_operation_guard;
DROP TRIGGER curated_revision_owner_event_release_guard;
DROP TRIGGER curated_revision_pin_set_matches_run_start;
DROP TRIGGER curated_revision_reconfirmation_blocks_run;
DROP TRIGGER curated_revision_release_guard;
DROP TRIGGER curated_revision_target_overlap_guard;
DROP TRIGGER guard_approval_transition;
DROP TRIGGER guard_candidate_finalization;
DROP TRIGGER guard_capacity_extension_requires_paused_run;
DROP TRIGGER guard_capacity_pause_requires_paused_run;
DROP TRIGGER guard_catalogue_publication;
DROP TRIGGER guard_cleanup_idempotency_completion;
DROP TRIGGER guard_idempotency_claim_after_completion;
DROP TRIGGER guard_idempotency_outcome_owner;
DROP TRIGGER guard_legal_ingestion_transition;
DROP TRIGGER guard_no_change_result;
DROP TRIGGER guard_retry_pause_requires_paused_run;
DROP TRIGGER guard_termination_requires_paused_run;
DROP TRIGGER guard_workflow_pause_requires_paused_run;
DROP TRIGGER ingestion_evidence_plan_origin_matches_adapter;
DROP TRIGGER legality_rule_card_ids_canonical_insert;
DROP TRIGGER legality_rule_effect_valid_insert;
DROP TRIGGER legality_rule_provenance_owner_insert;
DROP TRIGGER legality_rule_provenance_owner_update;
DROP TRIGGER legality_rule_scope_valid_insert;
DROP TRIGGER official_source_collection_plan_discovery_owner;
DROP TRIGGER production_release_lease_shape_guard;
DROP TRIGGER production_release_lease_shape_guard_v2;
DROP TRIGGER production_release_lease_sync_from_legacy;
DROP TRIGGER production_release_lease_sync_to_legacy;
DROP TRIGGER production_release_no_rollback_after_migration;
DROP TRIGGER production_release_requested_audit;
DROP TRIGGER production_release_state_audit;
DROP TRIGGER production_release_transition_is_legal;
DROP TRIGGER reconciled_card_erratum_target_is_valid;
DROP TRIGGER reconciled_printing_erratum_target_is_valid;
DROP TRIGGER record_ingestion_transition;
DROP TRIGGER record_initial_ingestion_state;
DROP TRIGGER require_idle_ingestion;
DROP TRIGGER require_recovery_idle_ingestion;
DROP TRIGGER retain_legality_rule_evidence;
DROP TRIGGER retain_product_relationship_evidence;
DROP TRIGGER retain_reconciliation_candidate_evidence;
DROP TRIGGER retain_revision_product_evidence;
DROP TRIGGER retain_updated_product_relationship_evidence;
DROP TRIGGER retained_source_observation_evidence_must_resolve;
DROP TRIGGER revision_card_search_chunks_after_update_fts;
DROP TRIGGER revision_card_search_chunks_before_update_fts;
DROP TRIGGER revision_card_search_chunks_delete_fts;
DROP TRIGGER revision_card_search_chunks_insert_fts;
DROP TRIGGER revision_legality_rule_applicability_insert;
DROP TRIGGER revision_legality_rule_effect_valid_insert;
DROP TRIGGER revision_legality_rule_evidence_projected;
DROP TRIGGER revision_legality_rule_matches_canonical;
DROP TRIGGER revision_legality_rule_scope_valid_insert;
DROP TRIGGER revision_printing_image_content_projected;
DROP TRIGGER guard_active_ingestion_identity;
DROP TRIGGER source_requests_must_match_immutable_plan;

CREATE TRIGGER catalogue_export_deletion_identity_is_immutable
BEFORE UPDATE ON catalogue_export_deletions
WHEN NEW.id <> OLD.id
  OR NEW.plan_id <> OLD.plan_id
  OR NEW.catalogue_revision_id <> OLD.catalogue_revision_id
  OR NEW.manifest_digest <> OLD.manifest_digest
  OR NEW.expected_current_revision_id <> OLD.expected_current_revision_id
  OR NEW.object_set_digest <> OLD.object_set_digest
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.request_json <> OLD.request_json
  OR NEW.requested_at <> OLD.requested_at
  OR (OLD.confirmation_response_json IS NOT NULL
      AND NEW.confirmation_response_json IS NOT OLD.confirmation_response_json)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_transition_invalid');
END;

-- Transition ownership/progress now comes from the retained operation itself
-- and its immutable attempt/request evidence; short search reads indexed chunks.
DROP TABLE ingestion_run_transitions;
DROP TABLE production_release_transitions;
DROP TABLE revision_card_search_terms;
ALTER TABLE operation_state DROP COLUMN active_release_id;
ALTER TABLE operation_state DROP COLUMN active_release_expires_at;

-- Older repair cursors counted chunks plus the removed terms. Restart partial
-- chunk work safely; INSERT OR IGNORE publication makes replay idempotent.
UPDATE catalogue_query_revisions SET repair_term_offset = 0;
ALTER TABLE catalogue_query_revisions RENAME COLUMN repair_term_offset TO repair_chunk_offset;

UPDATE catalogue_schema_state SET migration_level = 11 WHERE singleton = 1;
