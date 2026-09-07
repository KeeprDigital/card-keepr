SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=23
THEN 1 ELSE json_extract('schema_level_mismatch_expected_23','$') END;

CREATE TABLE evidence_cleanup_operations (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 36500),
  terminal_at TEXT NOT NULL,
  eligible_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','paused','completed')),
  cursor TEXT NOT NULL DEFAULT '',
  retry_cursor TEXT NOT NULL DEFAULT '',
  deleted_objects INTEGER NOT NULL DEFAULT 0,
  protected_objects INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  failure_code TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  CHECK(deleted_objects>=0 AND protected_objects>=0)
);
CREATE TRIGGER evidence_cleanup_identity_immutable BEFORE UPDATE ON evidence_cleanup_operations
WHEN NEW.id<>OLD.id OR NEW.ingestion_run_id<>OLD.ingestion_run_id OR NEW.idempotency_key<>OLD.idempotency_key
 OR NEW.retention_days<>OLD.retention_days OR NEW.terminal_at<>OLD.terminal_at OR NEW.eligible_at<>OLD.eligible_at
 OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_identity_immutable'); END;
CREATE TRIGGER evidence_cleanup_audit_retained BEFORE DELETE ON evidence_cleanup_operations
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_audit_retained'); END;

CREATE TABLE evidence_cleanup_objects (
  object_key TEXT PRIMARY KEY,
  cleanup_id TEXT NOT NULL REFERENCES evidence_cleanup_operations(id),
  state TEXT NOT NULL CHECK(state IN ('reserved','deleting','deleted')),
  claimed_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TRIGGER evidence_cleanup_object_retained BEFORE DELETE ON evidence_cleanup_objects
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_tombstone_retained'); END;
CREATE TRIGGER evidence_cleanup_object_identity BEFORE UPDATE ON evidence_cleanup_objects
WHEN NEW.object_key<>OLD.object_key OR NEW.cleanup_id<>OLD.cleanup_id OR NEW.claimed_at<>OLD.claimed_at
 OR (OLD.state='deleted' AND NEW.state<>'deleted')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_tombstone_immutable'); END;

-- Enumerate recorded physical objects; never list/delete an R2 prefix or walk
-- shared Merkle roots as though they were exclusively owned by this run.
CREATE VIEW evidence_cleanup_inventory AS
 SELECT ingestion_run_id, content_object_key AS object_key FROM source_capture_operations
 UNION SELECT ingestion_run_id, content_object_key FROM source_snapshots
 UNION SELECT snapshot.ingestion_run_id, parse.content_object_key
 FROM source_parse_operations parse JOIN source_snapshots snapshot ON snapshot.id=parse.source_snapshot_id;
CREATE INDEX evidence_cleanup_snapshot_key ON source_snapshots(content_object_key, ingestion_run_id);



-- Reference extensions use exact private physical keys. Registration is durable
-- and must commit before acknowledging the dependent decision or operation.
CREATE TABLE evidence_object_references (
 object_key TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(object_key,owner_kind,owner_id)
);
CREATE TABLE evidence_object_writers (
 token TEXT PRIMARY KEY, ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
 object_key TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
 multipart_upload_id TEXT
);
CREATE INDEX evidence_object_writers_key ON evidence_object_writers(object_key,completed_at);
CREATE VIEW evidence_cleanup_snapshot_keys AS
 SELECT id AS snapshot_id, content_object_key AS object_key FROM source_snapshots
 UNION SELECT source_snapshot_id, content_object_key FROM source_parse_operations;
CREATE VIEW evidence_cleanup_retained_snapshots AS
 SELECT snapshot.id AS snapshot_id FROM source_snapshots snapshot WHERE
 EXISTS(SELECT 1 FROM source_capture_operations ref JOIN ingestion_run_read owner ON owner.id=ref.ingestion_run_id WHERE ref.reused_source_snapshot_id=snapshot.id AND owner.state NOT IN ('failed','rejected','expired'))
 OR EXISTS(SELECT 1 FROM reconciliation_evidence_partitions ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM reconciliation_candidates ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM canonical_source_mappings ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM canonical_identity_reviews ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM canonical_identity_review_runs ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM entity_proposal_source_evidence ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM reconciled_withdrawal_assertions ref WHERE ref.source_snapshot_id=snapshot.id)
 OR EXISTS(SELECT 1 FROM game_candidates ref WHERE ref.ingestion_run_id=snapshot.ingestion_run_id)
 OR EXISTS(SELECT 1 FROM catalogue_revisions ref WHERE ref.ingestion_run_id=snapshot.ingestion_run_id)
 OR EXISTS(SELECT 1 FROM reconciliation_operations ref WHERE ref.ingestion_run_id=snapshot.ingestion_run_id AND ref.state NOT IN ('failed','abandoned'))
 OR EXISTS(SELECT 1 FROM reconciliation_evidence_selection ref JOIN reconciliation_operations operation ON operation.id=ref.preparation_id WHERE json_extract(ref.content,'$.row.source_snapshot_id')=snapshot.id AND (operation.state NOT IN ('failed','abandoned') OR EXISTS(SELECT 1 FROM game_candidates candidate WHERE candidate.preparation_id=operation.id)))
 OR EXISTS(SELECT 1 FROM reconciliation_source_mappings ref JOIN reconciliation_operations operation ON operation.id=ref.preparation_id WHERE ref.source_snapshot_id=snapshot.id AND (operation.state NOT IN ('failed','abandoned') OR EXISTS(SELECT 1 FROM game_candidates candidate WHERE candidate.preparation_id=operation.id)));

CREATE VIEW evidence_cleanup_retained_keys AS
 SELECT keys.object_key FROM evidence_cleanup_snapshot_keys keys
 JOIN evidence_cleanup_retained_snapshots retained ON retained.snapshot_id=keys.snapshot_id
 UNION SELECT object_key FROM evidence_object_references;

-- The claim is a durable tombstone, not a lease. A lost delete response is
-- retried against this same key; new references may never revive it.
CREATE TRIGGER evidence_cleanup_claim_guard BEFORE INSERT ON evidence_cleanup_objects
WHEN NOT EXISTS(SELECT 1 FROM evidence_cleanup_operations cleanup
 JOIN ingestion_run_read run ON run.id=cleanup.ingestion_run_id
 WHERE cleanup.id=NEW.cleanup_id AND run.state IN ('failed','rejected','expired')
 AND run.terminal_at=cleanup.terminal_at AND NEW.claimed_at>=cleanup.eligible_at
 AND EXISTS(SELECT 1 FROM evidence_cleanup_inventory inventory WHERE inventory.ingestion_run_id=run.id AND inventory.object_key=NEW.object_key))
 OR EXISTS(SELECT 1 FROM evidence_cleanup_retained_keys WHERE object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_inventory inventory JOIN ingestion_run_read run ON run.id=inventory.ingestion_run_id
 JOIN evidence_cleanup_operations cleanup ON cleanup.id=NEW.cleanup_id
 WHERE inventory.object_key=NEW.object_key AND
 (run.state NOT IN ('failed','rejected','expired') OR run.terminal_at IS NULL
 OR julianday(run.terminal_at)+cleanup.retention_days>julianday(NEW.claimed_at)))
 OR EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')

BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_protected'); END;

CREATE TRIGGER evidence_cleanup_reference_guard BEFORE INSERT ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER evidence_cleanup_reference_update_guard BEFORE UPDATE ON evidence_object_references
BEGIN SELECT RAISE(ABORT,'evidence_reference_immutable'); END;
CREATE TRIGGER evidence_cleanup_reference_delete_guard BEFORE DELETE ON evidence_object_references
BEGIN SELECT RAISE(ABORT,'evidence_reference_retained'); END;
CREATE TRIGGER evidence_cleanup_writer_guard BEFORE INSERT ON evidence_object_writers
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=NEW.ingestion_run_id)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=NEW.object_key)

BEGIN SELECT RAISE(ABORT,'evidence_cleanup_writer_fenced'); END;
CREATE TRIGGER evidence_cleanup_writer_identity BEFORE UPDATE ON evidence_object_writers
WHEN NEW.token<>OLD.token OR NEW.object_key<>OLD.object_key OR NEW.ingestion_run_id<>OLD.ingestion_run_id
 OR NEW.started_at<>OLD.started_at OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'evidence_writer_immutable'); END;
CREATE TRIGGER evidence_cleanup_writer_retained BEFORE DELETE ON evidence_object_writers
BEGIN SELECT RAISE(ABORT,'evidence_writer_retained'); END;
CREATE TRIGGER cleanup_reference_reconciliation_evidence_partitions BEFORE INSERT ON reconciliation_evidence_partitions
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_reconciliation_candidates BEFORE INSERT ON reconciliation_candidates
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_canonical_source_mappings BEFORE INSERT ON canonical_source_mappings
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_canonical_identity_reviews BEFORE INSERT ON canonical_identity_reviews
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_canonical_identity_review_runs BEFORE INSERT ON canonical_identity_review_runs
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_entity_proposal_source_evidence BEFORE INSERT ON entity_proposal_source_evidence
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_reconciled_withdrawal_assertions BEFORE INSERT ON reconciled_withdrawal_assertions
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_source_parse_operations BEFORE INSERT ON source_parse_operations
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_source_observation_sets BEFORE INSERT ON source_observation_sets
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_reconciliation_source_mappings BEFORE INSERT ON reconciliation_source_mappings
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_source_snapshots BEFORE INSERT ON source_snapshots
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=NEW.content_object_key)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=NEW.ingestion_run_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_source_capture_operations BEFORE INSERT ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=NEW.content_object_key)
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations WHERE ingestion_run_id=NEW.ingestion_run_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_selection BEFORE INSERT ON reconciliation_evidence_selection
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=json_extract(NEW.content,'$.row.source_snapshot_id'))
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_reconciliation BEFORE INSERT ON reconciliation_operations
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_inventory inventory JOIN evidence_cleanup_objects deleted ON deleted.object_key=inventory.object_key
 WHERE inventory.ingestion_run_id=NEW.ingestion_run_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_request BEFORE UPDATE OF source_snapshot_id ON source_requests
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_revalidation BEFORE UPDATE OF reused_source_snapshot_id ON source_capture_operations
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.reused_source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
CREATE TRIGGER cleanup_backup_start BEFORE INSERT ON catalogue_backup_attempts
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE state='deleting')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_delete_in_progress'); END;
CREATE TRIGGER cleanup_recovery_start BEFORE UPDATE OF recovery_restore_guard ON operation_state
WHEN NEW.recovery_restore_guard='blocked' AND EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE state='deleting')
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_delete_in_progress'); END;


CREATE TRIGGER evidence_cleanup_physical_delete_guard BEFORE UPDATE OF state ON evidence_cleanup_objects
WHEN NEW.state='deleting' AND (
 EXISTS(SELECT 1 FROM evidence_cleanup_retained_keys WHERE object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM evidence_object_writers WHERE object_key=NEW.object_key AND completed_at IS NULL)
 OR EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
 OR EXISTS(SELECT 1 FROM catalogue_backup_attempts backup
 LEFT JOIN catalogue_backup_retention retention ON retention.attempt_id=backup.idempotency_key
 JOIN evidence_cleanup_inventory inventory ON inventory.object_key=NEW.object_key
 JOIN ingestion_runs run ON run.id=inventory.ingestion_run_id
 WHERE run.started_at<=backup.started_at AND backup.started_at<=NEW.claimed_at AND
 (backup.state NOT IN ('failed','verified') OR (backup.state='verified' AND
 (retention.attempt_id IS NULL OR retention.newest_success=1 OR retention.retain_until>=(SELECT last_attempt_at FROM evidence_cleanup_operations WHERE id=NEW.cleanup_id))))))
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_backup_protected'); END;

CREATE TRIGGER evidence_cleanup_recovery_target BEFORE INSERT ON catalogue_recovery_operations
WHEN EXISTS(SELECT 1 FROM catalogue_backup_attempts backup
 JOIN evidence_cleanup_objects reclaimed ON reclaimed.state IN ('deleting','deleted') AND reclaimed.claimed_at>=backup.started_at
 JOIN evidence_cleanup_inventory inventory ON inventory.object_key=reclaimed.object_key
 JOIN ingestion_runs run ON run.id=inventory.ingestion_run_id AND run.started_at<=backup.started_at
 WHERE backup.idempotency_key=NEW.source_backup_attempt_id)
BEGIN SELECT RAISE(ABORT,'recovery_evidence_reclaimed'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_operations_insert BEFORE INSERT ON evidence_cleanup_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_operations_update BEFORE UPDATE ON evidence_cleanup_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_operations_delete BEFORE DELETE ON evidence_cleanup_operations
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_objects_insert BEFORE INSERT ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_objects_update BEFORE UPDATE ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_objects_delete BEFORE DELETE ON evidence_cleanup_objects
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_object_references_insert BEFORE INSERT ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_object_references_update BEFORE UPDATE ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_object_references_delete BEFORE DELETE ON evidence_object_references
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TABLE evidence_cleanup_results (
 cleanup_id TEXT NOT NULL REFERENCES evidence_cleanup_operations(id), object_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('waiting','protected','deleted')), reason TEXT,
 PRIMARY KEY(cleanup_id,object_key)
);
CREATE INDEX evidence_cleanup_waiting ON evidence_cleanup_results(cleanup_id,state,object_key);
CREATE TRIGGER evidence_cleanup_results_retained BEFORE DELETE ON evidence_cleanup_results
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_results_retained'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_results_insert BEFORE INSERT ON evidence_cleanup_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_results_update BEFORE UPDATE ON evidence_cleanup_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_cleanup_results_delete BEFORE DELETE ON evidence_cleanup_results
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE INDEX cleanup_snapshot_reconciliation_evidence_partitions ON reconciliation_evidence_partitions(source_snapshot_id);
CREATE INDEX cleanup_snapshot_reconciliation_candidates ON reconciliation_candidates(source_snapshot_id);
CREATE INDEX cleanup_snapshot_canonical_source_mappings ON canonical_source_mappings(source_snapshot_id);
CREATE INDEX cleanup_snapshot_canonical_identity_reviews ON canonical_identity_reviews(source_snapshot_id);
CREATE INDEX cleanup_snapshot_canonical_identity_review_runs ON canonical_identity_review_runs(source_snapshot_id);
CREATE INDEX cleanup_snapshot_entity_proposal_source_evidence ON entity_proposal_source_evidence(source_snapshot_id);
CREATE INDEX cleanup_snapshot_reconciled_withdrawal_assertions ON reconciled_withdrawal_assertions(source_snapshot_id);
CREATE INDEX cleanup_snapshot_reconciliation_source_mappings ON reconciliation_source_mappings(source_snapshot_id);
CREATE INDEX cleanup_selection_snapshot ON reconciliation_evidence_selection(json_extract(content,'$.row.source_snapshot_id'));
CREATE INDEX cleanup_candidate_collection ON game_candidates(ingestion_run_id);
CREATE INDEX cleanup_preparation_collection ON reconciliation_operations(ingestion_run_id,state);
CREATE INDEX cleanup_parse_snapshot ON source_parse_operations(source_snapshot_id,content_object_key);
CREATE TRIGGER recovery_fence_evidence_object_writers_insert BEFORE INSERT ON evidence_object_writers
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_object_writers_update BEFORE UPDATE ON evidence_object_writers
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_evidence_object_writers_delete BEFORE DELETE ON evidence_object_writers
WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;


ALTER TABLE evidence_cleanup_operations ADD COLUMN preparation_id TEXT REFERENCES reconciliation_operations(id);
ALTER TABLE evidence_cleanup_operations ADD COLUMN scope TEXT NOT NULL DEFAULT 'capture' CHECK(scope IN ('capture','staging'));
ALTER TABLE reconciliation_operations ADD COLUMN terminal_at TEXT;
-- Without a proven historical terminal clock, begin its retention at migration.
UPDATE reconciliation_operations SET terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state IN ('failed','abandoned');
CREATE TRIGGER cleanup_preparation_terminal_clock AFTER UPDATE OF state ON reconciliation_operations
WHEN NEW.state IN ('failed','abandoned') AND OLD.state NOT IN ('failed','abandoned')
 AND NOT EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked')
BEGIN UPDATE reconciliation_operations SET terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;
CREATE TRIGGER cleanup_preparation_clock_immutable BEFORE UPDATE OF terminal_at ON reconciliation_operations
WHEN OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at
BEGIN SELECT RAISE(ABORT,'preparation_terminal_clock_immutable'); END;

CREATE TABLE staging_objects (
 binding TEXT NOT NULL CHECK(binding IN ('PRINTING_IMAGES','CATALOGUE_EXPORTS')),
 object_key TEXT NOT NULL, incarnation INTEGER NOT NULL DEFAULT 0 CHECK(incarnation>=0),
 state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved','deleting','deleted')),
 cleanup_id TEXT REFERENCES evidence_cleanup_operations(id), reserved_at TEXT,
 PRIMARY KEY(binding,object_key)
);
CREATE TABLE staging_object_writes (
 token TEXT PRIMARY KEY, preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
 binding TEXT NOT NULL, object_key TEXT NOT NULL, incarnation INTEGER NOT NULL,
 started_at TEXT NOT NULL, completed_at TEXT,
 FOREIGN KEY(binding,object_key) REFERENCES staging_objects(binding,object_key)
);
CREATE INDEX staging_writes_inventory ON staging_object_writes(preparation_id,binding,object_key);
CREATE INDEX staging_writes_unsettled ON staging_object_writes(binding,object_key,incarnation,completed_at);
CREATE TABLE staging_object_deletes (
 token TEXT PRIMARY KEY, binding TEXT NOT NULL, object_key TEXT NOT NULL, incarnation INTEGER NOT NULL,
 cleanup_id TEXT NOT NULL REFERENCES evidence_cleanup_operations(id), started_at TEXT NOT NULL, completed_at TEXT,
 FOREIGN KEY(binding,object_key) REFERENCES staging_objects(binding,object_key)
);
CREATE INDEX staging_deletes_unsettled ON staging_object_deletes(binding,object_key,incarnation,completed_at);

CREATE VIEW staging_retained_objects AS
 SELECT objects.binding,objects.object_key FROM staging_objects objects WHERE
 EXISTS(SELECT 1 FROM publication_preparation_artifacts ref WHERE ref.object_key=objects.object_key
 AND ((objects.binding='PRINTING_IMAGES' AND ref.kind='printing_images') OR (objects.binding='CATALOGUE_EXPORTS' AND ref.kind<>'printing_images')))
 OR (objects.binding='CATALOGUE_EXPORTS' AND (
 EXISTS(SELECT 1 FROM publication_composition_nodes ref WHERE ref.object_key=objects.object_key)
 OR EXISTS(SELECT 1 FROM publication_preparations ref WHERE 'publication-artifacts/'||ref.root_digest=objects.object_key)
 OR EXISTS(SELECT 1 FROM verified_publication_compositions ref WHERE 'publication-artifacts/'||ref.sha256=objects.object_key)
 OR EXISTS(SELECT 1 FROM publication_export_components ref WHERE ref.object_key=objects.object_key)
 OR EXISTS(SELECT 1 FROM publication_export_nodes ref WHERE ref.object_key=objects.object_key)
 OR EXISTS(SELECT 1 FROM publication_export_preparations ref WHERE ref.root_object_key=objects.object_key)
 OR EXISTS(SELECT 1 FROM catalogue_exports ref WHERE ref.manifest_key=objects.object_key)))
 OR (objects.binding='PRINTING_IMAGES' AND EXISTS(SELECT 1 FROM game_candidate_partitions ref
 WHERE ref.kind='printing_images' AND instr(ref.content,json_quote(objects.object_key))>0));

CREATE TRIGGER staging_writer_admission BEFORE INSERT ON staging_object_writes
WHEN NOT EXISTS(SELECT 1 FROM staging_objects object WHERE object.binding=NEW.binding AND object.object_key=NEW.object_key
 AND object.incarnation=NEW.incarnation AND object.state='available')
 OR NOT EXISTS(SELECT 1 FROM reconciliation_operations preparation WHERE preparation.id=NEW.preparation_id AND preparation.state NOT IN ('failed','abandoned'))
 OR EXISTS(SELECT 1 FROM evidence_cleanup_operations cleanup WHERE cleanup.preparation_id=NEW.preparation_id)
BEGIN SELECT RAISE(ABORT,'staging_writer_fenced'); END;
CREATE TRIGGER staging_deleter_admission BEFORE INSERT ON staging_object_deletes
WHEN NOT EXISTS(SELECT 1 FROM staging_objects object WHERE object.binding=NEW.binding AND object.object_key=NEW.object_key
 AND object.incarnation=NEW.incarnation AND object.state='deleting' AND object.cleanup_id=NEW.cleanup_id)
BEGIN SELECT RAISE(ABORT,'staging_deleter_fenced'); END;
CREATE TRIGGER staging_incarnation_guard BEFORE UPDATE ON staging_objects
WHEN NEW.binding<>OLD.binding OR NEW.object_key<>OLD.object_key
 OR (NEW.incarnation<>OLD.incarnation AND NOT(OLD.state='deleted' AND NEW.state='available' AND NEW.incarnation=OLD.incarnation+1))
 OR (NEW.state='available' AND OLD.state<>'available' AND OLD.state<>'deleted')
 OR (NEW.state IN ('deleted','available') AND OLD.state<>NEW.state AND EXISTS(
 SELECT 1 FROM staging_object_deletes ticket WHERE ticket.binding=OLD.binding AND ticket.object_key=OLD.object_key AND ticket.completed_at IS NULL))
BEGIN SELECT RAISE(ABORT,'staging_incarnation_fenced'); END;
CREATE TRIGGER staging_reservation_guard BEFORE UPDATE OF state ON staging_objects
WHEN NEW.state='reserved' AND (
 NOT EXISTS(SELECT 1 FROM evidence_cleanup_operations cleanup JOIN reconciliation_operations preparation ON preparation.id=cleanup.preparation_id
 WHERE cleanup.id=NEW.cleanup_id AND cleanup.scope='staging' AND preparation.state IN ('failed','abandoned')
 AND preparation.terminal_at=cleanup.terminal_at AND NEW.reserved_at>=cleanup.eligible_at)
 OR EXISTS(SELECT 1 FROM staging_retained_objects ref WHERE ref.binding=NEW.binding AND ref.object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM staging_object_writes writer JOIN reconciliation_operations preparation ON preparation.id=writer.preparation_id
 JOIN evidence_cleanup_operations cleanup ON cleanup.id=NEW.cleanup_id
 WHERE writer.binding=NEW.binding AND writer.object_key=NEW.object_key AND writer.incarnation=OLD.incarnation
 AND (preparation.state NOT IN ('failed','abandoned') OR preparation.terminal_at IS NULL OR julianday(preparation.terminal_at)+cleanup.retention_days>julianday(NEW.reserved_at))))
BEGIN SELECT RAISE(ABORT,'staging_reference_protected'); END;
CREATE TRIGGER staging_physical_guard BEFORE UPDATE OF state ON staging_objects
WHEN NEW.state='deleting' AND (
 EXISTS(SELECT 1 FROM staging_retained_objects ref WHERE ref.binding=NEW.binding AND ref.object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM staging_object_writes writer WHERE writer.binding=NEW.binding AND writer.object_key=NEW.object_key AND writer.completed_at IS NULL)
 OR EXISTS(SELECT 1 FROM catalogue_backup_attempts backup LEFT JOIN catalogue_backup_retention retention ON retention.attempt_id=backup.idempotency_key
 WHERE backup.started_at<=NEW.reserved_at AND (
 backup.state NOT IN ('failed','verified') OR (backup.state='verified' AND (retention.attempt_id IS NULL OR retention.newest_success=1 OR retention.retain_until>=(SELECT last_attempt_at FROM evidence_cleanup_operations WHERE id=NEW.cleanup_id))))))
BEGIN SELECT RAISE(ABORT,'staging_delete_waiting'); END;
CREATE TRIGGER staging_backup_start BEFORE INSERT ON catalogue_backup_attempts
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE state='deleting')
BEGIN SELECT RAISE(ABORT,'staging_delete_in_progress'); END;
CREATE TRIGGER staging_recovery_start BEFORE UPDATE OF recovery_restore_guard ON operation_state
WHEN NEW.recovery_restore_guard='blocked' AND EXISTS(SELECT 1 FROM staging_objects WHERE state='deleting')
BEGIN SELECT RAISE(ABORT,'staging_delete_in_progress'); END;
CREATE TRIGGER staging_recovery_target BEFORE INSERT ON catalogue_recovery_operations
WHEN EXISTS(SELECT 1 FROM staging_objects object JOIN catalogue_backup_attempts backup ON backup.idempotency_key=NEW.source_backup_attempt_id
 WHERE object.state='deleted' AND object.reserved_at>=backup.started_at)
BEGIN SELECT RAISE(ABORT,'recovery_staging_reclaimed'); END;
CREATE TRIGGER staging_objects_retained BEFORE DELETE ON staging_objects BEGIN SELECT RAISE(ABORT,'staging_audit_retained'); END;
CREATE TRIGGER recovery_fence_staging_objects_insert BEFORE INSERT ON staging_objects WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_staging_objects_update BEFORE UPDATE ON staging_objects WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_staging_objects_delete BEFORE DELETE ON staging_objects WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER staging_object_writes_retained BEFORE DELETE ON staging_object_writes BEGIN SELECT RAISE(ABORT,'staging_audit_retained'); END;
CREATE TRIGGER recovery_fence_staging_object_writes_insert BEFORE INSERT ON staging_object_writes WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_staging_object_writes_update BEFORE UPDATE ON staging_object_writes WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_staging_object_writes_delete BEFORE DELETE ON staging_object_writes WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER staging_object_deletes_retained BEFORE DELETE ON staging_object_deletes BEGIN SELECT RAISE(ABORT,'staging_audit_retained'); END;
CREATE TRIGGER recovery_fence_staging_object_deletes_insert BEFORE INSERT ON staging_object_deletes WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_staging_object_deletes_update BEFORE UPDATE ON staging_object_deletes WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_staging_object_deletes_delete BEFORE DELETE ON staging_object_deletes WHEN EXISTS(SELECT 1 FROM operation_state WHERE recovery_restore_guard='blocked') BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER staging_object_writes_identity BEFORE UPDATE ON staging_object_writes
WHEN NEW.token<>OLD.token OR NEW.binding<>OLD.binding OR NEW.object_key<>OLD.object_key OR NEW.incarnation<>OLD.incarnation
 OR NEW.started_at<>OLD.started_at OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'staging_ticket_immutable'); END;
CREATE TRIGGER staging_object_deletes_identity BEFORE UPDATE ON staging_object_deletes
WHEN NEW.token<>OLD.token OR NEW.binding<>OLD.binding OR NEW.object_key<>OLD.object_key OR NEW.incarnation<>OLD.incarnation
 OR NEW.started_at<>OLD.started_at OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'staging_ticket_immutable'); END;
CREATE TRIGGER staging_reference_publication_composition_nodes BEFORE INSERT ON publication_composition_nodes
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key=NEW.object_key AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER staging_reference_publication_export_components BEFORE INSERT ON publication_export_components
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key=NEW.object_key AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER staging_reference_publication_export_nodes BEFORE INSERT ON publication_export_nodes
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key=NEW.object_key AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER staging_reference_catalogue_exports BEFORE INSERT ON catalogue_exports
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key=NEW.manifest_key AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER staging_reference_artifact BEFORE INSERT ON publication_preparation_artifacts
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding=CASE WHEN NEW.kind='printing_images' THEN 'PRINTING_IMAGES' ELSE 'CATALOGUE_EXPORTS' END
 AND object_key=NEW.object_key AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER staging_reference_candidate_images BEFORE INSERT ON game_candidate_partitions
WHEN NEW.kind='printing_images' AND EXISTS(SELECT 1 FROM staging_objects WHERE binding='PRINTING_IMAGES'
 AND state<>'available' AND instr(NEW.content,json_quote(object_key))>0)
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;

CREATE TRIGGER evidence_cleanup_scope_immutable BEFORE UPDATE ON evidence_cleanup_operations
WHEN NEW.scope<>OLD.scope OR NEW.preparation_id IS NOT OLD.preparation_id
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_identity_immutable'); END;
CREATE INDEX staging_object_cursor ON staging_objects(binding||':'||object_key);
CREATE INDEX staging_inventory_cursor ON staging_object_writes(preparation_id,binding||':'||object_key);
CREATE INDEX staging_writer_cursor ON staging_object_writes(binding||':'||object_key,incarnation,completed_at);
CREATE INDEX staging_deleter_cursor ON staging_object_deletes(binding||':'||object_key,incarnation,completed_at);
CREATE INDEX cleanup_artifact_key ON publication_preparation_artifacts(object_key,kind);
CREATE INDEX cleanup_node_key ON publication_composition_nodes(object_key);
CREATE INDEX cleanup_export_component_key ON publication_export_components(object_key);
CREATE INDEX cleanup_export_node_key ON publication_export_nodes(object_key);
CREATE INDEX cleanup_export_root_key ON publication_export_preparations(root_object_key);
CREATE INDEX cleanup_candidate_image_partition ON game_candidate_partitions(kind) WHERE kind='printing_images';
CREATE TRIGGER staging_reference_private_root BEFORE UPDATE OF root_digest ON publication_preparations
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key='publication-artifacts/'||NEW.root_digest AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER staging_reference_public_root BEFORE UPDATE OF root_object_key ON publication_export_preparations
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key=NEW.root_object_key AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;

CREATE TRIGGER staging_reference_public_root_insert BEFORE INSERT ON publication_export_preparations
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key=NEW.root_object_key AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER staging_reference_composition BEFORE INSERT ON verified_publication_compositions
WHEN EXISTS(SELECT 1 FROM staging_objects WHERE binding='CATALOGUE_EXPORTS' AND object_key='publication-artifacts/'||NEW.sha256 AND state<>'available')
BEGIN SELECT RAISE(ABORT,'staging_reference_fenced'); END;
CREATE TRIGGER cleanup_reference_request_insert BEFORE INSERT ON source_requests
WHEN EXISTS(SELECT 1 FROM evidence_cleanup_snapshot_keys keys JOIN evidence_cleanup_objects deleted ON deleted.object_key=keys.object_key
 WHERE keys.snapshot_id=NEW.source_snapshot_id)
BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;
UPDATE catalogue_schema_state SET migration_level=24 WHERE singleton=1;
