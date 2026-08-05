PRAGMA foreign_keys = ON;

ALTER TABLE operation_state ADD COLUMN active_release_id TEXT;
ALTER TABLE operation_state ADD COLUMN active_release_expires_at TEXT;

-- A production release reserves the legacy ingestion lock before this migration
-- can add the dedicated release lease. The reserved row exists only so the
-- previously deployed ingestion worker recognises that lock as live. Once its
-- exact operation-state pointer is gone it is safe to remove; all domain runs
-- remain immutable.
DROP TRIGGER guard_ingestion_deletion;
CREATE TRIGGER guard_ingestion_deletion
BEFORE DELETE ON ingestion_runs
WHEN NOT (
  OLD.id LIKE 'release-bootstrap|%'
  AND OLD.idempotency_key = OLD.id
  AND OLD.selected_games_json = '[]'
  AND OLD.candidate_json = '{"production_release_bootstrap":true}'
  AND OLD.state IN ('planning', 'failed')
  AND NOT EXISTS (
    SELECT 1 FROM operation_state
    WHERE singleton = 1 AND active_ingestion_run_id = OLD.id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_audit_immutable');
END;

DROP TRIGGER guard_ingestion_transition_delete;
CREATE TRIGGER guard_ingestion_transition_delete
BEFORE DELETE ON ingestion_run_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs AS run
  WHERE run.id = OLD.ingestion_run_id
    AND run.id LIKE 'release-bootstrap|%'
    AND run.idempotency_key = run.id
    AND run.selected_games_json = '[]'
    AND run.candidate_json = '{"production_release_bootstrap":true}'
    AND run.state IN ('planning', 'failed')
    AND NOT EXISTS (
      SELECT 1 FROM operation_state
      WHERE singleton = 1 AND active_ingestion_run_id = run.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ingestion_transition_audit_immutable');
END;

CREATE TRIGGER production_release_lease_shape_guard
BEFORE UPDATE OF active_release_id, active_release_expires_at ON operation_state
WHEN (NEW.active_release_id IS NULL) <> (NEW.active_release_expires_at IS NULL)
  OR (NEW.active_release_expires_at IS NOT NULL AND (
    NEW.active_release_expires_at NOT GLOB
      '????-??-??T??:??:??.???Z'
    OR julianday(NEW.active_release_expires_at) IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'production_release_lease_invalid');
END;

DROP TRIGGER require_idle_ingestion;
CREATE TRIGGER require_idle_ingestion
BEFORE INSERT ON ingestion_runs
WHEN EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1 AND (
    active_ingestion_run_id IS NOT NULL OR (
      active_release_id IS NOT NULL
      AND active_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'active_ingestion_run_or_release');
END;

CREATE TABLE curated_revisions (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL CHECK (
    game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  target_key TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('field', 'relationship')),
  effective_from TEXT,
  effective_to TEXT,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  reviewed_source_digest TEXT NOT NULL CHECK (
    length(reviewed_source_digest) = 64 AND reviewed_source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  schema_binding_json TEXT NOT NULL CHECK (json_valid(schema_binding_json)),
  author TEXT NOT NULL CHECK (length(author) > 0),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'superseded', 'retired', 'reconfirmation_required')
  ),
  event_version INTEGER NOT NULL CHECK (event_version >= 1)
);

CREATE INDEX curated_revisions_active_target
ON curated_revisions (target_key, status, effective_from, effective_to);

CREATE TRIGGER curated_revision_mutation_guard
BEFORE INSERT ON curated_revisions
WHEN EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1
    AND (active_ingestion_run_id IS NOT NULL OR recovery_health = 'blocked')
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_operation_not_idle');
END;

CREATE TRIGGER curated_revision_release_guard
BEFORE INSERT ON curated_revisions
WHEN EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1 AND active_release_id IS NOT NULL
    AND active_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_release_not_idle');
END;

CREATE TRIGGER curated_revision_catalogue_revision_guard
BEFORE INSERT ON curated_revisions
WHEN COALESCE(json_extract(
  NEW.schema_binding_json,
  '$.catalogue_revision_id'
), '') <> (
  SELECT current_revision_id FROM catalogue_state WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_current_revision_mismatch');
END;

CREATE TRIGGER curated_revision_target_overlap_guard
BEFORE INSERT ON curated_revisions
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM curated_revisions AS existing
  WHERE existing.status IN ('active', 'reconfirmation_required')
    AND existing.target_key = NEW.target_key
    AND (existing.effective_to IS NULL OR NEW.effective_from IS NULL
      OR NEW.effective_from < existing.effective_to)
    AND (NEW.effective_to IS NULL OR existing.effective_from IS NULL
      OR existing.effective_from < NEW.effective_to)
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_target_conflict');
END;

CREATE TRIGGER curated_revisions_are_immutable_on_update
BEFORE UPDATE OF game, target_key, target_kind, effective_from, effective_to,
  proposal_json, content_digest, reviewed_source_digest, schema_binding_json,
  author, created_at
ON curated_revisions
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_immutable');
END;

CREATE TRIGGER curated_revisions_are_immutable_on_delete
BEFORE DELETE ON curated_revisions
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_immutable');
END;

CREATE TABLE curated_revision_events (
  revision_id TEXT NOT NULL REFERENCES curated_revisions(id),
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  kind TEXT NOT NULL CHECK (
    kind IN ('authored', 'source_change_detected', 'reaffirmed', 'superseded', 'retired')
  ),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  created_at TEXT NOT NULL,
  author TEXT NOT NULL,
  PRIMARY KEY (revision_id, event_version)
);

CREATE TRIGGER curated_revision_owner_event_operation_guard
BEFORE INSERT ON curated_revision_events
WHEN NEW.kind IN ('reaffirmed', 'superseded', 'retired') AND EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1
    AND (active_ingestion_run_id IS NOT NULL OR recovery_health = 'blocked')
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_operation_not_idle');
END;

CREATE TRIGGER curated_revision_owner_event_release_guard
BEFORE INSERT ON curated_revision_events
WHEN NEW.kind IN ('reaffirmed', 'superseded', 'retired') AND EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1 AND active_release_id IS NOT NULL
    AND active_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_release_not_idle');
END;

CREATE TRIGGER curated_revision_owner_event_catalogue_guard
BEFORE INSERT ON curated_revision_events
WHEN NEW.kind IN ('reaffirmed', 'superseded', 'retired')
  AND COALESCE(json_extract(
    NEW.event_json,
    '$.expected_current_revision_id'
  ), '') <> (
    SELECT current_revision_id FROM catalogue_state WHERE singleton = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_current_revision_mismatch');
END;

CREATE TRIGGER curated_revision_events_are_immutable_on_update
BEFORE UPDATE ON curated_revision_events
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_event_immutable');
END;

CREATE TRIGGER curated_revision_events_are_immutable_on_delete
BEFORE DELETE ON curated_revision_events
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_event_immutable');
END;

CREATE TABLE curated_revision_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  response_status INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER curated_revision_idempotency_is_immutable_on_update
BEFORE UPDATE ON curated_revision_idempotency
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_idempotency_immutable');
END;

CREATE TRIGGER curated_revision_idempotency_is_immutable_on_delete
BEFORE DELETE ON curated_revision_idempotency
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_idempotency_immutable');
END;

CREATE TABLE ingestion_run_curated_revisions (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision_id TEXT NOT NULL REFERENCES curated_revisions(id),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  reviewed_source_digest TEXT NOT NULL CHECK (
    length(reviewed_source_digest) = 64 AND reviewed_source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (ingestion_run_id, ordinal),
  UNIQUE (ingestion_run_id, revision_id)
);

CREATE TABLE ingestion_run_curated_revision_sets (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  revision_ids_json TEXT NOT NULL CHECK (json_valid(revision_ids_json)),
  set_digest TEXT NOT NULL CHECK (
    length(set_digest) = 64 AND set_digest NOT GLOB '*[^0-9a-f]*'
      AND set_digest <> '0000000000000000000000000000000000000000000000000000000000000000'
  ),
  pinned_at TEXT NOT NULL
);

CREATE TRIGGER curated_revision_pin_set_matches_run_start
BEFORE INSERT ON ingestion_run_curated_revision_sets
WHEN NEW.revision_ids_json <> COALESCE((
  SELECT json_group_array(id) FROM (
    SELECT revision.id
    FROM curated_revisions AS revision
    JOIN ingestion_runs AS run ON run.id = NEW.ingestion_run_id
    WHERE revision.status = 'active'
      AND revision.game IN (SELECT value FROM json_each(run.selected_games_json))
      AND (revision.effective_from IS NULL OR revision.effective_from <= substr(run.started_at, 1, 10))
      AND (revision.effective_to IS NULL OR substr(run.started_at, 1, 10) < revision.effective_to)
    ORDER BY revision.id
  )
), '[]')
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_pin_set_changed');
END;

CREATE TRIGGER curated_revision_pins_are_immutable_on_update
BEFORE UPDATE ON ingestion_run_curated_revisions
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_pin_immutable');
END;

CREATE TRIGGER curated_revision_pins_are_immutable_on_delete
BEFORE DELETE ON ingestion_run_curated_revisions
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_pin_immutable');
END;

CREATE TRIGGER curated_revision_pin_sets_are_immutable_on_update
BEFORE UPDATE ON ingestion_run_curated_revision_sets
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_pin_set_immutable');
END;

CREATE TRIGGER curated_revision_pin_sets_are_immutable_on_delete
BEFORE DELETE ON ingestion_run_curated_revision_sets
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_pin_set_immutable');
END;

CREATE TRIGGER curated_revision_reconfirmation_blocks_run
BEFORE INSERT ON ingestion_runs
WHEN EXISTS (
  SELECT 1 FROM curated_revisions AS revision
  WHERE revision.status = 'reconfirmation_required'
    AND revision.game IN (
      SELECT value FROM json_each(NEW.selected_games_json)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'curated_revision_reconfirmation_required');
END;

CREATE TABLE catalogue_curated_provenance (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  curated_revision_id TEXT NOT NULL REFERENCES curated_revisions(id),
  target_key TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (catalogue_revision_id, curated_revision_id)
);

CREATE TRIGGER catalogue_curated_provenance_is_immutable_on_update
BEFORE UPDATE ON catalogue_curated_provenance
BEGIN
  SELECT RAISE(ABORT, 'catalogue_curated_provenance_immutable');
END;

CREATE TRIGGER catalogue_curated_provenance_is_immutable_on_delete
BEFORE DELETE ON catalogue_curated_provenance
BEGIN
  SELECT RAISE(ABORT, 'catalogue_curated_provenance_immutable');
END;

CREATE TABLE retained_source_observation_evidence (
  source_observation_id TEXT PRIMARY KEY,
  retained_by_table TEXT NOT NULL CHECK (
    retained_by_table IN (
      'reconciliation_candidates',
      'legality_rules',
      'revision_products',
      'reconciled_product_relationships'
    )
  ),
  retained_record_id TEXT NOT NULL
);

INSERT OR IGNORE INTO retained_source_observation_evidence
  (source_observation_id, retained_by_table, retained_record_id)
SELECT source_observation_id, 'reconciliation_candidates',
       source_observation_set_id
FROM reconciliation_candidates;

INSERT OR IGNORE INTO retained_source_observation_evidence
  (source_observation_id, retained_by_table, retained_record_id)
SELECT source_observation_id, 'legality_rules', id
FROM legality_rules;

INSERT OR IGNORE INTO retained_source_observation_evidence
  (source_observation_id, retained_by_table, retained_record_id)
SELECT json_extract(evidence.value, '$.id'),
       'revision_products', product.product_id
FROM revision_products AS product,
     json_each(product.document_json, '$.included') AS evidence
WHERE json_extract(evidence.value, '$.type') = 'source_observation'
  AND json_extract(evidence.value, '$.id') IS NOT NULL;

INSERT OR IGNORE INTO retained_source_observation_evidence
  (source_observation_id, retained_by_table, retained_record_id)
SELECT observation.value, 'reconciled_product_relationships', relationship.id
FROM reconciled_product_relationships AS relationship,
     json_each(relationship.source_observation_ids_json) AS observation;

CREATE TRIGGER retained_source_observation_evidence_must_resolve
BEFORE INSERT ON retained_source_observation_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM reconciliation_candidates
  WHERE source_observation_id = NEW.source_observation_id
    AND source_observation_set_id = NEW.retained_record_id
) AND NOT EXISTS (
  SELECT 1 FROM legality_rules
  WHERE source_observation_id = NEW.source_observation_id
    AND id = NEW.retained_record_id
) AND NOT EXISTS (
  SELECT 1
  FROM revision_products AS product,
       json_each(product.document_json, '$.included') AS evidence
  WHERE product.product_id = NEW.retained_record_id
    AND json_extract(evidence.value, '$.type') = 'source_observation'
    AND json_extract(evidence.value, '$.id') = NEW.source_observation_id
) AND NOT EXISTS (
  SELECT 1
  FROM reconciled_product_relationships AS relationship,
       json_each(relationship.source_observation_ids_json) AS observation
  WHERE relationship.id = NEW.retained_record_id
    AND observation.value = NEW.source_observation_id
)
BEGIN
  SELECT RAISE(ABORT, 'retained_source_observation_evidence_not_found');
END;

CREATE TRIGGER retained_source_observation_evidence_is_immutable_on_update
BEFORE UPDATE ON retained_source_observation_evidence
BEGIN
  SELECT RAISE(ABORT, 'retained_source_observation_evidence_immutable');
END;

CREATE TRIGGER retained_source_observation_evidence_is_immutable_on_delete
BEFORE DELETE ON retained_source_observation_evidence
BEGIN
  SELECT RAISE(ABORT, 'retained_source_observation_evidence_immutable');
END;

CREATE TRIGGER retain_reconciliation_candidate_evidence
AFTER INSERT ON reconciliation_candidates
BEGIN
  INSERT OR IGNORE INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  VALUES (
    NEW.source_observation_id,
    'reconciliation_candidates',
    NEW.source_observation_set_id
  );
END;

CREATE TRIGGER retain_legality_rule_evidence
AFTER INSERT ON legality_rules
BEGIN
  INSERT OR IGNORE INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  VALUES (NEW.source_observation_id, 'legality_rules', NEW.id);
END;

CREATE TRIGGER retain_revision_product_evidence
AFTER INSERT ON revision_products
BEGIN
  INSERT OR IGNORE INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT json_extract(evidence.value, '$.id'),
         'revision_products', NEW.product_id
  FROM json_each(NEW.document_json, '$.included') AS evidence
  WHERE json_extract(evidence.value, '$.type') = 'source_observation'
    AND json_extract(evidence.value, '$.id') IS NOT NULL;
END;

CREATE TRIGGER retain_product_relationship_evidence
AFTER INSERT ON reconciled_product_relationships
BEGIN
  INSERT OR IGNORE INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT observation.value,
         'reconciled_product_relationships', NEW.id
  FROM json_each(NEW.source_observation_ids_json) AS observation;
END;

CREATE TRIGGER retain_updated_product_relationship_evidence
AFTER UPDATE OF source_observation_ids_json
ON reconciled_product_relationships
BEGIN
  INSERT OR IGNORE INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT observation.value,
         'reconciled_product_relationships', NEW.id
  FROM json_each(NEW.source_observation_ids_json) AS observation;
END;
