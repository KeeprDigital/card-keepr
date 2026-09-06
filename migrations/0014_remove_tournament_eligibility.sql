SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 13
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_13', '$') END;

-- ADR 0014, prelaunch evolution. Remove derived tournament policy while
-- preserving raw snapshots, observation sets and immutable evidence-retention
-- anchors. Historical retained_by_table values remain audit evidence; there is
-- no longer a writer or a referenced policy table. No catalogue is regenerated
-- or published by this migration.
DROP TABLE revision_legality_rule_applicability;
DROP TABLE revision_legality_rules;
DROP TABLE legality_rules;

CREATE TABLE source_freshness_card_content (
  game TEXT NOT NULL CHECK (game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')),
  area TEXT NOT NULL CHECK (area IN ('cards-and-printings', 'products-and-releases', 'errata')),
  source_lineage TEXT NOT NULL DEFAULT '' CHECK (source_lineage = ''),
  region TEXT NOT NULL DEFAULT '' CHECK (region = ''),
  checked_at TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  PRIMARY KEY (game, area, source_lineage, region)
);
INSERT INTO source_freshness_card_content
  SELECT game, area, source_lineage, region, checked_at, ingestion_run_id
  FROM source_freshness WHERE area <> 'legality-rules';
DROP TABLE source_freshness;
ALTER TABLE source_freshness_card_content RENAME TO source_freshness;

UPDATE catalogue_schema_state SET migration_level = 14 WHERE singleton = 1;
