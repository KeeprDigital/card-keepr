SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=30
THEN 1 ELSE json_extract('schema_level_mismatch_expected_30','$') END;

-- A sealed semantic receipt is distinct from the exact owner-review manifest.
CREATE TABLE game_candidate_semantic_receipts (
 candidate_id TEXT PRIMARY KEY REFERENCES game_candidates(id),
 manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64)
);
CREATE TABLE game_candidate_predecessors (
 candidate_id TEXT PRIMARY KEY REFERENCES game_candidates(id),
 predecessor_candidate_id TEXT REFERENCES game_candidates(id)
);
CREATE TABLE game_accepted_candidates (
 supported_game TEXT PRIMARY KEY REFERENCES game_catalogue_heads(supported_game),
 candidate_id TEXT NOT NULL REFERENCES game_candidates(id)
);
CREATE TABLE catalogue_acceptance_head (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 publication_operation_id TEXT NOT NULL REFERENCES game_publication_operations(id)
);

-- Existing immutable composition members are their current accepted evidence.
INSERT INTO game_accepted_candidates
 SELECT supported_game,candidate_id FROM catalogue_composition_games
 WHERE catalogue_revision_id=(SELECT current_revision_id FROM catalogue_state WHERE singleton=1);
INSERT INTO game_candidate_predecessors
 SELECT candidate.id,member.candidate_id FROM game_candidates candidate
 LEFT JOIN catalogue_composition_games member ON member.catalogue_revision_id=candidate.expected_game_revision_id
 AND member.supported_game=candidate.supported_game WHERE candidate.preparation_id=candidate.id;
INSERT INTO catalogue_acceptance_head
 SELECT 1,publication_operation_id FROM catalogue_revisions
 WHERE id=(SELECT current_revision_id FROM catalogue_state WHERE singleton=1) AND publication_operation_id IS NOT NULL;

-- Several accepted candidates may refer to one unchanged consumer revision.
-- Rebuild only this binding table; consumer revisions and composition stay immutable.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE candidate_publication_binding_copy AS SELECT * FROM catalogue_candidate_publications;
DROP TABLE catalogue_candidate_publications;
CREATE TABLE catalogue_candidate_publications (
 candidate_id TEXT PRIMARY KEY REFERENCES game_candidates(id),
 catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id)
);
INSERT INTO catalogue_candidate_publications SELECT * FROM candidate_publication_binding_copy;
DROP TABLE candidate_publication_binding_copy;
CREATE INDEX catalogue_candidate_publications_revision ON catalogue_candidate_publications(catalogue_revision_id);
CREATE TRIGGER catalogue_candidate_publications_no_update BEFORE UPDATE ON catalogue_candidate_publications
BEGIN SELECT RAISE(ABORT,'published_candidate_binding_immutable'); END;
CREATE TRIGGER catalogue_candidate_publications_no_delete BEFORE DELETE ON catalogue_candidate_publications
BEGIN SELECT RAISE(ABORT,'published_candidate_binding_retained'); END;
CREATE TRIGGER game_candidate_semantic_receipts_no_update BEFORE UPDATE ON game_candidate_semantic_receipts
BEGIN SELECT RAISE(ABORT,'accepted_candidate_receipt_immutable'); END;
CREATE TRIGGER game_candidate_semantic_receipts_no_delete BEFORE DELETE ON game_candidate_semantic_receipts
BEGIN SELECT RAISE(ABORT,'accepted_candidate_receipt_immutable'); END;
CREATE TRIGGER game_candidate_predecessors_no_update BEFORE UPDATE ON game_candidate_predecessors
BEGIN SELECT RAISE(ABORT,'accepted_candidate_receipt_immutable'); END;
CREATE TRIGGER game_candidate_predecessors_no_delete BEFORE DELETE ON game_candidate_predecessors
BEGIN SELECT RAISE(ABORT,'accepted_candidate_receipt_immutable'); END;
CREATE TRIGGER game_accepted_candidates_no_delete BEFORE DELETE ON game_accepted_candidates
BEGIN SELECT RAISE(ABORT,'accepted_candidate_head_retained'); END;
CREATE TRIGGER catalogue_acceptance_head_no_delete BEFORE DELETE ON catalogue_acceptance_head
BEGIN SELECT RAISE(ABORT,'accepted_candidate_head_retained'); END;
CREATE TRIGGER recovery_fence_catalogue_candidate_publications_insert BEFORE INSERT ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_candidate_publications_insert BEFORE INSERT ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_candidate_publications_update BEFORE UPDATE ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_candidate_publications_update BEFORE UPDATE ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_candidate_publications_delete BEFORE DELETE ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_candidate_publications_delete BEFORE DELETE ON catalogue_candidate_publications
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_semantic_receipts_insert BEFORE INSERT ON game_candidate_semantic_receipts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_semantic_receipts_insert BEFORE INSERT ON game_candidate_semantic_receipts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_semantic_receipts_update BEFORE UPDATE ON game_candidate_semantic_receipts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_semantic_receipts_update BEFORE UPDATE ON game_candidate_semantic_receipts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_semantic_receipts_delete BEFORE DELETE ON game_candidate_semantic_receipts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_semantic_receipts_delete BEFORE DELETE ON game_candidate_semantic_receipts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_predecessors_insert BEFORE INSERT ON game_candidate_predecessors
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_predecessors_insert BEFORE INSERT ON game_candidate_predecessors
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_predecessors_update BEFORE UPDATE ON game_candidate_predecessors
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_predecessors_update BEFORE UPDATE ON game_candidate_predecessors
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_candidate_predecessors_delete BEFORE DELETE ON game_candidate_predecessors
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_candidate_predecessors_delete BEFORE DELETE ON game_candidate_predecessors
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_accepted_candidates_insert BEFORE INSERT ON game_accepted_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_accepted_candidates_insert BEFORE INSERT ON game_accepted_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_accepted_candidates_update BEFORE UPDATE ON game_accepted_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_accepted_candidates_update BEFORE UPDATE ON game_accepted_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_game_accepted_candidates_delete BEFORE DELETE ON game_accepted_candidates
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_game_accepted_candidates_delete BEFORE DELETE ON game_accepted_candidates
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_acceptance_head_insert BEFORE INSERT ON catalogue_acceptance_head
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_acceptance_head_insert BEFORE INSERT ON catalogue_acceptance_head
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_acceptance_head_update BEFORE UPDATE ON catalogue_acceptance_head
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_acceptance_head_update BEFORE UPDATE ON catalogue_acceptance_head
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER recovery_fence_catalogue_acceptance_head_delete BEFORE DELETE ON catalogue_acceptance_head
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_catalogue_acceptance_head_delete BEFORE DELETE ON catalogue_acceptance_head
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
UPDATE catalogue_schema_state SET migration_level=31 WHERE singleton=1;
