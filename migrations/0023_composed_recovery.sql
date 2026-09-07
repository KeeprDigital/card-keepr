SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=22
THEN 1 ELSE json_extract('schema_level_mismatch_expected_22','$') END;

-- Publication's deterministic reservation remains unique by its primary key;
-- later owner backups retain the same native authority without inventing a run.
DROP INDEX catalogue_publication_backup;
CREATE INDEX catalogue_publication_backup ON catalogue_backup_attempts(publication_operation_id);

CREATE TABLE catalogue_recovery_work_classifications (
  recovery_id TEXT NOT NULL REFERENCES catalogue_recovery_operations(id),
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  prior_state TEXT NOT NULL,
  prior_generation INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('published_retained','terminal_retained','abandoned_after_restore')),
  PRIMARY KEY(recovery_id,preparation_id)
);
CREATE TRIGGER catalogue_recovery_classification_immutable BEFORE UPDATE ON catalogue_recovery_work_classifications
BEGIN SELECT RAISE(ABORT,'recovery_classification_immutable'); END;
CREATE TRIGGER catalogue_recovery_classification_retained BEFORE DELETE ON catalogue_recovery_work_classifications
BEGIN SELECT RAISE(ABORT,'recovery_classification_retained'); END;

UPDATE catalogue_schema_state SET migration_level=23 WHERE singleton=1;

-- Guard commits, including already-staged writers, throughout snapshot export and actual recovery.
CREATE TRIGGER recovery_fence_canonical_identity_allocations_insert BEFORE INSERT ON canonical_identity_allocations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_allocations_update BEFORE UPDATE ON canonical_identity_allocations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_allocations_delete BEFORE DELETE ON canonical_identity_allocations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_decisions_insert BEFORE INSERT ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_decisions_update BEFORE UPDATE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_decisions_delete BEFORE DELETE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_review_runs_insert BEFORE INSERT ON canonical_identity_review_runs
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_review_runs_update BEFORE UPDATE ON canonical_identity_review_runs
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_review_runs_delete BEFORE DELETE ON canonical_identity_review_runs
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_reviews_insert BEFORE INSERT ON canonical_identity_reviews
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_reviews_update BEFORE UPDATE ON canonical_identity_reviews
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_reviews_delete BEFORE DELETE ON canonical_identity_reviews
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_source_mappings_insert BEFORE INSERT ON canonical_source_mappings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_source_mappings_update BEFORE UPDATE ON canonical_source_mappings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_source_mappings_delete BEFORE DELETE ON canonical_source_mappings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_composition_games_insert BEFORE INSERT ON catalogue_composition_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_composition_games_update BEFORE UPDATE ON catalogue_composition_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_composition_games_delete BEFORE DELETE ON catalogue_composition_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_curated_provenance_insert BEFORE INSERT ON catalogue_curated_provenance
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_curated_provenance_update BEFORE UPDATE ON catalogue_curated_provenance
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_curated_provenance_delete BEFORE DELETE ON catalogue_curated_provenance
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_plans_insert BEFORE INSERT ON catalogue_export_deletion_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_plans_update BEFORE UPDATE ON catalogue_export_deletion_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_plans_delete BEFORE DELETE ON catalogue_export_deletion_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_retries_insert BEFORE INSERT ON catalogue_export_deletion_retries
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_retries_update BEFORE UPDATE ON catalogue_export_deletion_retries
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_retries_delete BEFORE DELETE ON catalogue_export_deletion_retries
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_tombstones_insert BEFORE INSERT ON catalogue_export_deletion_tombstones
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_tombstones_update BEFORE UPDATE ON catalogue_export_deletion_tombstones
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletion_tombstones_delete BEFORE DELETE ON catalogue_export_deletion_tombstones
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletions_insert BEFORE INSERT ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletions_update BEFORE UPDATE ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_export_deletions_delete BEFORE DELETE ON catalogue_export_deletions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_exports_insert BEFORE INSERT ON catalogue_exports
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_exports_update BEFORE UPDATE ON catalogue_exports
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_exports_delete BEFORE DELETE ON catalogue_exports
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_query_revisions_insert BEFORE INSERT ON catalogue_query_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_query_revisions_update BEFORE UPDATE ON catalogue_query_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_query_revisions_delete BEFORE DELETE ON catalogue_query_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_revisions_insert BEFORE INSERT ON catalogue_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_revisions_update BEFORE UPDATE ON catalogue_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_revisions_delete BEFORE DELETE ON catalogue_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revision_events_insert BEFORE INSERT ON curated_revision_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revision_events_update BEFORE UPDATE ON curated_revision_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revision_events_delete BEFORE DELETE ON curated_revision_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revision_idempotency_insert BEFORE INSERT ON curated_revision_idempotency
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revision_idempotency_update BEFORE UPDATE ON curated_revision_idempotency
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revision_idempotency_delete BEFORE DELETE ON curated_revision_idempotency
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revisions_insert BEFORE INSERT ON curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revisions_update BEFORE UPDATE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_curated_revisions_delete BEFORE DELETE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_decisions_insert BEFORE INSERT ON entity_admission_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_decisions_update BEFORE UPDATE ON entity_admission_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_decisions_delete BEFORE DELETE ON entity_admission_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_events_insert BEFORE INSERT ON entity_admission_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_events_update BEFORE UPDATE ON entity_admission_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_events_delete BEFORE DELETE ON entity_admission_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_pinned_decisions_insert BEFORE INSERT ON entity_admission_pinned_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_pinned_decisions_update BEFORE UPDATE ON entity_admission_pinned_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_pinned_decisions_delete BEFORE DELETE ON entity_admission_pinned_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_run_pins_insert BEFORE INSERT ON entity_admission_run_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_run_pins_update BEFORE UPDATE ON entity_admission_run_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_admission_run_pins_delete BEFORE DELETE ON entity_admission_run_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_proposal_source_evidence_insert BEFORE INSERT ON entity_proposal_source_evidence
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_proposal_source_evidence_update BEFORE UPDATE ON entity_proposal_source_evidence
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_proposal_source_evidence_delete BEFORE DELETE ON entity_proposal_source_evidence
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_proposals_insert BEFORE INSERT ON entity_proposals
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_proposals_update BEFORE UPDATE ON entity_proposals
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_entity_proposals_delete BEFORE DELETE ON entity_proposals
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_erratum_provenance_insert BEFORE INSERT ON erratum_provenance
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_erratum_provenance_update BEFORE UPDATE ON erratum_provenance
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_erratum_provenance_delete BEFORE DELETE ON erratum_provenance
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_entity_scopes_insert BEFORE INSERT ON game_candidate_entity_scopes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_entity_scopes_update BEFORE UPDATE ON game_candidate_entity_scopes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_entity_scopes_delete BEFORE DELETE ON game_candidate_entity_scopes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_partitions_insert BEFORE INSERT ON game_candidate_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_partitions_update BEFORE UPDATE ON game_candidate_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_partitions_delete BEFORE DELETE ON game_candidate_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_slots_insert BEFORE INSERT ON game_candidate_slots
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_slots_update BEFORE UPDATE ON game_candidate_slots
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_slots_delete BEFORE DELETE ON game_candidate_slots
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked') AND NOT EXISTS(SELECT 1 FROM catalogue_recovery_work_classifications w JOIN operation_state o ON o.active_recovery_id=w.recovery_id JOIN catalogue_recovery_operations r ON r.id=w.recovery_id WHERE w.preparation_id=OLD.preparation_id AND w.classification='abandoned_after_restore' AND r.state IN ('awaiting_acceptance','accepted'))
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidates_insert BEFORE INSERT ON game_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidates_update BEFORE UPDATE ON game_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked') AND NOT (NEW.state='abandoned' AND NEW.generation=OLD.generation+1 AND EXISTS(SELECT 1 FROM catalogue_recovery_work_classifications w JOIN operation_state o ON o.active_recovery_id=w.recovery_id JOIN catalogue_recovery_operations r ON r.id=w.recovery_id WHERE w.preparation_id=NEW.preparation_id AND w.classification='abandoned_after_restore' AND r.state IN ('awaiting_acceptance','accepted')))
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidates_delete BEFORE DELETE ON game_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_catalogue_heads_insert BEFORE INSERT ON game_catalogue_heads
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_catalogue_heads_update BEFORE UPDATE ON game_catalogue_heads
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_catalogue_heads_delete BEFORE DELETE ON game_catalogue_heads
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_publication_actions_insert BEFORE INSERT ON game_publication_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_publication_actions_update BEFORE UPDATE ON game_publication_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_publication_actions_delete BEFORE DELETE ON game_publication_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_publication_operations_insert BEFORE INSERT ON game_publication_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_publication_operations_update BEFORE UPDATE ON game_publication_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked') AND NOT (NEW.state='failed' AND NEW.generation=OLD.generation+1 AND EXISTS(SELECT 1 FROM catalogue_recovery_work_classifications w JOIN operation_state o ON o.active_recovery_id=w.recovery_id JOIN catalogue_recovery_operations r ON r.id=w.recovery_id WHERE w.preparation_id=(SELECT preparation_id FROM game_candidates WHERE id=NEW.candidate_id) AND w.classification='abandoned_after_restore' AND r.state IN ('awaiting_acceptance','accepted')))
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_publication_operations_delete BEFORE DELETE ON game_publication_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_reconciliation_requests_insert BEFORE INSERT ON game_reconciliation_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_reconciliation_requests_update BEFORE UPDATE ON game_reconciliation_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_game_reconciliation_requests_delete BEFORE DELETE ON game_reconciliation_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_identity_correction_decisions_insert BEFORE INSERT ON identity_correction_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_identity_correction_decisions_update BEFORE UPDATE ON identity_correction_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_identity_correction_decisions_delete BEFORE DELETE ON identity_correction_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_identity_correction_run_pins_insert BEFORE INSERT ON identity_correction_run_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_identity_correction_run_pins_update BEFORE UPDATE ON identity_correction_run_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_identity_correction_run_pins_delete BEFORE DELETE ON identity_correction_run_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_collection_completions_insert BEFORE INSERT ON ingestion_collection_completions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_collection_completions_update BEFORE UPDATE ON ingestion_collection_completions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_collection_completions_delete BEFORE DELETE ON ingestion_collection_completions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_collection_reservations_insert BEFORE INSERT ON ingestion_collection_reservations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_collection_reservations_update BEFORE UPDATE ON ingestion_collection_reservations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_collection_reservations_delete BEFORE DELETE ON ingestion_collection_reservations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked') AND NOT EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications w JOIN operation_state o ON o.active_recovery_id=w.recovery_id JOIN catalogue_recovery_operations r ON r.id=w.recovery_id WHERE w.ingestion_run_id=OLD.ingestion_run_id AND w.classification='abandoned_after_restore' AND r.state IN ('awaiting_acceptance','accepted'))
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_evidence_plans_insert BEFORE INSERT ON ingestion_evidence_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_evidence_plans_update BEFORE UPDATE ON ingestion_evidence_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_evidence_plans_delete BEFORE DELETE ON ingestion_evidence_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_no_change_results_insert BEFORE INSERT ON ingestion_no_change_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_no_change_results_update BEFORE UPDATE ON ingestion_no_change_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_no_change_results_delete BEFORE DELETE ON ingestion_no_change_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_publication_cleanup_insert BEFORE INSERT ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_publication_cleanup_update BEFORE UPDATE ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_publication_cleanup_delete BEFORE DELETE ON ingestion_publication_cleanup
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_capacity_extensions_insert BEFORE INSERT ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_capacity_extensions_update BEFORE UPDATE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_capacity_extensions_delete BEFORE DELETE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_capacity_pauses_insert BEFORE INSERT ON ingestion_run_capacity_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_capacity_pauses_update BEFORE UPDATE ON ingestion_run_capacity_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_capacity_pauses_delete BEFORE DELETE ON ingestion_run_capacity_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_curated_revision_sets_insert BEFORE INSERT ON ingestion_run_curated_revision_sets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_curated_revision_sets_update BEFORE UPDATE ON ingestion_run_curated_revision_sets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_curated_revision_sets_delete BEFORE DELETE ON ingestion_run_curated_revision_sets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_curated_revisions_insert BEFORE INSERT ON ingestion_run_curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_curated_revisions_update BEFORE UPDATE ON ingestion_run_curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_curated_revisions_delete BEFORE DELETE ON ingestion_run_curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_current_insert BEFORE INSERT ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_current_update BEFORE UPDATE ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_current_delete BEFORE DELETE ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_event_payload_chunks_insert BEFORE INSERT ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_event_payload_chunks_update BEFORE UPDATE ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_event_payload_chunks_delete BEFORE DELETE ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_events_insert BEFORE INSERT ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_events_update BEFORE UPDATE ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_events_delete BEFORE DELETE ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_retry_pauses_insert BEFORE INSERT ON ingestion_run_retry_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_retry_pauses_update BEFORE UPDATE ON ingestion_run_retry_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_retry_pauses_delete BEFORE DELETE ON ingestion_run_retry_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_selected_games_insert BEFORE INSERT ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_selected_games_update BEFORE UPDATE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_selected_games_delete BEFORE DELETE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_terminations_insert BEFORE INSERT ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_terminations_update BEFORE UPDATE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_terminations_delete BEFORE DELETE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_workflow_pauses_insert BEFORE INSERT ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_workflow_pauses_update BEFORE UPDATE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_workflow_pauses_delete BEFORE DELETE ON ingestion_run_workflow_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_runs_insert BEFORE INSERT ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_runs_update BEFORE UPDATE ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_runs_delete BEFORE DELETE ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_workflow_attempts_insert BEFORE INSERT ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_workflow_attempts_update BEFORE UPDATE ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_workflow_attempts_delete BEFORE DELETE ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_workflow_progress_insert BEFORE INSERT ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_workflow_progress_update BEFORE UPDATE ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_workflow_progress_delete BEFORE DELETE ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_official_source_collection_plans_insert BEFORE INSERT ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_official_source_collection_plans_update BEFORE UPDATE ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_official_source_collection_plans_delete BEFORE DELETE ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_composition_nodes_insert BEFORE INSERT ON publication_composition_nodes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_composition_nodes_update BEFORE UPDATE ON publication_composition_nodes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_composition_nodes_delete BEFORE DELETE ON publication_composition_nodes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparation_actions_insert BEFORE INSERT ON publication_preparation_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparation_actions_update BEFORE UPDATE ON publication_preparation_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparation_actions_delete BEFORE DELETE ON publication_preparation_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparation_artifacts_insert BEFORE INSERT ON publication_preparation_artifacts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparation_artifacts_update BEFORE UPDATE ON publication_preparation_artifacts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparation_artifacts_delete BEFORE DELETE ON publication_preparation_artifacts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparations_insert BEFORE INSERT ON publication_preparations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparations_update BEFORE UPDATE ON publication_preparations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_preparations_delete BEFORE DELETE ON publication_preparations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_projection_batches_insert BEFORE INSERT ON publication_projection_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_projection_batches_update BEFORE UPDATE ON publication_projection_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_projection_batches_delete BEFORE DELETE ON publication_projection_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_query_documents_insert BEFORE INSERT ON publication_query_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_query_documents_update BEFORE UPDATE ON publication_query_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_query_documents_delete BEFORE DELETE ON publication_query_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_search_chunks_insert BEFORE INSERT ON publication_search_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_search_chunks_update BEFORE UPDATE ON publication_search_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_search_chunks_delete BEFORE DELETE ON publication_search_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_workflow_budgets_insert BEFORE INSERT ON publication_workflow_budgets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_workflow_budgets_update BEFORE UPDATE ON publication_workflow_budgets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_workflow_budgets_delete BEFORE DELETE ON publication_workflow_budgets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_card_observations_insert BEFORE INSERT ON reconciled_card_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_card_observations_update BEFORE UPDATE ON reconciled_card_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_card_observations_delete BEFORE DELETE ON reconciled_card_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_cards_insert BEFORE INSERT ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_cards_update BEFORE UPDATE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_cards_delete BEFORE DELETE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_distribution_contexts_insert BEFORE INSERT ON reconciled_distribution_contexts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_distribution_contexts_update BEFORE UPDATE ON reconciled_distribution_contexts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_distribution_contexts_delete BEFORE DELETE ON reconciled_distribution_contexts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_errata_insert BEFORE INSERT ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_errata_update BEFORE UPDATE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_errata_delete BEFORE DELETE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_images_insert BEFORE INSERT ON reconciled_printing_images
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_images_update BEFORE UPDATE ON reconciled_printing_images
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_images_delete BEFORE DELETE ON reconciled_printing_images
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_locators_insert BEFORE INSERT ON reconciled_printing_locators
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_locators_update BEFORE UPDATE ON reconciled_printing_locators
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_locators_delete BEFORE DELETE ON reconciled_printing_locators
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_memberships_insert BEFORE INSERT ON reconciled_printing_memberships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_memberships_update BEFORE UPDATE ON reconciled_printing_memberships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printing_memberships_delete BEFORE DELETE ON reconciled_printing_memberships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printings_insert BEFORE INSERT ON reconciled_printings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printings_update BEFORE UPDATE ON reconciled_printings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_printings_delete BEFORE DELETE ON reconciled_printings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_product_relationships_insert BEFORE INSERT ON reconciled_product_relationships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_product_relationships_update BEFORE UPDATE ON reconciled_product_relationships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_product_relationships_delete BEFORE DELETE ON reconciled_product_relationships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_products_insert BEFORE INSERT ON reconciled_products
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_products_update BEFORE UPDATE ON reconciled_products
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_products_delete BEFORE DELETE ON reconciled_products
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_releases_insert BEFORE INSERT ON reconciled_releases
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_releases_update BEFORE UPDATE ON reconciled_releases
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_releases_delete BEFORE DELETE ON reconciled_releases
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_withdrawal_assertions_insert BEFORE INSERT ON reconciled_withdrawal_assertions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_withdrawal_assertions_update BEFORE UPDATE ON reconciled_withdrawal_assertions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_withdrawal_assertions_delete BEFORE DELETE ON reconciled_withdrawal_assertions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_actions_insert BEFORE INSERT ON reconciliation_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_actions_update BEFORE UPDATE ON reconciliation_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_actions_delete BEFORE DELETE ON reconciliation_actions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_admission_decisions_insert BEFORE INSERT ON reconciliation_admission_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_admission_decisions_update BEFORE UPDATE ON reconciliation_admission_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_admission_decisions_delete BEFORE DELETE ON reconciliation_admission_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_admission_pins_insert BEFORE INSERT ON reconciliation_admission_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_admission_pins_update BEFORE UPDATE ON reconciliation_admission_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_admission_pins_delete BEFORE DELETE ON reconciliation_admission_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_automatic_admissions_insert BEFORE INSERT ON reconciliation_automatic_admissions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_automatic_admissions_update BEFORE UPDATE ON reconciliation_automatic_admissions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_automatic_admissions_delete BEFORE DELETE ON reconciliation_automatic_admissions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_candidates_insert BEFORE INSERT ON reconciliation_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_candidates_update BEFORE UPDATE ON reconciliation_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_candidates_delete BEFORE DELETE ON reconciliation_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_canonical_bytes_insert BEFORE INSERT ON reconciliation_canonical_bytes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_canonical_bytes_update BEFORE UPDATE ON reconciliation_canonical_bytes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_canonical_bytes_delete BEFORE DELETE ON reconciliation_canonical_bytes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_checkpoints_insert BEFORE INSERT ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_checkpoints_update BEFORE UPDATE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_checkpoints_delete BEFORE DELETE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_contexts_insert BEFORE INSERT ON reconciliation_contexts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_contexts_update BEFORE UPDATE ON reconciliation_contexts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_contexts_delete BEFORE DELETE ON reconciliation_contexts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_correction_pins_insert BEFORE INSERT ON reconciliation_correction_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_correction_pins_update BEFORE UPDATE ON reconciliation_correction_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_correction_pins_delete BEFORE DELETE ON reconciliation_correction_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_curated_conflicts_insert BEFORE INSERT ON reconciliation_curated_conflicts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_curated_conflicts_update BEFORE UPDATE ON reconciliation_curated_conflicts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_curated_conflicts_delete BEFORE DELETE ON reconciliation_curated_conflicts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_curated_pins_insert BEFORE INSERT ON reconciliation_curated_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_curated_pins_update BEFORE UPDATE ON reconciliation_curated_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_curated_pins_delete BEFORE DELETE ON reconciliation_curated_pins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_evidence_partitions_insert BEFORE INSERT ON reconciliation_evidence_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_evidence_partitions_update BEFORE UPDATE ON reconciliation_evidence_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_evidence_partitions_delete BEFORE DELETE ON reconciliation_evidence_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_evidence_selection_insert BEFORE INSERT ON reconciliation_evidence_selection
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_evidence_selection_update BEFORE UPDATE ON reconciliation_evidence_selection
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_evidence_selection_delete BEFORE DELETE ON reconciliation_evidence_selection
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_identity_reviews_insert BEFORE INSERT ON reconciliation_identity_reviews
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_identity_reviews_update BEFORE UPDATE ON reconciliation_identity_reviews
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_identity_reviews_delete BEFORE DELETE ON reconciliation_identity_reviews
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_input_partitions_insert BEFORE INSERT ON reconciliation_input_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_input_partitions_update BEFORE UPDATE ON reconciliation_input_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_input_partitions_delete BEFORE DELETE ON reconciliation_input_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_normalized_observations_insert BEFORE INSERT ON reconciliation_normalized_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_normalized_observations_update BEFORE UPDATE ON reconciliation_normalized_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_normalized_observations_delete BEFORE DELETE ON reconciliation_normalized_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_observation_origins_insert BEFORE INSERT ON reconciliation_observation_origins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_observation_origins_update BEFORE UPDATE ON reconciliation_observation_origins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_observation_origins_delete BEFORE DELETE ON reconciliation_observation_origins
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_operations_insert BEFORE INSERT ON reconciliation_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_operations_update BEFORE UPDATE ON reconciliation_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked') AND NOT (NEW.state='abandoned' AND NEW.generation=OLD.generation+1 AND EXISTS(SELECT 1 FROM catalogue_recovery_work_classifications w JOIN operation_state o ON o.active_recovery_id=w.recovery_id JOIN catalogue_recovery_operations r ON r.id=w.recovery_id WHERE w.preparation_id=NEW.id AND w.classification='abandoned_after_restore' AND r.state IN ('awaiting_acceptance','accepted')))
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_operations_delete BEFORE DELETE ON reconciliation_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_payload_chunks_insert BEFORE INSERT ON reconciliation_payload_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_payload_chunks_update BEFORE UPDATE ON reconciliation_payload_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_payload_chunks_delete BEFORE DELETE ON reconciliation_payload_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_preparation_batches_insert BEFORE INSERT ON reconciliation_preparation_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_preparation_batches_update BEFORE UPDATE ON reconciliation_preparation_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_preparation_batches_delete BEFORE DELETE ON reconciliation_preparation_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_record_partitions_insert BEFORE INSERT ON reconciliation_record_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_record_partitions_update BEFORE UPDATE ON reconciliation_record_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_record_partitions_delete BEFORE DELETE ON reconciliation_record_partitions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_reducer_state_insert BEFORE INSERT ON reconciliation_reducer_state
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_reducer_state_update BEFORE UPDATE ON reconciliation_reducer_state
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_reducer_state_delete BEFORE DELETE ON reconciliation_reducer_state
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_sort_batches_insert BEFORE INSERT ON reconciliation_sort_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_sort_batches_update BEFORE UPDATE ON reconciliation_sort_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_sort_batches_delete BEFORE DELETE ON reconciliation_sort_batches
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_byte_chunks_insert BEFORE INSERT ON reconciliation_source_byte_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_byte_chunks_update BEFORE UPDATE ON reconciliation_source_byte_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_byte_chunks_delete BEFORE DELETE ON reconciliation_source_byte_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_documents_insert BEFORE INSERT ON reconciliation_source_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_documents_update BEFORE UPDATE ON reconciliation_source_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_documents_delete BEFORE DELETE ON reconciliation_source_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_mappings_insert BEFORE INSERT ON reconciliation_source_mappings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_mappings_update BEFORE UPDATE ON reconciliation_source_mappings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_mappings_delete BEFORE DELETE ON reconciliation_source_mappings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_observations_insert BEFORE INSERT ON reconciliation_source_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_observations_update BEFORE UPDATE ON reconciliation_source_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_source_observations_delete BEFORE DELETE ON reconciliation_source_observations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_terminal_results_insert BEFORE INSERT ON reconciliation_terminal_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_terminal_results_update BEFORE UPDATE ON reconciliation_terminal_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_terminal_results_delete BEFORE DELETE ON reconciliation_terminal_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_text_chunks_insert BEFORE INSERT ON reconciliation_text_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_text_chunks_update BEFORE UPDATE ON reconciliation_text_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_text_chunks_delete BEFORE DELETE ON reconciliation_text_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_workflow_budgets_insert BEFORE INSERT ON reconciliation_workflow_budgets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_workflow_budgets_update BEFORE UPDATE ON reconciliation_workflow_budgets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_workflow_budgets_delete BEFORE DELETE ON reconciliation_workflow_budgets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_workflow_requests_insert BEFORE INSERT ON reconciliation_workflow_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_workflow_requests_update BEFORE UPDATE ON reconciliation_workflow_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciliation_workflow_requests_delete BEFORE DELETE ON reconciliation_workflow_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_retained_source_observation_evidence_insert BEFORE INSERT ON retained_source_observation_evidence
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_retained_source_observation_evidence_update BEFORE UPDATE ON retained_source_observation_evidence
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_retained_source_observation_evidence_delete BEFORE DELETE ON retained_source_observation_evidence
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_attributes_insert BEFORE INSERT ON revision_card_attributes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_attributes_update BEFORE UPDATE ON revision_card_attributes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_attributes_delete BEFORE DELETE ON revision_card_attributes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_query_documents_insert BEFORE INSERT ON revision_card_query_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_query_documents_update BEFORE UPDATE ON revision_card_query_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_query_documents_delete BEFORE DELETE ON revision_card_query_documents
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_search_chunks_insert BEFORE INSERT ON revision_card_search_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_search_chunks_update BEFORE UPDATE ON revision_card_search_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_card_search_chunks_delete BEFORE DELETE ON revision_card_search_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_cards_insert BEFORE INSERT ON revision_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_cards_update BEFORE UPDATE ON revision_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_cards_delete BEFORE DELETE ON revision_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_errata_insert BEFORE INSERT ON revision_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_errata_update BEFORE UPDATE ON revision_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_errata_delete BEFORE DELETE ON revision_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_identity_corrections_insert BEFORE INSERT ON revision_identity_corrections
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_identity_corrections_update BEFORE UPDATE ON revision_identity_corrections
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_identity_corrections_delete BEFORE DELETE ON revision_identity_corrections
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_images_insert BEFORE INSERT ON revision_printing_images
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_images_update BEFORE UPDATE ON revision_printing_images
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_images_delete BEFORE DELETE ON revision_printing_images
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_product_query_insert BEFORE INSERT ON revision_printing_product_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_product_query_update BEFORE UPDATE ON revision_printing_product_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_product_query_delete BEFORE DELETE ON revision_printing_product_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_query_insert BEFORE INSERT ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_query_update BEFORE UPDATE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_query_delete BEFORE DELETE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printings_insert BEFORE INSERT ON revision_printings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printings_update BEFORE UPDATE ON revision_printings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printings_delete BEFORE DELETE ON revision_printings
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_product_relationships_insert BEFORE INSERT ON revision_product_relationships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_product_relationships_update BEFORE UPDATE ON revision_product_relationships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_product_relationships_delete BEFORE DELETE ON revision_product_relationships
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_products_insert BEFORE INSERT ON revision_products
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_products_update BEFORE UPDATE ON revision_products
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_products_delete BEFORE DELETE ON revision_products
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_adapter_versions_insert BEFORE INSERT ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_adapter_versions_update BEFORE UPDATE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_adapter_versions_delete BEFORE DELETE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_authority_decisions_insert BEFORE INSERT ON source_authority_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_authority_decisions_update BEFORE UPDATE ON source_authority_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_authority_decisions_delete BEFORE DELETE ON source_authority_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_capture_operations_insert BEFORE INSERT ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_capture_operations_update BEFORE UPDATE ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_capture_operations_delete BEFORE DELETE ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_discovery_request_plans_insert BEFORE INSERT ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_discovery_request_plans_update BEFORE UPDATE ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_discovery_request_plans_delete BEFORE DELETE ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_fetch_attempts_insert BEFORE INSERT ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_fetch_attempts_update BEFORE UPDATE ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_fetch_attempts_delete BEFORE DELETE ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_freshness_insert BEFORE INSERT ON source_freshness
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_freshness_update BEFORE UPDATE ON source_freshness
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_freshness_delete BEFORE DELETE ON source_freshness
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_host_pacing_insert BEFORE INSERT ON source_host_pacing
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_host_pacing_update BEFORE UPDATE ON source_host_pacing
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_host_pacing_delete BEFORE DELETE ON source_host_pacing
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_lifecycle_decisions_insert BEFORE INSERT ON source_lifecycle_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_lifecycle_decisions_update BEFORE UPDATE ON source_lifecycle_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_lifecycle_decisions_delete BEFORE DELETE ON source_lifecycle_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_observation_sets_insert BEFORE INSERT ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_observation_sets_update BEFORE UPDATE ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_observation_sets_delete BEFORE DELETE ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_parse_operations_insert BEFORE INSERT ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_parse_operations_update BEFORE UPDATE ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_parse_operations_delete BEFORE DELETE ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_requests_insert BEFORE INSERT ON source_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_requests_update BEFORE UPDATE ON source_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_requests_delete BEFORE DELETE ON source_requests
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_snapshots_insert BEFORE INSERT ON source_snapshots
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_snapshots_update BEFORE UPDATE ON source_snapshots
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_source_snapshots_delete BEFORE DELETE ON source_snapshots
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_verified_publication_compositions_insert BEFORE INSERT ON verified_publication_compositions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_verified_publication_compositions_update BEFORE UPDATE ON verified_publication_compositions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_verified_publication_compositions_delete BEFORE DELETE ON verified_publication_compositions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_entities_insert BEFORE INSERT ON publication_read_entities
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_entities_update BEFORE UPDATE ON publication_read_entities
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_entities_delete BEFORE DELETE ON publication_read_entities
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_attributes_insert BEFORE INSERT ON publication_read_attributes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_attributes_update BEFORE UPDATE ON publication_read_attributes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_attributes_delete BEFORE DELETE ON publication_read_attributes
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_release_regions_insert BEFORE INSERT ON publication_read_release_regions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_release_regions_update BEFORE UPDATE ON publication_read_release_regions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_release_regions_delete BEFORE DELETE ON publication_read_release_regions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_text_chunks_insert BEFORE INSERT ON publication_read_text_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_text_chunks_update BEFORE UPDATE ON publication_read_text_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_publication_read_text_chunks_delete BEFORE DELETE ON publication_read_text_chunks
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TABLE catalogue_recovery_collection_classifications (
 recovery_id TEXT NOT NULL REFERENCES catalogue_recovery_operations(id),
 ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
 prior_state TEXT NOT NULL,
 classification TEXT NOT NULL CHECK(classification IN ('retained_source','abandoned_after_restore')),
 PRIMARY KEY(recovery_id,ingestion_run_id)
);
CREATE TRIGGER recovery_collection_classification_immutable BEFORE UPDATE ON catalogue_recovery_collection_classifications
BEGIN SELECT RAISE(ABORT,'recovery_classification_immutable'); END;
CREATE TRIGGER recovery_collection_classification_retained BEFORE DELETE ON catalogue_recovery_collection_classifications
BEGIN SELECT RAISE(ABORT,'recovery_classification_retained'); END;
CREATE TRIGGER restored_collector_fence_ingestion_runs_insert BEFORE INSERT ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_runs_update BEFORE UPDATE ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_runs_delete BEFORE DELETE ON ingestion_runs
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_current_insert BEFORE INSERT ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_current_update BEFORE UPDATE ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_current_delete BEFORE DELETE ON ingestion_run_current
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_events_insert BEFORE INSERT ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_events_update BEFORE UPDATE ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_events_delete BEFORE DELETE ON ingestion_run_events
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_event_payload_chunks_insert BEFORE INSERT ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_event_payload_chunks_update BEFORE UPDATE ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_run_event_payload_chunks_delete BEFORE DELETE ON ingestion_run_event_payload_chunks
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_workflow_attempts_insert BEFORE INSERT ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_workflow_attempts_update BEFORE UPDATE ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_workflow_attempts_delete BEFORE DELETE ON ingestion_workflow_attempts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_requests_insert BEFORE INSERT ON source_requests
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_requests_update BEFORE UPDATE ON source_requests
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_requests_delete BEFORE DELETE ON source_requests
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_fetch_attempts_insert BEFORE INSERT ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_fetch_attempts_update BEFORE UPDATE ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_fetch_attempts_delete BEFORE DELETE ON source_fetch_attempts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_snapshots_insert BEFORE INSERT ON source_snapshots
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_snapshots_update BEFORE UPDATE ON source_snapshots
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_snapshots_delete BEFORE DELETE ON source_snapshots
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_capture_operations_insert BEFORE INSERT ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_capture_operations_update BEFORE UPDATE ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_capture_operations_delete BEFORE DELETE ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_official_source_collection_plans_insert BEFORE INSERT ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_official_source_collection_plans_update BEFORE UPDATE ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_official_source_collection_plans_delete BEFORE DELETE ON official_source_collection_plans
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_discovery_request_plans_insert BEFORE INSERT ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_discovery_request_plans_update BEFORE UPDATE ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_discovery_request_plans_delete BEFORE DELETE ON source_discovery_request_plans
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_workflow_progress_insert BEFORE INSERT ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM ingestion_workflow_attempts WHERE workflow_instance_id=NEW.workflow_instance_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_workflow_progress_update BEFORE UPDATE ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM ingestion_workflow_attempts WHERE workflow_instance_id=NEW.workflow_instance_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_ingestion_workflow_progress_delete BEFORE DELETE ON ingestion_workflow_progress
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM ingestion_workflow_attempts WHERE workflow_instance_id=OLD.workflow_instance_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_parse_operations_insert BEFORE INSERT ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_parse_operations_update BEFORE UPDATE ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_parse_operations_delete BEFORE DELETE ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=OLD.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_observation_sets_insert BEFORE INSERT ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_observation_sets_update BEFORE UPDATE ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=NEW.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER restored_collector_fence_source_observation_sets_delete BEFORE DELETE ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_snapshots WHERE id=OLD.source_snapshot_id) AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
