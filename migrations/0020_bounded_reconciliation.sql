SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 19
  THEN 1 ELSE json_extract('schema_level_mismatch_expected_19', '$') END;

-- Immutable event order makes an admission snapshot independent of later intake.
CREATE TABLE entity_admission_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL REFERENCES entity_proposals(id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  UNIQUE(proposal_id, generation)
);
CREATE INDEX entity_admission_events_proposal_sequence ON entity_admission_events (proposal_id, sequence DESC);
INSERT INTO entity_admission_events (proposal_id, generation)
  SELECT id, 0 FROM entity_proposals ORDER BY id;
INSERT INTO entity_admission_events (proposal_id, generation)
  SELECT proposal_id, generation FROM entity_admission_decisions ORDER BY proposal_id, generation;
CREATE TRIGGER entity_admission_events_no_update BEFORE UPDATE ON entity_admission_events
BEGIN SELECT RAISE(ABORT, 'entity_admission_event_immutable'); END;
CREATE TRIGGER entity_admission_events_no_delete BEFORE DELETE ON entity_admission_events
BEGIN SELECT RAISE(ABORT, 'entity_admission_event_immutable'); END;
-- Existing pins already contain their complete immutable selection.
ALTER TABLE entity_admission_run_pins ADD COLUMN decision_cutoff INTEGER CHECK (decision_cutoff >= 0);

-- A retained reservation belongs to each run; the legacy singleton is only
-- the first live reservation used by conservative release/recovery idle gates.
CREATE TABLE ingestion_collection_reservations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id)
);
INSERT INTO ingestion_collection_reservations SELECT ingestion_run_id FROM ingestion_run_current;
CREATE TABLE game_candidate_slots (
  supported_game TEXT PRIMARY KEY,
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id)
);

CREATE TABLE reconciliation_operations (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  supported_game TEXT,
  expected_game_revision_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'paused', 'sealed', 'failed', 'abandoned')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  completed_partitions INTEGER NOT NULL DEFAULT 0 CHECK (completed_partitions >= 0),
  candidate_digest TEXT,
  manifest_digest TEXT,
  input_manifest_digest TEXT,
  definition_pins_json TEXT NOT NULL CHECK (json_valid(definition_pins_json)),
  observation_cutoff INTEGER NOT NULL,
  identity_decision_cutoff INTEGER NOT NULL,
  authority_decision_cutoff INTEGER NOT NULL,
  failure_code TEXT,
  terminal_result_json TEXT CHECK (terminal_result_json IS NULL OR
    (json_valid(terminal_result_json) AND length(CAST(terminal_result_json AS BLOB)) <= 49152))
);
CREATE TRIGGER reconciliation_operation_identity_immutable BEFORE UPDATE ON reconciliation_operations
WHEN NEW.id <> OLD.id OR NEW.ingestion_run_id <> OLD.ingestion_run_id
  OR NEW.supported_game IS NOT OLD.supported_game
  OR NEW.expected_game_revision_id IS NOT OLD.expected_game_revision_id
  OR NEW.created_at <> OLD.created_at OR NEW.deadline <> OLD.deadline
  OR NEW.definition_pins_json <> OLD.definition_pins_json
  OR NEW.observation_cutoff <> OLD.observation_cutoff
  OR NEW.identity_decision_cutoff <> OLD.identity_decision_cutoff
  OR NEW.authority_decision_cutoff <> OLD.authority_decision_cutoff
BEGIN SELECT RAISE(ABORT, 'reconciliation_operation_identity_immutable'); END;
CREATE TRIGGER reconciliation_verified_input_immutable BEFORE UPDATE ON reconciliation_operations
WHEN OLD.input_manifest_digest IS NOT NULL AND NEW.input_manifest_digest IS NOT OLD.input_manifest_digest
BEGIN SELECT RAISE(ABORT, 'reconciliation_verified_input_immutable'); END;
CREATE TRIGGER reconciliation_terminal_result_immutable BEFORE UPDATE ON reconciliation_operations
WHEN OLD.terminal_result_json IS NOT NULL AND NEW.terminal_result_json IS NOT OLD.terminal_result_json
BEGIN SELECT RAISE(ABORT, 'reconciliation_terminal_result_immutable'); END;
CREATE TRIGGER reconciliation_operation_no_delete BEFORE DELETE ON reconciliation_operations
BEGIN SELECT RAISE(ABORT, 'reconciliation_operation_audit_retained'); END;
CREATE UNIQUE INDEX legacy_reconciliation_for_run ON reconciliation_operations (ingestion_run_id) WHERE supported_game IS NULL;
-- Native mapping evidence is preparation-owned. A published source collection
-- never grants publication authority to a new preparation using its evidence.
CREATE TABLE reconciliation_source_mappings (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  entity_id TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('card', 'printing')),
  source_lineage TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL REFERENCES source_observation_sets(id),
  locator TEXT,
  variant_key TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB)) <= 524288),
  mapped_at TEXT NOT NULL,
  PRIMARY KEY (preparation_id, entity_id, source_observation_id)
);
CREATE TRIGGER reconciliation_source_mappings_no_update BEFORE UPDATE ON reconciliation_source_mappings
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_mapping_immutable'); END;
CREATE TRIGGER reconciliation_source_mappings_no_delete BEFORE DELETE ON reconciliation_source_mappings
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_mapping_immutable'); END;
CREATE TABLE reconciliation_identity_reviews (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  review_id TEXT NOT NULL REFERENCES canonical_identity_reviews(id),
  source_observation_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  PRIMARY KEY (preparation_id, review_id)
);
CREATE TRIGGER reconciliation_identity_reviews_no_update BEFORE UPDATE ON reconciliation_identity_reviews
BEGIN SELECT RAISE(ABORT, 'reconciliation_identity_review_immutable'); END;
CREATE TRIGGER reconciliation_identity_reviews_no_delete BEFORE DELETE ON reconciliation_identity_reviews
BEGIN SELECT RAISE(ABORT, 'reconciliation_identity_review_immutable'); END;
CREATE TABLE reconciliation_curated_pins (
  preparation_id TEXT PRIMARY KEY REFERENCES reconciliation_operations(id),
  revision_cutoff INTEGER NOT NULL,
  event_cutoff INTEGER NOT NULL
);
CREATE TRIGGER reconciliation_curated_pins_no_update BEFORE UPDATE ON reconciliation_curated_pins
BEGIN SELECT RAISE(ABORT, 'reconciliation_curated_pin_immutable'); END;
CREATE TRIGGER reconciliation_curated_pins_no_delete BEFORE DELETE ON reconciliation_curated_pins
BEGIN SELECT RAISE(ABORT, 'reconciliation_curated_pin_immutable'); END;
-- SQLite appends rowid to these indexes, permitting bounded cutoff seeks.
CREATE INDEX curated_revisions_preparation_scan ON curated_revisions(game);
CREATE INDEX curated_revision_events_preparation_state ON curated_revision_events(revision_id);
CREATE INDEX curated_revision_events_preparation_reaffirm ON curated_revision_events(revision_id, kind);
CREATE TABLE game_catalogue_heads (
  supported_game TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL
);
-- Migration may traverse retained ancestry once; preparation creation reads one
-- indexed game head and never walks publication history.
WITH RECURSIVE ancestry(id, ingestion_run_id, previous_id, distance) AS (
  SELECT revision.id, revision.ingestion_run_id, revision.expected_previous_revision_id, 0
  FROM catalogue_revisions AS revision JOIN catalogue_state AS state ON state.current_revision_id = revision.id
  UNION ALL
  SELECT revision.id, revision.ingestion_run_id, revision.expected_previous_revision_id, ancestry.distance + 1
  FROM catalogue_revisions AS revision JOIN ancestry ON ancestry.previous_id = revision.id
), games(game) AS (VALUES ('one-piece'), ('fusion-world'), ('digimon'), ('gundam'))
INSERT INTO game_catalogue_heads (supported_game, revision_id)
SELECT game, COALESCE((SELECT ancestry.id FROM ancestry JOIN ingestion_run_selected_games AS selected
  ON selected.ingestion_run_id = ancestry.ingestion_run_id
  WHERE selected.game = games.game ORDER BY ancestry.distance LIMIT 1), 'catrev_spine_000') FROM games;
CREATE TABLE game_reconciliation_requests (
  idempotency_key TEXT PRIMARY KEY,
  preparation_id TEXT NOT NULL UNIQUE REFERENCES reconciliation_operations(id),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  workflow_params_json TEXT NOT NULL CHECK (json_valid(workflow_params_json)),
  workflow_instance_id TEXT NOT NULL UNIQUE
);
CREATE TRIGGER game_reconciliation_request_no_update BEFORE UPDATE ON game_reconciliation_requests
BEGIN SELECT RAISE(ABORT, 'game_reconciliation_request_immutable'); END;
CREATE TRIGGER game_reconciliation_request_no_delete BEFORE DELETE ON game_reconciliation_requests
BEGIN SELECT RAISE(ABORT, 'game_reconciliation_request_immutable'); END;
-- Pre-schema-20 run pins remain retained audit evidence. New preparations own
-- their decision snapshots independently, including preparations sharing a run.
CREATE TABLE reconciliation_admission_pins (
  preparation_id TEXT PRIMARY KEY REFERENCES reconciliation_operations(id),
  games_json TEXT NOT NULL CHECK (json_valid(games_json)),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  decision_cutoff INTEGER CHECK (decision_cutoff >= 0),
  legacy_selection_run_id TEXT REFERENCES entity_admission_run_pins(ingestion_run_id),
  CHECK ((decision_cutoff IS NULL) = (legacy_selection_run_id IS NOT NULL))
);
CREATE TABLE reconciliation_admission_decisions (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_admission_pins(preparation_id),
  proposal_id TEXT NOT NULL REFERENCES entity_proposals(id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  PRIMARY KEY (preparation_id, proposal_id)
);
CREATE INDEX reconciliation_admission_legacy_selection ON reconciliation_admission_pins (legacy_selection_run_id)
  WHERE legacy_selection_run_id IS NOT NULL;
CREATE TABLE reconciliation_correction_pins (
  preparation_id TEXT PRIMARY KEY REFERENCES reconciliation_operations(id),
  games_json TEXT NOT NULL CHECK (json_valid(games_json)),
  decision_cutoff INTEGER NOT NULL CHECK (decision_cutoff >= 0)
);
-- Reuse the immutable historical selection without copying an unbounded set
-- into the operation-creation transaction.
CREATE VIEW reconciliation_selected_admissions AS
SELECT preparation_id, proposal_id, generation FROM reconciliation_admission_decisions
UNION ALL
SELECT pin.preparation_id, decision.proposal_id, decision.generation
FROM reconciliation_admission_pins AS pin
JOIN entity_admission_pinned_decisions AS decision ON decision.ingestion_run_id = pin.legacy_selection_run_id;
CREATE TRIGGER reconciliation_legacy_selection_frozen BEFORE INSERT ON entity_admission_pinned_decisions
WHEN EXISTS (SELECT 1 FROM reconciliation_admission_pins WHERE legacy_selection_run_id = NEW.ingestion_run_id)
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TRIGGER reconciliation_legacy_selection_not_extended BEFORE INSERT ON reconciliation_admission_decisions
WHEN EXISTS (SELECT 1 FROM reconciliation_admission_pins
  WHERE preparation_id = NEW.preparation_id AND legacy_selection_run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TRIGGER reconciliation_admission_pins_no_update BEFORE UPDATE ON reconciliation_admission_pins
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TRIGGER reconciliation_admission_pins_no_delete BEFORE DELETE ON reconciliation_admission_pins
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TRIGGER reconciliation_admission_decisions_no_update BEFORE UPDATE ON reconciliation_admission_decisions
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TRIGGER reconciliation_admission_decisions_no_delete BEFORE DELETE ON reconciliation_admission_decisions
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TRIGGER reconciliation_correction_pins_no_update BEFORE UPDATE ON reconciliation_correction_pins
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TRIGGER reconciliation_correction_pins_no_delete BEFORE DELETE ON reconciliation_correction_pins
BEGIN SELECT RAISE(ABORT, 'reconciliation_decision_pin_immutable'); END;
CREATE TABLE reconciliation_record_partitions (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 524288),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 500),
  PRIMARY KEY (preparation_id, ordinal),
  CHECK (length(CAST(content AS BLOB)) = byte_length),
  CHECK (json_array_length(content) = record_count)
);
CREATE TRIGGER reconciliation_partition_no_update BEFORE UPDATE ON reconciliation_record_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_partition_immutable'); END;
CREATE TRIGGER reconciliation_partition_no_delete BEFORE DELETE ON reconciliation_record_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_partition_audit_retained'); END;
CREATE TABLE reconciliation_actions (
  idempotency_key TEXT PRIMARY KEY,
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
);
CREATE TRIGGER reconciliation_action_no_update BEFORE UPDATE ON reconciliation_actions
BEGIN SELECT RAISE(ABORT, 'reconciliation_action_immutable'); END;
CREATE TRIGGER reconciliation_action_no_delete BEFORE DELETE ON reconciliation_actions
BEGIN SELECT RAISE(ABORT, 'reconciliation_action_immutable'); END;
CREATE TABLE reconciliation_preparation_batches (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, ordinal)
);
CREATE TRIGGER reconciliation_preparation_no_update BEFORE UPDATE ON reconciliation_preparation_batches
BEGIN SELECT RAISE(ABORT, 'reconciliation_preparation_immutable'); END;
CREATE TRIGGER reconciliation_preparation_no_delete BEFORE DELETE ON reconciliation_preparation_batches
BEGIN SELECT RAISE(ABORT, 'reconciliation_preparation_audit_retained'); END;
CREATE TABLE reconciliation_input_partitions (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'
    AND length(CAST(content AS BLOB)) <= 524288 AND json_array_length(content) <= 500),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, ordinal)
);
CREATE TRIGGER reconciliation_input_no_update BEFORE UPDATE ON reconciliation_input_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_input_immutable'); END;
CREATE TRIGGER reconciliation_input_no_delete BEFORE DELETE ON reconciliation_input_partitions
BEGIN SELECT RAISE(ABORT, 'reconciliation_input_audit_retained'); END;
CREATE INDEX reconciliation_input_kind_cursor ON reconciliation_input_partitions(preparation_id, kind, ordinal);
CREATE TABLE reconciliation_observation_origins (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  observation_id TEXT NOT NULL,
  observation_set_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  PRIMARY KEY (preparation_id, observation_id)
);
CREATE TRIGGER reconciliation_observation_origin_no_update BEFORE UPDATE ON reconciliation_observation_origins
BEGIN SELECT RAISE(ABORT, 'reconciliation_observation_origin_immutable'); END;
CREATE TRIGGER reconciliation_observation_origin_no_delete BEFORE DELETE ON reconciliation_observation_origins
BEGIN SELECT RAISE(ABORT, 'reconciliation_observation_origin_audit_retained'); END;
CREATE TABLE reconciliation_normalized_observations (
  preparation_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  card_erratum_target_digest TEXT CHECK (card_erratum_target_digest IS NULL OR length(card_erratum_target_digest) = 64),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, observation_id),
  FOREIGN KEY (preparation_id, observation_id) REFERENCES reconciliation_observation_origins(preparation_id, observation_id)
);
CREATE INDEX reconciliation_normalized_card_erratum_target
ON reconciliation_normalized_observations (preparation_id, card_erratum_target_digest, observation_id);
CREATE TRIGGER reconciliation_normalized_no_update BEFORE UPDATE ON reconciliation_normalized_observations
BEGIN SELECT RAISE(ABORT, 'reconciliation_normalized_observation_immutable'); END;
CREATE TRIGGER reconciliation_normalized_no_delete BEFORE DELETE ON reconciliation_normalized_observations
BEGIN SELECT RAISE(ABORT, 'reconciliation_normalized_observation_audit_retained'); END;
CREATE TABLE game_candidates (
  id TEXT PRIMARY KEY,
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  supported_game TEXT NOT NULL,
  expected_game_revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'paused', 'sealed', 'failed', 'abandoned', 'rejected', 'expired', 'published')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  manifest_digest TEXT CHECK (manifest_digest IS NULL OR length(manifest_digest) = 64),
  preparation_manifest_digest TEXT CHECK (preparation_manifest_digest IS NULL OR length(preparation_manifest_digest) = 64),
  partition_count INTEGER NOT NULL DEFAULT 0 CHECK (partition_count >= 0),
  UNIQUE (preparation_id, supported_game)
);
CREATE TABLE reconciliation_source_byte_chunks (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  observation_set_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'
    AND json_array_length(content) = 1 AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, observation_set_id, ordinal)
);
CREATE TRIGGER reconciliation_source_bytes_no_update BEFORE UPDATE ON reconciliation_source_byte_chunks
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_bytes_immutable'); END;
CREATE TRIGGER reconciliation_source_bytes_no_delete BEFORE DELETE ON reconciliation_source_byte_chunks
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_bytes_retained'); END;
CREATE TABLE reconciliation_source_documents (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  observation_set_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 65536),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, observation_set_id)
);
CREATE TRIGGER reconciliation_source_header_no_update BEFORE UPDATE ON reconciliation_source_documents
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_header_immutable'); END;
CREATE TRIGGER reconciliation_source_header_no_delete BEFORE DELETE ON reconciliation_source_documents
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_header_retained'); END;
CREATE TABLE reconciliation_text_chunks (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 131072),
  PRIMARY KEY (preparation_id, sha256, ordinal)
);
CREATE TRIGGER reconciliation_text_no_update BEFORE UPDATE ON reconciliation_text_chunks
BEGIN SELECT RAISE(ABORT, 'reconciliation_text_immutable'); END;
CREATE TRIGGER reconciliation_text_no_delete BEFORE DELETE ON reconciliation_text_chunks
BEGIN SELECT RAISE(ABORT, 'reconciliation_text_audit_retained'); END;
CREATE TRIGGER game_candidate_identity_immutable BEFORE UPDATE ON game_candidates
WHEN NEW.id <> OLD.id OR NEW.preparation_id <> OLD.preparation_id OR NEW.supported_game <> OLD.supported_game
  OR NEW.ingestion_run_id <> OLD.ingestion_run_id
  OR NEW.expected_game_revision_id <> OLD.expected_game_revision_id OR NEW.created_at <> OLD.created_at OR NEW.deadline <> OLD.deadline
  OR (OLD.manifest_digest IS NOT NULL AND (NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.partition_count <> OLD.partition_count
    OR NEW.preparation_manifest_digest IS NOT OLD.preparation_manifest_digest))
BEGIN SELECT RAISE(ABORT, 'game_candidate_identity_immutable'); END;
CREATE TRIGGER game_candidate_no_delete BEFORE DELETE ON game_candidates
BEGIN SELECT RAISE(ABORT, 'game_candidate_audit_retained'); END;
CREATE TABLE game_candidate_entity_scopes (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  kind TEXT NOT NULL CHECK (kind IN ('cards', 'printings')),
  id TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  PRIMARY KEY (preparation_id, kind, id)
);
CREATE TRIGGER game_candidate_scope_no_update BEFORE UPDATE ON game_candidate_entity_scopes
BEGIN SELECT RAISE(ABORT, 'game_candidate_scope_immutable'); END;
CREATE TRIGGER game_candidate_scope_no_delete BEFORE DELETE ON game_candidate_entity_scopes
BEGIN SELECT RAISE(ABORT, 'game_candidate_scope_audit_retained'); END;
CREATE TABLE game_candidate_partitions (
  candidate_id TEXT NOT NULL REFERENCES game_candidates(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND json_type(content) = 'array'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 2 AND 524288 AND length(CAST(content AS BLOB)) = byte_length),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 500 AND json_array_length(content) = record_count),
  PRIMARY KEY (candidate_id, ordinal)
);
CREATE TRIGGER game_candidate_partition_no_update BEFORE UPDATE ON game_candidate_partitions
BEGIN SELECT RAISE(ABORT, 'game_candidate_partition_immutable'); END;
CREATE TRIGGER game_candidate_partition_no_delete BEFORE DELETE ON game_candidate_partitions
BEGIN SELECT RAISE(ABORT, 'game_candidate_partition_audit_retained'); END;
CREATE TABLE reconciliation_reducer_state (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  namespace TEXT NOT NULL,
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64),
  observation_ordinal INTEGER NOT NULL CHECK (observation_ordinal > 0),
  group_digest TEXT CHECK (group_digest IS NULL OR length(group_digest) = 64),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, namespace, key_digest, observation_ordinal)
);
CREATE INDEX reconciliation_reducer_state_group
ON reconciliation_reducer_state (preparation_id, namespace, group_digest, key_digest, observation_ordinal);
CREATE TRIGGER reconciliation_reducer_state_no_update BEFORE UPDATE ON reconciliation_reducer_state
BEGIN SELECT RAISE(ABORT, 'reconciliation_reducer_state_immutable'); END;
CREATE TRIGGER reconciliation_reducer_state_no_delete BEFORE DELETE ON reconciliation_reducer_state
BEGIN SELECT RAISE(ABORT, 'reconciliation_reducer_state_audit_retained'); END;
CREATE INDEX reconciliation_source_image_lookup ON source_snapshots (ingestion_run_id, source_lineage, request_url);
CREATE INDEX reconciliation_reducer_entity_cursor ON reconciliation_reducer_state
(preparation_id, namespace, json_extract(content, '$.value.id'), observation_ordinal);
CREATE INDEX reconciliation_plan_card ON reconciliation_reducer_state
(preparation_id, namespace, json_extract(content, '$.value.plan.cardId'), observation_ordinal);
CREATE INDEX reconciliation_plan_printing ON reconciliation_reducer_state
(preparation_id, namespace, json_extract(content, '$.value.plan.printingId'), observation_ordinal);
CREATE INDEX reconciliation_reducer_insertion_cursor ON reconciliation_reducer_state
(preparation_id, namespace, observation_ordinal);
CREATE TABLE reconciliation_sort_batches (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  namespace TEXT NOT NULL,
  pass INTEGER NOT NULL CHECK (pass >= 0),
  run_ordinal INTEGER NOT NULL CHECK (run_ordinal >= 0),
  batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal >= 0),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, namespace, pass, run_ordinal, batch_ordinal)
);
CREATE TRIGGER reconciliation_sort_batches_no_update BEFORE UPDATE ON reconciliation_sort_batches
BEGIN SELECT RAISE(ABORT, 'reconciliation_sort_batches_immutable'); END;
CREATE TRIGGER reconciliation_sort_batches_no_delete BEFORE DELETE ON reconciliation_sort_batches
BEGIN SELECT RAISE(ABORT, 'reconciliation_sort_batches_audit_retained'); END;
CREATE TABLE reconciliation_curated_conflicts (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  revision_id TEXT NOT NULL REFERENCES curated_revisions(id),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, revision_id)
);
CREATE TRIGGER reconciliation_curated_conflicts_no_update BEFORE UPDATE ON reconciliation_curated_conflicts
BEGIN SELECT RAISE(ABORT, 'reconciliation_curated_conflicts_immutable'); END;
CREATE TRIGGER reconciliation_curated_conflicts_no_delete BEFORE DELETE ON reconciliation_curated_conflicts
BEGIN SELECT RAISE(ABORT, 'reconciliation_curated_conflicts_audit_retained'); END;
-- Prepared conflicts become visible through the run's single terminal state flip.
-- Owner mutation materializes only its target revision before appending a later event.
CREATE INDEX reconciliation_curated_conflicts_revision ON reconciliation_curated_conflicts (revision_id, preparation_id);
CREATE VIEW visible_prepared_curated_conflicts AS
SELECT conflict.revision_id, conflict.content,
  json_extract(conflict.content, '$.eventVersion') AS event_version
FROM reconciliation_curated_conflicts AS conflict
JOIN reconciliation_operations AS preparation ON preparation.id = conflict.preparation_id
JOIN ingestion_run_current AS run ON run.ingestion_run_id = preparation.ingestion_run_id
JOIN curated_revisions AS revision ON revision.id = conflict.revision_id
WHERE ((preparation.supported_game IS NULL AND run.state = 'failed' AND run.failure_code = 'curated_revision_reconfirmation_required')
    OR (preparation.supported_game IS NOT NULL AND preparation.state = 'failed' AND preparation.failure_code = 'curated_revision_reconfirmation_required'))
  AND revision.status = 'active'
  AND json_extract(conflict.content, '$.eventVersion') = revision.event_version + 1;
CREATE VIEW curated_revision_read AS
SELECT revision.id, revision.game, revision.target_key, revision.target_kind,
  revision.effective_from, revision.effective_to, revision.proposal_json, revision.content_digest,
  revision.reviewed_source_digest, revision.schema_binding_json, revision.author, revision.created_at,
  CASE WHEN conflict.revision_id IS NULL THEN revision.status ELSE 'reconfirmation_required' END AS status,
  COALESCE(conflict.event_version, revision.event_version) AS event_version
FROM curated_revisions AS revision LEFT JOIN visible_prepared_curated_conflicts AS conflict ON conflict.revision_id = revision.id;
CREATE VIEW curated_revision_event_read AS
SELECT revision_id, event_version, kind, event_json, created_at, author FROM curated_revision_events
UNION ALL
SELECT conflict.revision_id, conflict.event_version, 'source_change_detected',
  json_extract(conflict.content, '$.details'), json_extract(conflict.content, '$.createdAt'), 'system'
FROM visible_prepared_curated_conflicts AS conflict
WHERE NOT EXISTS (SELECT 1 FROM curated_revision_events AS event
  WHERE event.revision_id = conflict.revision_id AND event.event_version = conflict.event_version);
CREATE TABLE reconciliation_checkpoints (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  phase TEXT NOT NULL CHECK (phase IN ('curated_diagnostics', 'candidate_partitions', 'source_mappings', 'warning_summary', 'candidate_staging', 'game_preparation', 'identity_lookup', 'payload_preparation:candidate', 'payload_preparation:digest', 'canonical_digest:catalogue', 'canonical_digest:candidate', 'semantic_preparation', 'identity_application', 'curated_revisions', 'source_selection', 'source_graph', 'graph_validation', 'source_documents', 'normalization', 'input_selection', 'input_verification', 'input_preparation', 'prior_state', 'initial_warnings', 'entity_admissions', 'admission_selection', 'identity_associations', 'official_reduction', 'official_errata', 'official_assembly', 'disappearance_warnings', 'withdrawal_diagnostics', 'product_reduction:one-piece', 'product_reduction:digimon', 'product_reduction:fusion-world', 'product_reduction:gundam') OR substr(phase, 1, 15) = 'record_sorting:' OR substr(phase, 1, 18) = 'workflow_dispatch:'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 65536),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, phase, ordinal)
);
CREATE TRIGGER reconciliation_checkpoints_no_update BEFORE UPDATE ON reconciliation_checkpoints
BEGIN SELECT RAISE(ABORT, 'reconciliation_checkpoint_immutable'); END;
CREATE TRIGGER reconciliation_checkpoints_no_delete BEFORE DELETE ON reconciliation_checkpoints
BEGIN SELECT RAISE(ABORT, 'reconciliation_checkpoint_audit_retained'); END;
CREATE TABLE reconciliation_source_observations (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  observation_set_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, observation_set_id, ordinal)
);
CREATE TRIGGER reconciliation_source_observations_no_update BEFORE UPDATE ON reconciliation_source_observations
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_observation_immutable'); END;
CREATE TRIGGER reconciliation_source_observations_no_delete BEFORE DELETE ON reconciliation_source_observations
BEGIN SELECT RAISE(ABORT, 'reconciliation_source_observation_audit_retained'); END;
CREATE TABLE reconciliation_evidence_selection (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  request_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 65536),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, request_id),
  UNIQUE (preparation_id, sequence_number, request_id)
);
CREATE TRIGGER reconciliation_evidence_selection_no_update BEFORE UPDATE ON reconciliation_evidence_selection
BEGIN SELECT RAISE(ABORT, 'reconciliation_evidence_selection_immutable'); END;
CREATE TRIGGER reconciliation_evidence_selection_no_delete BEFORE DELETE ON reconciliation_evidence_selection
BEGIN SELECT RAISE(ABORT, 'reconciliation_evidence_selection_audit_retained'); END;
UPDATE catalogue_schema_state SET migration_level = 20 WHERE singleton = 1;
