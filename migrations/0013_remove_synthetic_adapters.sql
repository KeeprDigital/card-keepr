SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 12
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_12', '$') END;

-- ADR 0008: fixtures are test composition, not retained production authority.
-- Refuse to erase registrations while any stored evidence still names them.
-- Regeneration is a separate owner operation; this migration deletes no runs
-- or evidence and performs every precondition check before its first write.
SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ingestion_evidence_plans
    WHERE plan_origin = 'synthetic_fixture'
      OR adapter_version IN (SELECT adapter_version FROM source_adapter_versions WHERE adapter_origin = 'synthetic_fixture')
  ) AND NOT EXISTS (
    SELECT 1 FROM source_snapshots
    WHERE adapter_version IN (SELECT adapter_version FROM source_adapter_versions WHERE adapter_origin = 'synthetic_fixture')
  ) AND NOT EXISTS (
    SELECT 1 FROM source_parse_operations
    WHERE adapter_version IN (SELECT adapter_version FROM source_adapter_versions WHERE adapter_origin = 'synthetic_fixture')
  ) AND NOT EXISTS (
    SELECT 1 FROM source_observation_sets
    WHERE adapter_version IN (SELECT adapter_version FROM source_adapter_versions WHERE adapter_origin = 'synthetic_fixture')
  ) AND NOT EXISTS (
    SELECT 1 FROM reconciliation_evidence_partitions
    WHERE adapter_version IN (SELECT adapter_version FROM source_adapter_versions WHERE adapter_origin = 'synthetic_fixture')
  )
  THEN 1 ELSE json_extract('{}', 'synthetic_adapter_retirement_requires_regeneration') END;

DELETE FROM source_adapter_versions WHERE adapter_origin = 'synthetic_fixture';

UPDATE catalogue_schema_state SET migration_level = 13 WHERE singleton = 1;
