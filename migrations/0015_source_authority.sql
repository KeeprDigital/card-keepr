SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 14
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_14', '$') END;

-- Owner policy is distinct from publisher ownership and transport permissions.
-- Append-only decisions survive definition edits and are included in database backups.
CREATE TABLE source_authority_decisions (
  idempotency_key TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale = 'en'),
  release_region TEXT NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('card_facts', 'printing_details', 'corrected_card_content')),
  source_lineage TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  decided_at TEXT NOT NULL,
  UNIQUE (game, locale, release_region, area, generation)
);
CREATE TRIGGER source_authority_decisions_no_update BEFORE UPDATE ON source_authority_decisions
BEGIN SELECT RAISE(ABORT, 'source_authority_decision_immutable'); END;
CREATE TRIGGER source_authority_decisions_no_delete BEFORE DELETE ON source_authority_decisions
BEGIN SELECT RAISE(ABORT, 'source_authority_decision_immutable'); END;
UPDATE catalogue_schema_state SET migration_level = 15 WHERE singleton = 1;
