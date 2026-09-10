SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=31
THEN 1 ELSE json_extract('schema_level_mismatch_expected_31','$') END;

-- The implicit rowid suffix gives each review an indexed first retained capture.
CREATE INDEX reconciliation_identity_reviews_by_review ON reconciliation_identity_reviews(review_id);

-- Preserve sparse rowids: active preparations pin identity_decision_cutoff.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE identity_decision_target_migration_copy AS
 SELECT rowid AS decision_rowid,* FROM canonical_identity_decisions;
DROP TABLE canonical_identity_decisions;
CREATE TABLE canonical_identity_decisions (
 review_id TEXT PRIMARY KEY REFERENCES canonical_identity_reviews(id),
 printing_id TEXT NOT NULL,
 rationale TEXT NOT NULL CHECK(length(rationale)>0),
 idempotency_key TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 decided_at TEXT NOT NULL,
 native_candidate_id TEXT REFERENCES catalogue_candidate_publications(candidate_id),
 native_target_kind TEXT NOT NULL DEFAULT 'printings' CHECK(native_target_kind='printings'),
 historical_printing_id TEXT REFERENCES reconciled_printings(id),
 CHECK((native_candidate_id IS NOT NULL AND historical_printing_id IS NULL)
   OR (native_candidate_id IS NULL AND historical_printing_id IS NOT NULL AND historical_printing_id=printing_id)),
 FOREIGN KEY(native_candidate_id,native_target_kind,printing_id)
   REFERENCES publication_read_entities(candidate_id,kind,entity_id)
);
INSERT INTO canonical_identity_decisions
 (rowid,review_id,printing_id,rationale,idempotency_key,request_json,decided_at,historical_printing_id)
 SELECT decision_rowid,review_id,printing_id,rationale,idempotency_key,request_json,decided_at,printing_id
 FROM identity_decision_target_migration_copy;
DROP TABLE identity_decision_target_migration_copy;

-- Native targets belong to the review's immutable evidence predecessor, not
-- today's accepted head. A missing native pin or target cannot fall back to legacy.
CREATE TRIGGER canonical_identity_decision_target BEFORE INSERT ON canonical_identity_decisions
WHEN NOT EXISTS (
 SELECT 1 FROM canonical_identity_reviews review
 JOIN source_snapshots snapshot ON snapshot.id=review.source_snapshot_id AND snapshot.source_lineage=review.source_lineage
 LEFT JOIN reconciliation_identity_reviews capture ON capture.rowid=(
   SELECT rowid FROM reconciliation_identity_reviews WHERE review_id=review.id ORDER BY rowid LIMIT 1)
 LEFT JOIN game_candidate_predecessors predecessor ON predecessor.candidate_id=capture.preparation_id
 WHERE review.id=NEW.review_id
 AND EXISTS(SELECT 1 FROM json_each(review.candidate_printing_ids_json) WHERE value=NEW.printing_id)
 AND (capture.preparation_id IS NULL OR predecessor.candidate_id IS NOT NULL)
 AND ((NEW.native_candidate_id IS NOT NULL AND NEW.native_candidate_id=predecessor.predecessor_candidate_id
   AND EXISTS(SELECT 1 FROM publication_read_entities target
     WHERE target.candidate_id=NEW.native_candidate_id AND target.kind='printings'
     AND target.entity_id=NEW.printing_id AND target.supported_game=snapshot.supported_game))
 OR (NEW.native_candidate_id IS NULL AND predecessor.predecessor_candidate_id IS NULL
   AND EXISTS(SELECT 1 FROM reconciled_printings printing JOIN reconciled_cards card ON card.id=printing.card_id
     WHERE printing.id=NEW.historical_printing_id AND card.supported_game=snapshot.supported_game)))
)
BEGIN SELECT RAISE(ABORT,'identity_review_target_invalid'); END;
CREATE TRIGGER canonical_identity_decisions_no_update BEFORE UPDATE ON canonical_identity_decisions
BEGIN SELECT RAISE(ABORT,'canonical_identity_decision_immutable'); END;
CREATE TRIGGER canonical_identity_decisions_no_delete BEFORE DELETE ON canonical_identity_decisions
BEGIN SELECT RAISE(ABORT,'canonical_identity_decision_immutable'); END;
CREATE TRIGGER recovery_fence_canonical_identity_decisions_insert BEFORE INSERT ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_decisions_update BEFORE UPDATE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_canonical_identity_decisions_delete BEFORE DELETE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_decisions_insert BEFORE INSERT ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_decisions_update BEFORE UPDATE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_canonical_identity_decisions_delete BEFORE DELETE ON canonical_identity_decisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

UPDATE catalogue_schema_state SET migration_level=32 WHERE singleton=1;
