SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=32
THEN 1 ELSE json_extract('schema_level_mismatch_expected_32','$') END;

-- Category extends canonical equivalence without reallocating existing IDs.
-- Old profiles describe gameplay; their explicit token vocabulary is preserved.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE card_category_migration_copy AS
 SELECT c.*,coalesce(json_extract(r.document_json,'$.data'),r.document_json,'{}') AS document
 FROM reconciled_cards c LEFT JOIN revision_cards r
 ON r.card_id=c.id AND r.catalogue_revision_id=c.last_observed_revision_id;
DROP TABLE reconciled_cards;
CREATE TABLE reconciled_cards (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'gameplay' CHECK(category IN ('gameplay','token','art')),
  official_identity_kind TEXT NOT NULL,
  official_identity_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawal_revision_id TEXT REFERENCES catalogue_revisions(id),
  withdrawal_evidence_json TEXT,
  UNIQUE (
    supported_game,
    category,
    official_identity_kind,
    official_identity_value
  )
);
INSERT INTO reconciled_cards
 (id,supported_game,category,official_identity_kind,official_identity_value,first_revision_id,last_observed_revision_id,withdrawn,withdrawal_revision_id,withdrawal_evidence_json)
 SELECT id,supported_game,CASE WHEN supported_game='gundam' AND json_extract(document,'$.game_data.attributes.card_type')='unit_token' THEN 'token' WHEN supported_game='riftbound' AND EXISTS(SELECT 1 FROM json_each(document,'$.game_data.attributes.supertypes') WHERE value='token') THEN 'token' ELSE 'gameplay' END,official_identity_kind,official_identity_value,first_revision_id,last_observed_revision_id,withdrawn,withdrawal_revision_id,withdrawal_evidence_json
 FROM card_category_migration_copy;
DROP TABLE card_category_migration_copy;
CREATE TRIGGER reconciled_card_identity_is_immutable
BEFORE UPDATE OF
  id,
  supported_game,
  category,
  official_identity_kind,
  official_identity_value,
  first_revision_id
ON reconciled_cards
BEGIN
  SELECT RAISE(ABORT, 'reconciled_card_identity_immutable');
END;
CREATE TRIGGER recovery_fence_reconciled_cards_insert BEFORE INSERT ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_cards_update BEFORE UPDATE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_reconciled_cards_delete BEFORE DELETE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_cards_insert BEFORE INSERT ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_cards_update BEFORE UPDATE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_cards_delete BEFORE DELETE ON reconciled_cards
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

ALTER TABLE publication_read_entities ADD COLUMN category TEXT CHECK(category IN ('gameplay','token','art'));
-- Backfill only the new derived index field, then restore the existing write fence.
DROP TRIGGER publication_read_entities_immutable;
UPDATE publication_read_entities SET category=CASE
 WHEN supported_game='gundam' AND EXISTS(SELECT 1 FROM publication_read_attributes a WHERE a.candidate_id=publication_read_entities.candidate_id AND a.card_id=entity_id AND a.attribute='card_type' AND a.value='"unit_token"') THEN 'token'
 WHEN supported_game='riftbound' AND EXISTS(SELECT 1 FROM publication_read_attributes a WHERE a.candidate_id=publication_read_entities.candidate_id AND a.card_id=entity_id AND a.attribute='supertypes' AND a.value='"token"') THEN 'token'
 ELSE 'gameplay' END WHERE kind='cards';
CREATE TRIGGER publication_read_entities_immutable BEFORE UPDATE ON publication_read_entities
BEGIN SELECT RAISE(ABORT,'publication_read_immutable'); END;
CREATE INDEX publication_read_category ON publication_read_entities(candidate_id,kind,category,sort1,sort2,sort3,sort4,sort5,entity_id);

ALTER TABLE revision_card_query_documents ADD COLUMN category TEXT GENERATED ALWAYS AS (
 coalesce(json_extract(summary_json,'$.category'),CASE
 WHEN sort_game='gundam' AND json_extract(summary_json,'$.game_data.attributes.card_type')='unit_token' THEN 'token'
 WHEN sort_game='riftbound' AND instr(json_extract(summary_json,'$.game_data.attributes.supertypes'),'"token"')>0 THEN 'token'
 ELSE 'gameplay' END)
) VIRTUAL;
CREATE INDEX revision_card_query_category ON revision_card_query_documents(catalogue_revision_id,category,sort_game,sort_identity_kind,sort_identity_value,sort_id);

-- Legacy readiness is indexed once from immutable bytes, never scanned per read.
-- CASE makes missing and explicit null fields unready rather than SQL NULL.
ALTER TABLE revision_cards ADD COLUMN card_model_ready INTEGER GENERATED ALWAYS AS (CASE WHEN
 coalesce(json_type(document_json,'$.data.category'),json_type(document_json,'$.category'))='text'
 AND coalesce(json_type(document_json,'$.data.gameplay_applicability'),json_type(document_json,'$.gameplay_applicability'))='text'
 AND coalesce(json_type(document_json,'$.data.related_cards'),json_type(document_json,'$.related_cards'))='array'
 THEN 1 ELSE 0 END) VIRTUAL;
CREATE INDEX revision_cards_unready_model ON revision_cards(catalogue_revision_id) WHERE card_model_ready=0;
ALTER TABLE revision_printings ADD COLUMN card_model_ready INTEGER GENERATED ALWAYS AS (CASE WHEN
 coalesce(json_type(document_json,'$.data.gameplay_applicability'),json_type(document_json,'$.gameplay_applicability'))='text'
 THEN 1 ELSE 0 END) VIRTUAL;
CREATE INDEX revision_printings_unready_model ON revision_printings(catalogue_revision_id) WHERE card_model_ready=0;

-- Resolve legacy allocations by their retained identity without scanning history.
CREATE INDEX entity_admission_card_identity ON entity_admission_decisions(json_extract(decision_json,'$.card.id'),decided_at DESC,generation DESC) WHERE action IN ('admit','link');
CREATE INDEX reconciliation_source_mapping_identity ON reconciliation_source_mappings(entity_id,preparation_id,source_observation_id);

UPDATE catalogue_schema_state SET migration_level=33 WHERE singleton=1;
