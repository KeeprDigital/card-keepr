SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 9
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_9', '$') END;

-- Before Go-Live, discard contexts with the obsolete primary-partition shape.
-- Every evidence identity remains owned by reconciliation_evidence_partitions.
DROP TABLE reconciliation_contexts;
CREATE TABLE reconciliation_contexts (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  digest_payload_json TEXT NOT NULL
);
CREATE TRIGGER reconciliation_contexts_are_immutable_on_update
BEFORE UPDATE ON reconciliation_contexts
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_context_immutable');
END;
CREATE TRIGGER reconciliation_contexts_are_immutable_on_delete
BEFORE DELETE ON reconciliation_contexts
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_context_immutable');
END;

UPDATE catalogue_schema_state SET migration_level = 10 WHERE singleton = 1;
