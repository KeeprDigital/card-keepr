-- #367: no synthetic allowance or historical dispatch backfill.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=41
THEN 1 ELSE json_extract('schema_level_mismatch_expected_41','$') END;

CREATE TABLE ingestion_acquisition_accounts (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  coverage_started_at TEXT NOT NULL,
  historical_dispatches_unknown INTEGER NOT NULL CHECK(historical_dispatches_unknown IN (0,1)),
  baseline_source_bytes INTEGER NOT NULL CHECK(baseline_source_bytes>=0),
  charged_dispatches INTEGER NOT NULL DEFAULT 0 CHECK(charged_dispatches BETWEEN 0 AND 9007199254740991),
  charged_source_bytes INTEGER NOT NULL DEFAULT 0 CHECK(charged_source_bytes BETWEEN 0 AND 9007199254740991),
  reserved_source_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_source_bytes BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE ingestion_acquisition_policies (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_acquisition_accounts(ingestion_run_id),
  generation INTEGER NOT NULL CHECK(generation>0),
  max_dispatches INTEGER NOT NULL CHECK(max_dispatches BETWEEN 1 AND 9007199254740991),
  max_source_bytes INTEGER NOT NULL CHECK(max_source_bytes BETWEEN 1 AND 9007199254740991),
  dispatch_deadline TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  PRIMARY KEY(ingestion_run_id,generation)
);
CREATE TABLE source_dispatch_reservations (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  capture_operation_id TEXT NOT NULL REFERENCES source_capture_operations(attempt_id),
  content_object_key TEXT NOT NULL,
  parent_workflow_id TEXT,
  workflow_instance_id TEXT,
  budget_generation INTEGER NOT NULL,
  maximum_source_bytes INTEGER NOT NULL CHECK(maximum_source_bytes>0),
  reserved_at TEXT NOT NULL,
  settled_at TEXT,
  charged_source_bytes INTEGER CHECK(charged_source_bytes>=0 AND charged_source_bytes<=maximum_source_bytes),
  CHECK((settled_at IS NULL)=(charged_source_bytes IS NULL)),
  FOREIGN KEY(ingestion_run_id,budget_generation) REFERENCES ingestion_acquisition_policies(ingestion_run_id,generation),
  FOREIGN KEY(ingestion_run_id,request_id) REFERENCES source_requests(ingestion_run_id,request_id)
);
CREATE UNIQUE INDEX source_dispatch_unsettled_capture ON source_dispatch_reservations(capture_operation_id) WHERE settled_at IS NULL;
CREATE INDEX source_dispatch_run_unsettled ON source_dispatch_reservations(ingestion_run_id,settled_at,id);
CREATE INDEX source_dispatch_request_unsettled ON source_dispatch_reservations(ingestion_run_id,request_id,settled_at);
CREATE TABLE ingestion_acquisition_pauses (
  event_id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  generation INTEGER,
  request_id TEXT NOT NULL,
  maximum_source_bytes INTEGER NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('dispatches','source_bytes','deadline','policy_missing','ownership')),
  paused_at TEXT NOT NULL
);
CREATE INDEX acquisition_pause_latest ON ingestion_acquisition_pauses(ingestion_run_id,paused_at DESC);

CREATE TRIGGER source_dispatch_identity_immutable BEFORE UPDATE ON source_dispatch_reservations
WHEN OLD.settled_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.ingestion_run_id IS NOT OLD.ingestion_run_id
  OR NEW.request_id IS NOT OLD.request_id OR NEW.capture_operation_id IS NOT OLD.capture_operation_id
  OR NEW.content_object_key IS NOT OLD.content_object_key OR NEW.parent_workflow_id IS NOT OLD.parent_workflow_id
  OR NEW.workflow_instance_id IS NOT OLD.workflow_instance_id OR NEW.budget_generation IS NOT OLD.budget_generation
  OR NEW.maximum_source_bytes IS NOT OLD.maximum_source_bytes OR NEW.reserved_at IS NOT OLD.reserved_at
BEGIN SELECT RAISE(ABORT,'source_dispatch_immutable'); END;
CREATE TRIGGER source_dispatch_not_deleted BEFORE DELETE ON source_dispatch_reservations
BEGIN SELECT RAISE(ABORT,'source_dispatch_immutable'); END;
CREATE TRIGGER acquisition_policy_not_updated BEFORE UPDATE ON ingestion_acquisition_policies
BEGIN SELECT RAISE(ABORT,'acquisition_policy_immutable'); END;
CREATE TRIGGER acquisition_policy_not_deleted BEFORE DELETE ON ingestion_acquisition_policies
BEGIN SELECT RAISE(ABORT,'acquisition_policy_immutable'); END;
CREATE TRIGGER acquisition_pause_not_updated BEFORE UPDATE ON ingestion_acquisition_pauses
BEGIN SELECT RAISE(ABORT,'acquisition_pause_immutable'); END;
CREATE TRIGGER acquisition_pause_not_deleted BEFORE DELETE ON ingestion_acquisition_pauses
BEGIN SELECT RAISE(ABORT,'acquisition_pause_immutable'); END;
CREATE TRIGGER acquisition_coverage_immutable BEFORE UPDATE ON ingestion_acquisition_accounts
WHEN NEW.ingestion_run_id IS NOT OLD.ingestion_run_id OR NEW.coverage_started_at IS NOT OLD.coverage_started_at
  OR NEW.historical_dispatches_unknown IS NOT OLD.historical_dispatches_unknown
  OR NEW.baseline_source_bytes IS NOT OLD.baseline_source_bytes
BEGIN SELECT RAISE(ABORT,'acquisition_coverage_immutable'); END;
CREATE TRIGGER acquisition_account_not_deleted BEFORE DELETE ON ingestion_acquisition_accounts
BEGIN SELECT RAISE(ABORT,'acquisition_coverage_immutable'); END;

CREATE TRIGGER recovery_fence_ingestion_acquisition_accounts_insert BEFORE INSERT ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_accounts_insert BEFORE INSERT ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_accounts_insert BEFORE INSERT ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_accounts_update BEFORE UPDATE ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_accounts_update BEFORE UPDATE ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_accounts_update BEFORE UPDATE ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_accounts_delete BEFORE DELETE ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_accounts_delete BEFORE DELETE ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_accounts_delete BEFORE DELETE ON ingestion_acquisition_accounts
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_policies_insert BEFORE INSERT ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_policies_insert BEFORE INSERT ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_policies_insert BEFORE INSERT ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_policies_update BEFORE UPDATE ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_policies_update BEFORE UPDATE ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_policies_update BEFORE UPDATE ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_policies_delete BEFORE DELETE ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_policies_delete BEFORE DELETE ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_policies_delete BEFORE DELETE ON ingestion_acquisition_policies
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_dispatch_reservations_insert BEFORE INSERT ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_dispatch_reservations_insert BEFORE INSERT ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_dispatch_reservations_insert BEFORE INSERT ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_dispatch_reservations_update BEFORE UPDATE ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_dispatch_reservations_update BEFORE UPDATE ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_dispatch_reservations_update BEFORE UPDATE ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_source_dispatch_reservations_delete BEFORE DELETE ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_source_dispatch_reservations_delete BEFORE DELETE ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_source_dispatch_reservations_delete BEFORE DELETE ON source_dispatch_reservations
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_pauses_insert BEFORE INSERT ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_pauses_insert BEFORE INSERT ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_pauses_insert BEFORE INSERT ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_pauses_update BEFORE UPDATE ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_pauses_update BEFORE UPDATE ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_pauses_update BEFORE UPDATE ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=NEW.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;
CREATE TRIGGER recovery_fence_ingestion_acquisition_pauses_delete BEFORE DELETE ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_acquisition_pauses_delete BEFORE DELETE ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER restored_collector_fence_ingestion_acquisition_pauses_delete BEFORE DELETE ON ingestion_acquisition_pauses
WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications WHERE ingestion_run_id=OLD.ingestion_run_id AND classification='abandoned_after_restore')
BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

-- Preserve the existing owner-termination history while admitting the new pause reason.
CREATE TABLE ingestion_run_terminations_rebuild AS SELECT * FROM ingestion_run_terminations;
DROP TRIGGER guard_termination_update;
DROP TRIGGER guard_termination_delete;
DROP TABLE ingestion_run_terminations;
CREATE TABLE ingestion_run_terminations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_request_capacity_exhausted',
      'source_acquisition_budget_exhausted',
      'source_transport_retries_exhausted',
      'source_storage_retries_exhausted',
      'source_workflow_stalled',
      'source_workflow_errored',
      'source_workflow_terminated',
      'source_workflow_unavailable',
      'owner_requested'
    )
  ),
  paused_at TEXT NOT NULL,
  terminated_at TEXT NOT NULL CHECK (terminated_at >= paused_at),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json))
);
INSERT INTO ingestion_run_terminations SELECT * FROM ingestion_run_terminations_rebuild ORDER BY rowid;
DROP TABLE ingestion_run_terminations_rebuild;
CREATE TRIGGER guard_termination_update BEFORE UPDATE ON ingestion_run_terminations
BEGIN SELECT RAISE(ABORT,'termination_immutable'); END;
CREATE TRIGGER guard_termination_delete BEFORE DELETE ON ingestion_run_terminations
BEGIN SELECT RAISE(ABORT,'termination_immutable'); END;
CREATE TRIGGER recovery_fence_ingestion_run_terminations_insert BEFORE INSERT ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_terminations_update BEFORE UPDATE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_terminations_delete BEFORE DELETE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_terminations_insert BEFORE INSERT ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_terminations_update BEFORE UPDATE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_terminations_delete BEFORE DELETE ON ingestion_run_terminations
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

UPDATE catalogue_schema_state SET migration_level=42 WHERE singleton=1 AND migration_level=41;
SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
