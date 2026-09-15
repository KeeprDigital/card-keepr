-- #327: bounded source scheduling and a larger exclusive emergency ceiling.
-- Preserve registered capacities, retained extensions and every dependent reference.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=35
THEN 1 ELSE json_extract('schema_level_mismatch_expected_35','$') END;

PRAGMA defer_foreign_keys=ON;

CREATE TABLE source_adapter_versions_capacity_copy AS SELECT * FROM source_adapter_versions;

DROP TABLE source_adapter_versions;

CREATE TABLE source_adapter_versions (
  adapter_version TEXT PRIMARY KEY,
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  parser_contract TEXT NOT NULL,
  adapter_origin TEXT NOT NULL DEFAULT 'production'
    CHECK (adapter_origin IN ('production', 'synthetic_fixture')),
  request_capacity INTEGER NOT NULL DEFAULT 5000
    CHECK (request_capacity BETWEEN 1 AND 249999),
  UNIQUE (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

INSERT INTO source_adapter_versions SELECT * FROM source_adapter_versions_capacity_copy;

DROP TABLE source_adapter_versions_capacity_copy;

CREATE TRIGGER source_adapter_version_is_immutable
BEFORE UPDATE ON source_adapter_versions
BEGIN
  SELECT RAISE(ABORT, 'source_adapter_version_immutable');
END;

CREATE TRIGGER recovery_fence_source_adapter_versions_insert BEFORE INSERT ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_source_adapter_versions_update BEFORE UPDATE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_source_adapter_versions_delete BEFORE DELETE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_source_adapter_versions_insert BEFORE INSERT ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_source_adapter_versions_update BEFORE UPDATE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_source_adapter_versions_delete BEFORE DELETE ON source_adapter_versions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TABLE ingestion_run_capacity_extensions_capacity_copy AS SELECT * FROM ingestion_run_capacity_extensions;

DROP TABLE ingestion_run_capacity_extensions;

CREATE TABLE ingestion_run_capacity_extensions (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  capacity_generation INTEGER NOT NULL CHECK (capacity_generation >= 2),
  previous_request_capacity INTEGER NOT NULL CHECK (
    previous_request_capacity >= 1
  ),
  request_capacity INTEGER NOT NULL CHECK (
    request_capacity > previous_request_capacity
    AND request_capacity BETWEEN 2 AND 249999
  ),
  source_lineage TEXT NOT NULL,
  extended_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  PRIMARY KEY (ingestion_run_id, capacity_generation)
);

INSERT INTO ingestion_run_capacity_extensions SELECT * FROM ingestion_run_capacity_extensions_capacity_copy;

DROP TABLE ingestion_run_capacity_extensions_capacity_copy;

CREATE TRIGGER guard_capacity_extension_update
BEFORE UPDATE ON ingestion_run_capacity_extensions
BEGIN
  SELECT RAISE(ABORT, 'capacity_extension_immutable');
END;

CREATE TRIGGER guard_capacity_extension_delete
BEFORE DELETE ON ingestion_run_capacity_extensions
BEGIN
  SELECT RAISE(ABORT, 'capacity_extension_immutable');
END;

CREATE TRIGGER recovery_fence_ingestion_run_capacity_extensions_insert BEFORE INSERT ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_ingestion_run_capacity_extensions_update BEFORE UPDATE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_ingestion_run_capacity_extensions_delete BEFORE DELETE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_capacity_extensions_insert BEFORE INSERT ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_capacity_extensions_update BEFORE UPDATE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER handoff_fence_ingestion_run_capacity_extensions_delete BEFORE DELETE ON ingestion_run_capacity_extensions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE INDEX source_requests_pending_sequence ON source_requests(ingestion_run_id, sequence_number) WHERE state IN ('pending', 'captured');

CREATE INDEX source_requests_pending_host_shard ON source_requests(ingestion_run_id,
  CASE WHEN substr(substr(substr(url, instr(url, '://') + 3), 1, instr(substr(url, instr(url, '://') + 3), '/') - 1), 1, 1) = '[' THEN substr(substr(substr(url, instr(url, '://') + 3), 1, instr(substr(url, instr(url, '://') + 3), '/') - 1), 1, instr(substr(substr(url, instr(url, '://') + 3), 1, instr(substr(url, instr(url, '://') + 3), '/') - 1), ']'))
    WHEN instr(substr(substr(url, instr(url, '://') + 3), 1, instr(substr(url, instr(url, '://') + 3), '/') - 1), ':') > 0 THEN substr(substr(substr(url, instr(url, '://') + 3), 1, instr(substr(url, instr(url, '://') + 3), '/') - 1), 1, instr(substr(substr(url, instr(url, '://') + 3), 1, instr(substr(url, instr(url, '://') + 3), '/') - 1), ':') - 1)
    ELSE substr(substr(url, instr(url, '://') + 3), 1, instr(substr(url, instr(url, '://') + 3), '/') - 1) END,
  sequence_number
) WHERE state IN ('pending', 'captured');

UPDATE catalogue_schema_state SET migration_level=36 WHERE singleton=1;
