-- #329: immutable retained discovery ancestors; preserve 0038 direct sibling retention.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=38
THEN 1 ELSE json_extract('schema_level_mismatch_expected_38','$') END;

CREATE TABLE source_parse_contexts (
      parse_operation_id TEXT PRIMARY KEY REFERENCES source_parse_operations(id),
      dependency_count INTEGER NOT NULL CHECK(dependency_count BETWEEN 0 AND 3),
      maximum_context_bytes INTEGER NOT NULL CHECK(maximum_context_bytes BETWEEN 1 AND 3145728)
    );

CREATE TABLE source_parse_dependencies (
      parse_operation_id TEXT NOT NULL REFERENCES source_parse_operations(id),
      ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
      parent_source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
      PRIMARY KEY(parse_operation_id,ordinal),
      UNIQUE(parse_operation_id,parent_source_snapshot_id)
    );

CREATE INDEX source_parse_dependencies_parent ON source_parse_dependencies(parent_source_snapshot_id,parse_operation_id);

CREATE INDEX source_snapshots_run_request ON source_snapshots(ingestion_run_id,request_id);

CREATE TRIGGER source_parse_contexts_validate BEFORE INSERT ON source_parse_contexts
      WHEN (SELECT state FROM source_parse_operations WHERE id=NEW.parse_operation_id)<>'planned'
        OR EXISTS(SELECT 1 FROM source_record_progress progress JOIN source_parse_operations p
          ON p.observation_set_id=progress.observation_set_id WHERE p.id=NEW.parse_operation_id)
        OR NEW.dependency_count<>(SELECT COUNT(*) FROM source_parse_dependencies WHERE parse_operation_id=NEW.parse_operation_id)
        OR NEW.dependency_count<>COALESCE((SELECT MAX(ordinal)+1 FROM source_parse_dependencies WHERE parse_operation_id=NEW.parse_operation_id),0)
        OR NEW.maximum_context_bytes<(SELECT COALESCE(SUM(s.content_byte_length),0) FROM source_parse_dependencies d
          JOIN source_snapshots s ON s.id=d.parent_source_snapshot_id WHERE d.parse_operation_id=NEW.parse_operation_id)
        OR EXISTS(SELECT 1 FROM source_parse_operations operation
          JOIN source_snapshots child ON child.id=operation.source_snapshot_id
          JOIN source_requests child_request ON child_request.ingestion_run_id=child.ingestion_run_id
            AND child_request.request_id=child.request_id
          WHERE operation.id=NEW.parse_operation_id AND (
            child_request.request_role='image'
            OR (NEW.dependency_count=0 AND child_request.discovered_from_request_id IS NOT NULL)
            OR EXISTS(SELECT 1 FROM source_parse_dependencies dependency
              JOIN source_snapshots parent ON parent.id=dependency.parent_source_snapshot_id
              JOIN source_requests request ON request.ingestion_run_id=parent.ingestion_run_id
                AND request.request_id=parent.request_id
              WHERE dependency.parse_operation_id=NEW.parse_operation_id AND (
                parent.ingestion_run_id<>child.ingestion_run_id
                OR parent.source_lineage<>child.source_lineage
                OR parent.adapter_version<>child.adapter_version
                OR parent.supported_game<>child.supported_game
                OR parent.game_profile_version<>child.game_profile_version
                OR parent.request_url<>request.url OR request.request_role='image'
                OR request.source_snapshot_id IS NOT parent.id
                OR parent.request_id IS NOT CASE WHEN dependency.ordinal=0
                  THEN child_request.discovered_from_request_id ELSE
                    (SELECT preceding_request.discovered_from_request_id FROM source_parse_dependencies preceding
                      JOIN source_snapshots preceding_snapshot ON preceding_snapshot.id=preceding.parent_source_snapshot_id
                      JOIN source_requests preceding_request ON preceding_request.ingestion_run_id=preceding_snapshot.ingestion_run_id
                        AND preceding_request.request_id=preceding_snapshot.request_id
                      WHERE preceding.parse_operation_id=NEW.parse_operation_id AND preceding.ordinal=dependency.ordinal-1) END
                OR (dependency.ordinal=NEW.dependency_count-1 AND request.discovered_from_request_id IS NOT NULL)
                OR NOT EXISTS(SELECT 1 FROM source_parse_operations parsed
                  JOIN source_record_progress progress ON progress.observation_set_id=parsed.observation_set_id
                  WHERE parsed.source_snapshot_id=parent.id AND parsed.intent='collection'
                    AND parsed.state='finalized' AND progress.sealed=1)
                OR EXISTS(SELECT 1 FROM source_snapshots alternative
                  WHERE alternative.ingestion_run_id=parent.ingestion_run_id AND alternative.request_id=parent.request_id
                    AND alternative.id<>parent.id AND alternative.request_url=request.url
                    AND EXISTS(SELECT 1 FROM source_parse_operations parsed
                      JOIN source_record_progress progress ON progress.observation_set_id=parsed.observation_set_id
                      WHERE parsed.source_snapshot_id=alternative.id AND parsed.intent='collection'
                        AND parsed.state='finalized' AND progress.sealed=1))
              ))))
      BEGIN SELECT RAISE(ABORT,'source_parse_context_invalid'); END;

CREATE TRIGGER source_parse_contexts_immutable_update BEFORE UPDATE ON source_parse_contexts
      BEGIN SELECT RAISE(ABORT,'source_parse_context_immutable'); END;

CREATE TRIGGER source_parse_contexts_immutable_delete BEFORE DELETE ON source_parse_contexts
      BEGIN SELECT RAISE(ABORT,'source_parse_context_immutable'); END;

CREATE TRIGGER source_parse_dependencies_sealed BEFORE INSERT ON source_parse_dependencies
      WHEN EXISTS(SELECT 1 FROM source_parse_contexts WHERE parse_operation_id=NEW.parse_operation_id)
      BEGIN SELECT RAISE(ABORT,'source_parse_context_immutable'); END;

CREATE TRIGGER source_parse_dependencies_immutable_update BEFORE UPDATE ON source_parse_dependencies
      BEGIN SELECT RAISE(ABORT,'source_parse_context_immutable'); END;

CREATE TRIGGER source_parse_dependencies_immutable_delete BEFORE DELETE ON source_parse_dependencies
      BEGIN SELECT RAISE(ABORT,'source_parse_context_immutable'); END;

-- Literal ownership is intentionally separate from inherited parent dependencies.
CREATE VIEW evidence_cleanup_direct_snapshot_keys AS
 SELECT id AS snapshot_id,content_object_key AS object_key FROM source_snapshots
 UNION SELECT source_snapshot_id,content_object_key FROM source_parse_operations
 UNION SELECT block.source_snapshot_id,block.object_key FROM source_archive_blocks block
 JOIN source_archive_decodes d ON d.source_snapshot_id=block.source_snapshot_id AND d.state='decoded'
 WHERE block.state='retained' AND EXISTS(SELECT 1 FROM source_observation_sets s WHERE s.source_snapshot_id=d.source_snapshot_id);

CREATE VIEW evidence_cleanup_dependency_keys AS
      SELECT child.source_snapshot_id AS snapshot_id,parent.object_key
      FROM source_parse_dependencies dependency
      JOIN source_parse_contexts context ON context.parse_operation_id=dependency.parse_operation_id
      JOIN source_parse_operations child ON child.id=dependency.parse_operation_id
      JOIN evidence_cleanup_direct_snapshot_keys parent ON parent.snapshot_id=dependency.parent_source_snapshot_id;

DROP VIEW evidence_cleanup_snapshot_keys;

CREATE VIEW evidence_cleanup_snapshot_keys AS
      SELECT snapshot_id,object_key FROM evidence_cleanup_direct_snapshot_keys
      UNION SELECT snapshot_id,object_key FROM evidence_cleanup_dependency_keys;

DROP VIEW evidence_cleanup_retained_keys;

CREATE VIEW evidence_cleanup_retained_keys AS
      SELECT keys.object_key FROM evidence_cleanup_snapshot_keys keys
      JOIN evidence_cleanup_retained_snapshots retained ON retained.snapshot_id=keys.snapshot_id
      UNION SELECT object_key FROM evidence_object_references
      -- A pin retains every direct sibling introduced by 0038, plus its ancestors.
      UNION SELECT dependent.object_key FROM evidence_object_references reference
      JOIN evidence_cleanup_direct_snapshot_keys child ON child.object_key=reference.object_key
      JOIN evidence_cleanup_snapshot_keys dependent ON dependent.snapshot_id=child.snapshot_id;

CREATE TRIGGER source_parse_dependency_cleanup_guard BEFORE INSERT ON source_parse_dependencies
      WHEN EXISTS(SELECT 1 FROM evidence_cleanup_direct_snapshot_keys keys JOIN evidence_cleanup_objects claimed
        ON claimed.object_key=keys.object_key WHERE keys.snapshot_id=NEW.parent_source_snapshot_id)
      BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER source_parse_context_cleanup_guard BEFORE INSERT ON source_parse_contexts
      WHEN EXISTS(SELECT 1 FROM source_parse_operations p JOIN evidence_cleanup_direct_snapshot_keys keys
        ON keys.snapshot_id=p.source_snapshot_id JOIN evidence_cleanup_objects claimed ON claimed.object_key=keys.object_key
        WHERE p.id=NEW.parse_operation_id)
      BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

DROP TRIGGER evidence_cleanup_reference_guard;

CREATE TRIGGER evidence_cleanup_reference_guard BEFORE INSERT ON evidence_object_references
      WHEN EXISTS(SELECT 1 FROM evidence_cleanup_objects WHERE object_key=NEW.object_key)
        OR EXISTS(SELECT 1 FROM evidence_cleanup_direct_snapshot_keys child
          JOIN evidence_cleanup_snapshot_keys dependent ON dependent.snapshot_id=child.snapshot_id
          JOIN evidence_cleanup_objects claimed ON claimed.object_key=dependent.object_key
          WHERE child.object_key=NEW.object_key)
      BEGIN SELECT RAISE(ABORT,'evidence_cleanup_reference_fenced'); END;

CREATE TRIGGER recovery_fence_source_parse_contexts_insert BEFORE INSERT ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
           BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_source_parse_contexts_insert BEFORE INSERT ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
           BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_fence_source_parse_contexts_insert BEFORE INSERT ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications
             WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s
               JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.id=NEW.parse_operation_id)
             AND classification='abandoned_after_restore')
           BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER recovery_fence_source_parse_contexts_update BEFORE UPDATE ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
           BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_source_parse_contexts_update BEFORE UPDATE ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
           BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_fence_source_parse_contexts_update BEFORE UPDATE ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications
             WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s
               JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.id=NEW.parse_operation_id)
             AND classification='abandoned_after_restore')
           BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER recovery_fence_source_parse_contexts_delete BEFORE DELETE ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
           BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_source_parse_contexts_delete BEFORE DELETE ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
           BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_fence_source_parse_contexts_delete BEFORE DELETE ON source_parse_contexts
           WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications
             WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s
               JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.id=OLD.parse_operation_id)
             AND classification='abandoned_after_restore')
           BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER recovery_fence_source_parse_dependencies_insert BEFORE INSERT ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
           BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_source_parse_dependencies_insert BEFORE INSERT ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
           BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_fence_source_parse_dependencies_insert BEFORE INSERT ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications
             WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s
               JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.id=NEW.parse_operation_id)
             AND classification='abandoned_after_restore')
           BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER recovery_fence_source_parse_dependencies_update BEFORE UPDATE ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
           BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_source_parse_dependencies_update BEFORE UPDATE ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
           BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_fence_source_parse_dependencies_update BEFORE UPDATE ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications
             WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s
               JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.id=NEW.parse_operation_id)
             AND classification='abandoned_after_restore')
           BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

CREATE TRIGGER recovery_fence_source_parse_dependencies_delete BEFORE DELETE ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
           BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER handoff_fence_source_parse_dependencies_delete BEFORE DELETE ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
           BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

CREATE TRIGGER restored_collector_fence_source_parse_dependencies_delete BEFORE DELETE ON source_parse_dependencies
           WHEN EXISTS(SELECT 1 FROM catalogue_recovery_collection_classifications
             WHERE ingestion_run_id=(SELECT s.ingestion_run_id FROM source_snapshots s
               JOIN source_parse_operations p ON p.source_snapshot_id=s.id WHERE p.id=OLD.parse_operation_id)
             AND classification='abandoned_after_restore')
           BEGIN SELECT RAISE(ABORT,'restored_collection_abandoned'); END;

UPDATE catalogue_schema_state SET migration_level=39 WHERE singleton=1;
