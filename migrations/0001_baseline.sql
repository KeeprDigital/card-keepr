-- Go-Live baseline: final pre-Go-Live schema through migration 0013.
-- Replayed from commit 23b1b11; object creation order preserves trigger order.
-- ADR 0006 / #136: apply only to a newly created, empty database.
-- The prior chain remains in git history; no historical data is migrated.
PRAGMA foreign_keys = ON;

CREATE TABLE catalogue_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_revision_id TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE TABLE operation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_ingestion_run_id TEXT,
  recovery_health TEXT NOT NULL CHECK (
    recovery_health IN ('healthy', 'degraded', 'blocked')
  ),
  active_recovery_id TEXT,
  recovery_restore_guard TEXT NOT NULL DEFAULT 'clear'
    CHECK (recovery_restore_guard IN ('clear', 'blocked')),
  active_production_release_id TEXT,
  active_production_release_expires_at TEXT
);

CREATE TABLE catalogue_schema_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  migration_level INTEGER NOT NULL CHECK (migration_level > 0)
);

CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  linked_run_id TEXT REFERENCES ingestion_runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  approval_idempotency_key TEXT UNIQUE,
  operational_request_id TEXT
);

CREATE TABLE catalogue_revisions (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL UNIQUE REFERENCES ingestion_runs(id),
  published_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  expected_previous_revision_id TEXT NOT NULL,
  approved_candidate_digest TEXT NOT NULL
);

CREATE TABLE revision_cards (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  card_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, card_id)
);

CREATE TABLE revision_printings (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  printing_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, printing_id)
);

CREATE TABLE catalogue_exports (
  catalogue_revision_id TEXT PRIMARY KEY REFERENCES catalogue_revisions(id),
  manifest_key TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK (verified = 1),
  maintenance_state TEXT NOT NULL
    DEFAULT 'available' CHECK (maintenance_state IN ('available', 'deleting', 'deleted')),
  deletion_operation_id TEXT,
  deleted_at TEXT
);

CREATE TABLE administration_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'problem')),
  created_at TEXT NOT NULL,
  claim_owner_token TEXT,
  claim_version INTEGER
);

CREATE TABLE administration_idempotency_claims (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_json TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  claim_version INTEGER NOT NULL,
  claim_expires_at TEXT NOT NULL
);

CREATE TABLE ingestion_no_change_results (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  catalogue_revision_id TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE ingestion_publication_cleanup (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'cleaning', 'completed', 'failed')
  ),
  object_keys_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  last_attempt_at TEXT,
  completed_at TEXT,
  not_before TEXT NOT NULL,
  idempotency_key TEXT,
  request_json TEXT,
  claim_token TEXT,
  claim_version INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TEXT
);

CREATE TRIGGER guard_administration_idempotency_update
BEFORE UPDATE ON administration_idempotency
BEGIN
  SELECT RAISE(ABORT, 'administration_idempotency_immutable');
END;

CREATE TRIGGER guard_administration_idempotency_delete
BEFORE DELETE ON administration_idempotency
BEGIN
  SELECT RAISE(ABORT, 'administration_idempotency_immutable');
END;

CREATE TRIGGER guard_no_change_result_update
BEFORE UPDATE ON ingestion_no_change_results
BEGIN
  SELECT RAISE(ABORT, 'ingestion_no_change_result_immutable');
END;

CREATE TRIGGER guard_no_change_result_delete
BEFORE DELETE ON ingestion_no_change_results
BEGIN
  SELECT RAISE(ABORT, 'ingestion_no_change_result_immutable');
END;

CREATE TABLE source_adapter_versions (
  adapter_version TEXT PRIMARY KEY,
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  parser_contract TEXT NOT NULL,
  adapter_origin TEXT NOT NULL DEFAULT 'production'
    CHECK (adapter_origin IN ('production', 'synthetic_fixture')),
  request_capacity INTEGER NOT NULL DEFAULT 5000
    CHECK (request_capacity BETWEEN 1 AND 24999),
  UNIQUE (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

CREATE TABLE ingestion_evidence_plans (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  request_plan_json TEXT NOT NULL,
  parent_workflow_id TEXT,
  child_workflow_ids_json TEXT,
  collection_completed_at TEXT,
  failure_code TEXT,
  plan_origin TEXT NOT NULL DEFAULT 'production'
    CHECK (plan_origin IN ('production', 'synthetic_fixture')),
  FOREIGN KEY (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  ) REFERENCES source_adapter_versions (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

CREATE TABLE source_requests (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  request_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method = 'GET'),
  url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  representation_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'captured', 'observed', 'failed')
  ),
  source_snapshot_id TEXT,
  failure_code TEXT,
  request_role TEXT NOT NULL DEFAULT 'surface'
    CHECK (
      request_role IN (
        'surface',
        'listing',
        'detail',
        'product_detail',
        'image'
      )
    ),
  discovered_from_request_id TEXT,
  retry_generation INTEGER NOT NULL DEFAULT 1
    CHECK (retry_generation >= 1),
  PRIMARY KEY (ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, sequence_number)
);

CREATE TABLE source_fetch_attempts (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'success',
      'cache_revalidated',
      'redirect',
      'http_failure',
      'network_failure',
      'body_failure',
      'storage_failure',
      'content_rejected'
    )
  ),
  http_status INTEGER,
  response_headers_json TEXT NOT NULL,
  retry_after_ms INTEGER,
  diagnostic TEXT,
  FOREIGN KEY (ingestion_run_id, request_id)
    REFERENCES source_requests(ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, request_id, attempt_number)
);

CREATE TABLE source_capture_operations (
  attempt_id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  source_snapshot_id TEXT NOT NULL UNIQUE,
  content_object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN (
      'planned',
      'response_received',
      'uploaded',
      'finalized',
      'failed'
    )
  ),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  request_headers_json TEXT,
  http_status INTEGER,
  response_headers_json TEXT,
  response_vary_json TEXT,
  media_type TEXT,
  content_digest TEXT,
  content_byte_length INTEGER,
  reused_source_snapshot_id TEXT REFERENCES source_snapshots(id),
  failure_outcome TEXT CHECK (
    failure_outcome IN (
      'network_failure',
      'body_failure',
      'storage_failure'
    )
  ),
  diagnostic TEXT,
  FOREIGN KEY (ingestion_run_id, request_id)
    REFERENCES source_requests(ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, request_id, attempt_number)
);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  request_id TEXT NOT NULL,
  fetch_attempt_id TEXT NOT NULL UNIQUE REFERENCES source_fetch_attempts(id),
  request_method TEXT NOT NULL,
  request_url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  representation_fingerprint TEXT NOT NULL,
  response_vary_json TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  response_headers_json TEXT NOT NULL,
  media_type TEXT,
  content_digest TEXT NOT NULL,
  content_byte_length INTEGER NOT NULL,
  content_object_key TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  reused_source_snapshot_id TEXT REFERENCES source_snapshots(id),
  FOREIGN KEY (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  ) REFERENCES source_adapter_versions (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

CREATE INDEX source_snapshots_revalidation
ON source_snapshots (
  source_lineage,
  request_url,
  adapter_version,
  representation_fingerprint,
  retrieved_at DESC
);

CREATE TABLE source_parse_operations (
  id TEXT PRIMARY KEY,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  adapter_version TEXT NOT NULL REFERENCES source_adapter_versions(adapter_version),
  intent TEXT NOT NULL CHECK (intent IN ('collection', 'reparse')),
  idempotency_key TEXT NOT NULL,
  observation_set_id TEXT NOT NULL UNIQUE,
  content_object_key TEXT NOT NULL UNIQUE,
  parsed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'uploaded', 'finalized')
  ),
  content_digest TEXT,
  content_byte_length INTEGER,
  observation_count INTEGER,
  UNIQUE (
    source_snapshot_id,
    adapter_version,
    intent,
    idempotency_key
  )
);

CREATE TABLE source_observation_sets (
  id TEXT PRIMARY KEY,
  parse_operation_id TEXT NOT NULL UNIQUE
    REFERENCES source_parse_operations(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  parsed_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_byte_length INTEGER NOT NULL,
  content_object_key TEXT NOT NULL UNIQUE,
  observation_count INTEGER NOT NULL,
  FOREIGN KEY (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  ) REFERENCES source_adapter_versions (
    adapter_version,
    source_lineage,
    supported_game,
    game_profile_version
  )
);

CREATE TABLE source_host_pacing (
  hostname TEXT PRIMARY KEY,
  next_request_not_before TEXT NOT NULL,
  locked_by TEXT,
  lease_expires_at TEXT
);

CREATE TRIGGER source_fetch_attempts_are_immutable_on_update
BEFORE UPDATE ON source_fetch_attempts
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_fetch_attempt');
END;

CREATE TRIGGER source_fetch_attempts_are_immutable_on_delete
BEFORE DELETE ON source_fetch_attempts
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_fetch_attempt');
END;

CREATE TRIGGER source_snapshots_are_immutable_on_update
BEFORE UPDATE ON source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_snapshot');
END;

CREATE TRIGGER source_snapshots_are_immutable_on_delete
BEFORE DELETE ON source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_snapshot');
END;

CREATE TRIGGER source_observation_sets_are_immutable_on_update
BEFORE UPDATE ON source_observation_sets
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_observation_set');
END;

CREATE TRIGGER source_observation_sets_are_immutable_on_delete
BEFORE DELETE ON source_observation_sets
BEGIN
  SELECT RAISE(ABORT, 'immutable_source_observation_set');
END;

CREATE TRIGGER ingestion_evidence_plan_origin_is_immutable
BEFORE UPDATE OF plan_origin ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'evidence_plan_origin_immutable');
END;

CREATE TABLE reconciled_cards (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  official_identity_kind TEXT NOT NULL,
  official_identity_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawal_revision_id TEXT REFERENCES catalogue_revisions(id),
  withdrawal_evidence_json TEXT,
  UNIQUE (
    supported_game,
    official_identity_kind,
    official_identity_value
  )
);

CREATE TABLE reconciled_printings (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES reconciled_cards(id),
  source_lineage TEXT NOT NULL,
  artwork_fingerprint TEXT NOT NULL,
  printed_fields_digest TEXT NOT NULL,
  rarity_normalized TEXT,
  treatment TEXT,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawal_revision_id TEXT REFERENCES catalogue_revisions(id),
  withdrawal_evidence_json TEXT
);

CREATE INDEX reconciled_printing_compatibility
ON reconciled_printings (
  card_id,
  source_lineage,
  artwork_fingerprint,
  printed_fields_digest,
  rarity_normalized,
  treatment
);

CREATE TABLE reconciled_printing_locators (
  printing_id TEXT NOT NULL REFERENCES reconciled_printings(id),
  source_lineage TEXT NOT NULL,
  locator TEXT NOT NULL,
  variant_key TEXT,
  variant_identity TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  PRIMARY KEY (source_lineage, locator, variant_identity)
);

CREATE TABLE reconciled_printing_memberships (
  printing_id TEXT NOT NULL REFERENCES reconciled_printings(id),
  source_lineage TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  relationship_kind TEXT NOT NULL CHECK (
    relationship_kind IN (
      'product',
      'distribution_context',
      'source_bucket'
    )
  ),
  relationship_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  PRIMARY KEY (
    printing_id,
    source_lineage,
    source_observation_id,
    relationship_kind,
    relationship_value
  )
);

CREATE TABLE reconciled_card_observations (
  card_id TEXT NOT NULL REFERENCES reconciled_cards(id),
  source_lineage TEXT NOT NULL,
  source_observation_id TEXT NOT NULL,
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  canonical_facts_json TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  PRIMARY KEY (card_id, source_lineage, source_observation_id)
);

CREATE TABLE reconciled_withdrawal_assertions (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('card', 'printing')),
  entity_id TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_observation_id TEXT NOT NULL,
  assertion TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'withdrawn'),
  effective_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  published_catalogue_revision_id TEXT NOT NULL
    REFERENCES catalogue_revisions(id),
  PRIMARY KEY (entity_type, entity_id, source_observation_id),
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

CREATE TRIGGER reconciled_withdrawal_assertions_are_immutable_on_update
BEFORE UPDATE ON reconciled_withdrawal_assertions
BEGIN
  SELECT RAISE(ABORT, 'withdrawal_assertion_immutable');
END;

CREATE TRIGGER reconciled_withdrawal_assertions_are_immutable_on_delete
BEFORE DELETE ON reconciled_withdrawal_assertions
BEGIN
  SELECT RAISE(ABORT, 'withdrawal_assertion_immutable');
END;

CREATE UNIQUE INDEX source_observation_set_snapshot_identity
ON source_observation_sets (id, source_snapshot_id);

CREATE TABLE reconciliation_candidates (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  printing_id TEXT,
  source_lineage TEXT NOT NULL,
  locator TEXT,
  variant_key TEXT,
  compatibility_json TEXT,
  memberships_json TEXT NOT NULL,
  withdrawal_json TEXT,
  warnings_json TEXT NOT NULL,
  digest_payload_json TEXT NOT NULL,
  observation_kind TEXT NOT NULL DEFAULT 'card_printing'
    CHECK (observation_kind IN ('card_printing', 'official_erratum')),
  source_card_facts_json TEXT CHECK (
    source_card_facts_json IS NULL OR json_valid(source_card_facts_json)
  ),
  PRIMARY KEY (ingestion_run_id, source_observation_id),
  UNIQUE (source_observation_set_id, source_observation_id),
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

CREATE TABLE reconciliation_evidence_partitions (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  sequence_number INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  source_observation_set_id TEXT NOT NULL REFERENCES source_observation_sets(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_lineage TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  game_profile_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, sequence_number),
  UNIQUE (ingestion_run_id, request_id),
  UNIQUE (source_observation_set_id),
  FOREIGN KEY (source_observation_set_id, source_snapshot_id)
    REFERENCES source_observation_sets (id, source_snapshot_id)
);

CREATE TABLE reconciliation_payload_chunks (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  payload_kind TEXT NOT NULL CHECK (
    payload_kind IN ('candidate', 'digest')
  ),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 524288),
  PRIMARY KEY (ingestion_run_id, payload_kind, chunk_index)
);

CREATE TRIGGER reconciliation_candidates_are_immutable_on_update
BEFORE UPDATE ON reconciliation_candidates
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_candidate_immutable');
END;

CREATE TRIGGER reconciliation_candidates_are_immutable_on_delete
BEFORE DELETE ON reconciliation_candidates
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_candidate_immutable');
END;

CREATE TRIGGER reconciliation_evidence_partitions_are_immutable_on_update
BEFORE UPDATE ON reconciliation_evidence_partitions
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_evidence_partition_immutable');
END;

CREATE TRIGGER reconciliation_evidence_partitions_are_immutable_on_delete
BEFORE DELETE ON reconciliation_evidence_partitions
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_evidence_partition_immutable');
END;

CREATE TRIGGER reconciliation_payload_chunks_are_immutable_on_update
BEFORE UPDATE ON reconciliation_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_payload_chunk_immutable');
END;

CREATE TRIGGER reconciliation_payload_chunks_are_immutable_on_delete
BEFORE DELETE ON reconciliation_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_payload_chunk_immutable');
END;

CREATE TRIGGER reconciled_card_identity_is_immutable
BEFORE UPDATE OF
  id,
  supported_game,
  official_identity_kind,
  official_identity_value,
  first_revision_id
ON reconciled_cards
BEGIN
  SELECT RAISE(ABORT, 'reconciled_card_identity_immutable');
END;

CREATE TRIGGER reconciled_printing_identity_is_immutable
BEFORE UPDATE OF
  id,
  card_id,
  source_lineage,
  artwork_fingerprint,
  printed_fields_digest,
  rarity_normalized,
  treatment,
  first_revision_id
ON reconciled_printings
BEGIN
  SELECT RAISE(ABORT, 'reconciled_printing_identity_immutable');
END;

CREATE TABLE revision_products (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  product_id TEXT NOT NULL,
  supported_game TEXT NOT NULL,
  official_code TEXT,
  name TEXT,
  search_text TEXT NOT NULL,
  release_regions_json TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, product_id)
);

CREATE INDEX revision_products_catalogue_order
ON revision_products (
  catalogue_revision_id,
  supported_game,
  (official_code IS NULL),
  official_code,
  (name IS NULL),
  name,
  product_id
);

CREATE VIRTUAL TABLE revision_products_fts USING fts5(
  catalogue_revision_id UNINDEXED,
  product_id UNINDEXED,
  search_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE reconciled_printing_images (
  id TEXT PRIMARY KEY,
  printing_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('front', 'back', 'other')),
  media_type TEXT NOT NULL CHECK (media_type LIKE 'image/%'),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND
    content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  content_byte_length INTEGER NOT NULL CHECK (content_byte_length > 0),
  object_key TEXT NOT NULL,
  UNIQUE (printing_id, role, content_sha256)
);

CREATE INDEX reconciled_printing_images_printing
ON reconciled_printing_images (printing_id, role, id);

CREATE INDEX reconciled_printing_images_object
ON reconciled_printing_images (object_key);

CREATE TABLE revision_printing_images (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  image_id TEXT NOT NULL REFERENCES reconciled_printing_images(id),
  printing_id TEXT NOT NULL, media_type TEXT CHECK (
  media_type IS NULL OR media_type LIKE 'image/%'
), content_sha256 TEXT CHECK (
  content_sha256 IS NULL OR (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  )
), content_byte_length INTEGER CHECK (
  content_byte_length IS NULL OR content_byte_length > 0
), object_key TEXT CHECK (
  object_key IS NULL OR length(object_key) > 0
),
  PRIMARY KEY (catalogue_revision_id, image_id)
);

CREATE INDEX revision_printing_images_printing
ON revision_printing_images (catalogue_revision_id, printing_id, image_id);

CREATE TRIGGER reconciled_printing_image_is_immutable
BEFORE UPDATE ON reconciled_printing_images
WHEN
  OLD.printing_id IS NOT NEW.printing_id OR
  OLD.role IS NOT NEW.role OR
  OLD.media_type IS NOT NEW.media_type OR
  OLD.width IS NOT NEW.width OR
  OLD.height IS NOT NEW.height OR
  OLD.content_sha256 IS NOT NEW.content_sha256 OR
  OLD.content_byte_length IS NOT NEW.content_byte_length OR
  OLD.object_key IS NOT NEW.object_key
BEGIN
  SELECT RAISE(ABORT, 'reconciled_printing_image_immutable');
END;

CREATE TABLE reconciled_products (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  official_code TEXT,
  name TEXT,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  withdrawal_revision_id TEXT REFERENCES catalogue_revisions(id),
  withdrawal_evidence_json TEXT
);

CREATE UNIQUE INDEX reconciled_product_official_identity
ON reconciled_products (supported_game, official_code)
WHERE official_code IS NOT NULL;

CREATE TABLE reconciled_distribution_contexts (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  context_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'product',
      'tournament_pack',
      'winner_prize',
      'promotion',
      'other'
    )
  ),
  label TEXT NOT NULL,
  product_id TEXT REFERENCES reconciled_products(id),
  evidence_category TEXT NOT NULL CHECK (
    evidence_category IN ('explicit', 'derived', 'curated')
  ),
  source_lineages_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(source_lineages_json)),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  UNIQUE (supported_game, context_key)
);

CREATE TABLE reconciled_product_relationships (
  id TEXT PRIMARY KEY,
  supported_game TEXT NOT NULL,
  relationship_kind TEXT NOT NULL CHECK (
    relationship_kind IN (
      'printing-product',
      'printing-distribution-context',
      'distribution-context-product',
      'product-card'
    )
  ),
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  evidence_category TEXT NOT NULL CHECK (
    evidence_category IN ('explicit', 'derived', 'curated')
  ),
  source_lineage TEXT NOT NULL,
  source_observation_ids_json TEXT NOT NULL,
  relationship_value TEXT NOT NULL,
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  document_json TEXT NOT NULL
);

CREATE INDEX reconciled_product_relationship_entities
ON reconciled_product_relationships (
  supported_game, from_type, from_id, to_type, to_id, current
);

CREATE TABLE revision_product_relationships (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  relationship_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, relationship_id)
);

CREATE TRIGGER reconciled_product_identity_is_immutable
BEFORE UPDATE OF id, supported_game, official_code, first_revision_id
ON reconciled_products
WHEN
  OLD.id IS NOT NEW.id OR
  OLD.supported_game IS NOT NEW.supported_game OR
  OLD.first_revision_id IS NOT NEW.first_revision_id OR
  (
    OLD.official_code IS NOT NEW.official_code AND
    NOT (
      OLD.official_code IS NULL AND
      NEW.official_code IS NOT NULL AND
      lower(trim(OLD.name)) = lower(trim(NEW.name))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'reconciled_product_identity_immutable');
END;

CREATE TRIGGER reconciled_product_relationship_identity_is_immutable
BEFORE UPDATE OF
  id,
  supported_game,
  relationship_kind,
  from_type,
  from_id,
  to_type,
  to_id,
  source_lineage,
  first_revision_id
ON reconciled_product_relationships
BEGIN
  SELECT RAISE(
    ABORT,
    'reconciled_product_relationship_identity_immutable'
  );
END;

CREATE TRIGGER source_adapter_version_is_immutable
BEFORE UPDATE ON source_adapter_versions
BEGIN
  SELECT RAISE(ABORT, 'source_adapter_version_immutable');
END;

CREATE TABLE reconciliation_workflow_requests (
  idempotency_key TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL UNIQUE
    REFERENCES ingestion_runs(id),
  expected_current_revision_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  workflow_params_json TEXT NOT NULL CHECK (json_valid(workflow_params_json)),
  workflow_instance_id TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL
);

CREATE TRIGGER reconciliation_workflow_requests_are_immutable
BEFORE UPDATE ON reconciliation_workflow_requests
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_workflow_request_immutable');
END;

CREATE TRIGGER reconciliation_workflow_requests_are_not_deleted
BEFORE DELETE ON reconciliation_workflow_requests
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_workflow_request_immutable');
END;

CREATE TABLE reconciliation_terminal_results (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
);

CREATE TRIGGER reconciliation_terminal_results_are_immutable
BEFORE UPDATE ON reconciliation_terminal_results
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_terminal_result_immutable');
END;

CREATE TRIGGER reconciliation_terminal_results_are_not_deleted
BEFORE DELETE ON reconciliation_terminal_results
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_terminal_result_immutable');
END;

CREATE TABLE catalogue_search_repair_requests (
  idempotency_key TEXT PRIMARY KEY,
  target_revision_id TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  result_json TEXT CHECK (
    result_json IS NULL OR json_valid(result_json)
  ),
  claim_token TEXT,
  claim_expires_at TEXT,
  CHECK (
    (claim_token IS NULL AND claim_expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
  )
);

CREATE TRIGGER catalogue_search_repair_request_identity_is_immutable
BEFORE UPDATE OF
  idempotency_key,
  target_revision_id,
  expected_current_revision_id,
  request_json
ON catalogue_search_repair_requests
BEGIN
  SELECT RAISE(ABORT, 'catalogue_search_repair_request_immutable');
END;

CREATE TRIGGER catalogue_search_repair_result_is_immutable
BEFORE UPDATE OF result_json ON catalogue_search_repair_requests
WHEN (
  OLD.result_json IS NOT NULL
  AND json_extract(OLD.result_json, '$.complete') = 1
) OR NEW.result_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'catalogue_search_repair_result_immutable');
END;

CREATE TRIGGER catalogue_search_repair_requests_are_not_deleted
BEFORE DELETE ON catalogue_search_repair_requests
BEGIN
  SELECT RAISE(ABORT, 'catalogue_search_repair_request_immutable');
END;

CREATE TABLE revision_card_query_documents (
  catalogue_revision_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  sort_game TEXT GENERATED ALWAYS AS (
    CAST(json_extract(summary_json, '$.game') AS TEXT)
  ) STORED NOT NULL,
  sort_identity_kind TEXT GENERATED ALWAYS AS (
    CAST(json_extract(summary_json, '$.official_identity.kind') AS TEXT)
  ) STORED NOT NULL,
  sort_identity_value TEXT GENERATED ALWAYS AS (
    CAST(json_extract(summary_json, '$.official_identity.value') AS TEXT)
  ) STORED NOT NULL,
  sort_id TEXT GENERATED ALWAYS AS (
    CAST(json_extract(summary_json, '$.id') AS TEXT)
  ) STORED NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (catalogue_revision_id, card_id),
  FOREIGN KEY (catalogue_revision_id, card_id)
    REFERENCES revision_cards(catalogue_revision_id, card_id)
    ON DELETE CASCADE
);

CREATE INDEX revision_card_query_documents_by_order
  ON revision_card_query_documents(
    catalogue_revision_id, sort_game, sort_identity_kind,
    sort_identity_value, sort_id
  );

CREATE INDEX revision_card_query_documents_by_identity
  ON revision_card_query_documents(
    catalogue_revision_id, sort_identity_kind, sort_identity_value,
    sort_game, sort_id
  );

CREATE TABLE revision_card_search_chunks (
  catalogue_revision_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  field_ordinal INTEGER NOT NULL CHECK (
    field_ordinal >= 0 AND field_ordinal <= 2
  ),
  chunk_ordinal INTEGER NOT NULL CHECK (chunk_ordinal >= 0),
  search_text TEXT NOT NULL,
  PRIMARY KEY (
    catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
  ),
  FOREIGN KEY (catalogue_revision_id, card_id)
    REFERENCES revision_card_query_documents(catalogue_revision_id, card_id)
    ON DELETE CASCADE
);

CREATE TABLE catalogue_query_revisions (
  catalogue_revision_id TEXT PRIMARY KEY
    REFERENCES catalogue_revisions(id),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'available', 'archived')
  ),
  repaired_through_card_id TEXT,
  repair_card_id TEXT,
  repair_search_offset INTEGER NOT NULL DEFAULT 0 CHECK (
    repair_search_offset >= 0
  ),
  repair_chunk_offset INTEGER NOT NULL DEFAULT 0 CHECK (
    repair_chunk_offset >= 0
  )
);

CREATE TABLE reconciled_errata (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL CHECK (
    game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  target_type TEXT NOT NULL CHECK (target_type IN ('card', 'printing')),
  target_id TEXT NOT NULL,
  effective_from TEXT CHECK (
    effective_from IS NULL
    OR effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  official_wording TEXT NOT NULL CHECK (length(official_wording) > 0),
  corrected_value_json TEXT NOT NULL CHECK (
    json_valid(corrected_value_json)
    AND json_type(corrected_value_json) IN ('text', 'null')
    AND (
      json_type(corrected_value_json) = 'null'
      OR length(json_extract(corrected_value_json, '$')) > 0
    )
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id)
);

CREATE TABLE erratum_provenance (
  erratum_id TEXT NOT NULL REFERENCES reconciled_errata(id),
  source_lineage TEXT NOT NULL CHECK (length(source_lineage) > 0),
  source_observation_id TEXT NOT NULL CHECK (
    length(source_observation_id) > 0
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  PRIMARY KEY (erratum_id, source_lineage, source_observation_id)
);

CREATE TABLE revision_errata (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  erratum_id TEXT NOT NULL REFERENCES reconciled_errata(id),
  PRIMARY KEY (catalogue_revision_id, erratum_id)
);

CREATE TRIGGER reconciled_errata_semantics_are_immutable
BEFORE UPDATE OF
  id,
  game,
  target_type,
  target_id,
  effective_from,
  official_wording,
  corrected_value_json,
  first_revision_id
ON reconciled_errata
BEGIN
  SELECT RAISE(ABORT, 'reconciled_erratum_immutable');
END;

CREATE TRIGGER reconciled_errata_are_not_deleted
BEFORE DELETE ON reconciled_errata
BEGIN
  SELECT RAISE(ABORT, 'reconciled_erratum_immutable');
END;

CREATE TRIGGER erratum_provenance_identity_is_immutable
BEFORE UPDATE OF
  erratum_id,
  source_lineage,
  source_observation_id,
  first_revision_id
ON erratum_provenance
BEGIN
  SELECT RAISE(ABORT, 'erratum_provenance_immutable');
END;

CREATE TRIGGER erratum_provenance_is_not_deleted
BEFORE DELETE ON erratum_provenance
BEGIN
  SELECT RAISE(ABORT, 'erratum_provenance_immutable');
END;

CREATE TRIGGER revision_errata_are_immutable_on_update
BEFORE UPDATE ON revision_errata
BEGIN
  SELECT RAISE(ABORT, 'revision_erratum_immutable');
END;

CREATE TRIGGER revision_errata_are_immutable_on_delete
BEFORE DELETE ON revision_errata
BEGIN
  SELECT RAISE(ABORT, 'revision_erratum_immutable');
END;

CREATE TABLE source_freshness (
  game TEXT NOT NULL CHECK (
    game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  area TEXT NOT NULL CHECK (
    area IN (
      'cards-and-printings', 'products-and-releases',
      'legality-rules', 'errata'
    )
  ),
  source_lineage TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  PRIMARY KEY (game, area, source_lineage, region),
  CHECK (
    (
      area <> 'legality-rules'
      AND source_lineage = ''
      AND region = ''
    )
    OR
    (
      area = 'legality-rules'
      AND source_lineage <> ''
      AND region <> ''
    )
  )
);

CREATE TABLE official_source_collection_plans (
  ingestion_run_id TEXT NOT NULL
    REFERENCES ingestion_evidence_plans(ingestion_run_id),
  source_lineage TEXT NOT NULL,
  discovery_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  contract TEXT NOT NULL
    CHECK (contract = 'card-keepr-official-source-collection-plan@1'),
  collection_plan_json TEXT NOT NULL CHECK (json_valid(collection_plan_json)),
  content_digest TEXT NOT NULL
    CHECK (
      length(content_digest) = 64
      AND content_digest NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, source_lineage),
  UNIQUE (discovery_observation_set_id)
);

CREATE TRIGGER official_source_collection_plans_immutable_update
BEFORE UPDATE ON official_source_collection_plans
BEGIN
  SELECT RAISE(ABORT, 'official_source_collection_plan_immutable');
END;

CREATE TRIGGER ingestion_evidence_plan_request_set_immutable
BEFORE UPDATE OF ingestion_run_id, source_lineage, supported_game,
  game_profile_version, adapter_version, request_plan_json, plan_origin
ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'ingestion_evidence_plan_request_set_immutable');
END;

CREATE TRIGGER ingestion_evidence_plans_immutable_delete
BEFORE DELETE ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'ingestion_evidence_plan_immutable');
END;

CREATE TRIGGER official_source_collection_plans_immutable_delete
BEFORE DELETE ON official_source_collection_plans
BEGIN
  SELECT RAISE(ABORT, 'official_source_collection_plan_immutable');
END;

CREATE TRIGGER source_requests_plan_fields_immutable
BEFORE UPDATE OF ingestion_run_id, request_id, sequence_number, method,
  url, request_headers_json, representation_fingerprint, request_role,
  discovered_from_request_id
ON source_requests
BEGIN
  SELECT RAISE(ABORT, 'source_request_plan_fields_immutable');
END;

CREATE TABLE source_discovery_request_plans (
  ingestion_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  parent_request_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method = 'GET'),
  url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL CHECK (json_valid(request_headers_json)),
  representation_fingerprint TEXT NOT NULL CHECK (
    length(representation_fingerprint) = 64
    AND representation_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  request_role TEXT NOT NULL CHECK (
    request_role IN ('listing', 'detail', 'product_detail', 'image')
  ),
  PRIMARY KEY (ingestion_run_id, request_id),
  UNIQUE (ingestion_run_id, sequence_number),
  FOREIGN KEY (ingestion_run_id, parent_request_id)
    REFERENCES source_requests(ingestion_run_id, request_id)
);

CREATE TRIGGER source_discovery_request_plans_immutable_update
BEFORE UPDATE ON source_discovery_request_plans
BEGIN
  SELECT RAISE(ABORT, 'source_discovery_request_plan_immutable');
END;

CREATE TRIGGER source_discovery_request_plans_immutable_delete
BEFORE DELETE ON source_discovery_request_plans
BEGIN
  SELECT RAISE(ABORT, 'source_discovery_request_plan_immutable');
END;

CREATE TRIGGER source_requests_immutable_delete
BEFORE DELETE ON source_requests
BEGIN
  SELECT RAISE(ABORT, 'source_request_immutable');
END;

CREATE TABLE legality_rules (
  id TEXT PRIMARY KEY,
  official_id TEXT NOT NULL,
  supported_game TEXT NOT NULL CHECK (
    supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  region TEXT NOT NULL CHECK (
    region IN ('EN-OCEANIA', 'EN-ASIA', 'EN-US')
  ),
  format TEXT NOT NULL CHECK (length(format) > 0),
  event_tier TEXT CHECK (event_tier IS NULL OR length(event_tier) > 0),
  effective_from TEXT,
  effective_until TEXT,
  unresolved_scope_json TEXT NOT NULL DEFAULT 'null' CHECK (
    json_valid(unresolved_scope_json)
    AND json_type(unresolved_scope_json) IN ('null', 'object')
  ),
  official_wording TEXT NOT NULL CHECK (length(official_wording) > 0),
  effect_json TEXT NOT NULL CHECK (
    json_valid(effect_json) AND json_type(effect_json) = 'object'
  ),
  card_ids_json TEXT NOT NULL CHECK (
    json_valid(card_ids_json) AND json_type(card_ids_json) = 'array'
  ),
  direct_card_ids_json TEXT NOT NULL CHECK (
    json_valid(direct_card_ids_json)
    AND json_type(direct_card_ids_json) = 'array'
  ),
  source_lineage TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_observation_set_id TEXT NOT NULL
    REFERENCES source_observation_sets(id),
  source_observation_id TEXT NOT NULL,
  source_observation_pointer TEXT NOT NULL CHECK (
    source_observation_pointer LIKE '/observations/%'
  ),
  source_field_pointers_json TEXT NOT NULL CHECK (
    json_valid(source_field_pointers_json)
    AND json_type(source_field_pointers_json) = 'object'
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  last_missing_revision_id TEXT REFERENCES catalogue_revisions(id),
  CHECK (
    (effective_from IS NOT NULL AND (
      effective_until IS NULL OR effective_until > effective_from
    ))
    OR (effective_from IS NULL AND effective_until IS NULL)
  ),
  UNIQUE (source_lineage, official_id)
);

CREATE TRIGGER legality_rule_card_ids_canonical_update
BEFORE UPDATE OF effect_json, card_ids_json, direct_card_ids_json,
  unresolved_scope_json
ON legality_rules
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_card_ids_not_canonical');
END;

CREATE INDEX legality_rules_context
  ON legality_rules (
    supported_game,
    region,
    format,
    event_tier,
    effective_from,
    effective_until
  );

CREATE TRIGGER legality_rule_provenance_immutable
BEFORE UPDATE OF supported_game, source_lineage, source_snapshot_id,
  source_observation_set_id, source_observation_id,
  source_observation_pointer, source_field_pointers_json
ON legality_rules
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_provenance_immutable');
END;

CREATE TRIGGER guard_legality_rule_identity
BEFORE UPDATE ON legality_rules
WHEN OLD.id <> NEW.id
  OR OLD.first_revision_id <> NEW.first_revision_id
  OR OLD.supported_game <> NEW.supported_game
  OR OLD.official_id <> NEW.official_id
  OR OLD.region <> NEW.region
  OR OLD.format <> NEW.format
  OR COALESCE(OLD.event_tier, '') <> COALESCE(NEW.event_tier, '')
  OR OLD.effective_from IS NOT NEW.effective_from
  OR COALESCE(OLD.effective_until, '') <> COALESCE(NEW.effective_until, '')
  OR OLD.unresolved_scope_json <> NEW.unresolved_scope_json
  OR OLD.official_wording <> NEW.official_wording
  OR OLD.effect_json <> NEW.effect_json
  OR OLD.card_ids_json <> NEW.card_ids_json
  OR OLD.direct_card_ids_json <> NEW.direct_card_ids_json
  OR OLD.source_lineage <> NEW.source_lineage
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_identity_conflict');
END;

CREATE TRIGGER legality_rules_immutable_delete
BEFORE DELETE ON legality_rules
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_immutable');
END;

CREATE TABLE revision_legality_rules (
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  legality_rule_id TEXT NOT NULL REFERENCES legality_rules(id),
  supported_game TEXT NOT NULL CHECK (
    supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')
  ),
  region TEXT NOT NULL CHECK (
    region IN ('EN-OCEANIA', 'EN-ASIA', 'EN-US')
  ),
  format TEXT NOT NULL CHECK (length(format) > 0),
  event_tier TEXT CHECK (event_tier IS NULL OR length(event_tier) > 0),
  effective_from TEXT,
  effective_until TEXT,
  unresolved_scope_json TEXT NOT NULL DEFAULT 'null' CHECK (
    json_valid(unresolved_scope_json)
    AND json_type(unresolved_scope_json) IN ('null', 'object')
  ),
  card_ids_json TEXT NOT NULL CHECK (
    json_valid(card_ids_json) AND json_type(card_ids_json) = 'array'
  ),
  document_json TEXT NOT NULL CHECK (
    json_valid(document_json) AND json_type(document_json) = 'object'
  ), source_retrieved_at TEXT,
  CHECK (
    (effective_from IS NOT NULL AND (
      effective_until IS NULL OR effective_until > effective_from
    ))
    OR (effective_from IS NULL AND effective_until IS NULL)
  ),
  PRIMARY KEY (catalogue_revision_id, legality_rule_id)
);

CREATE INDEX revision_legality_rules_context
  ON revision_legality_rules (
    catalogue_revision_id,
    region,
    format,
    event_tier,
    effective_from,
    effective_until
  );

CREATE TABLE revision_legality_rule_applicability (
  catalogue_revision_id TEXT NOT NULL,
  legality_rule_id TEXT NOT NULL,
  applicability_kind TEXT NOT NULL CHECK (
    applicability_kind IN ('card', 'all_cards')
  ),
  card_id TEXT NOT NULL,
  CHECK (
    (applicability_kind = 'all_cards' AND card_id = '')
    OR (
      applicability_kind = 'card'
      AND length(card_id) BETWEEN 1 AND 200
      AND substr(card_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND card_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  PRIMARY KEY (
    catalogue_revision_id, legality_rule_id, applicability_kind, card_id
  ),
  FOREIGN KEY (catalogue_revision_id, legality_rule_id)
    REFERENCES revision_legality_rules (
      catalogue_revision_id, legality_rule_id
    )
);

CREATE INDEX revision_legality_rule_applicability_lookup
  ON revision_legality_rule_applicability (
    catalogue_revision_id, applicability_kind, card_id, legality_rule_id
  );

CREATE TRIGGER revision_legality_rule_applicability_immutable_update
BEFORE UPDATE ON revision_legality_rule_applicability
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_applicability_immutable');
END;

CREATE TRIGGER revision_legality_rule_applicability_immutable_delete
BEFORE DELETE ON revision_legality_rule_applicability
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_applicability_immutable');
END;

CREATE TRIGGER revision_legality_rules_immutable_delete
BEFORE DELETE ON revision_legality_rules
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
END;

CREATE TABLE card_search_fts_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('ready', 'reconstructing')),
  owner_token TEXT,
  lease_expires_at TEXT,
  CHECK (
    (state = 'ready' AND owner_token IS NULL AND lease_expires_at IS NULL)
    OR (
      state = 'reconstructing'
      AND length(owner_token) > 0
      AND lease_expires_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'
    )
  )
);

CREATE TABLE catalogue_backup_attempts (
  idempotency_key TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  owner_token TEXT NOT NULL UNIQUE,
  catalogue_revision_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'exporting', 'restoring_verification', 'verifying',
    'verified', 'failed'
  )),
  object_key TEXT NOT NULL,
  d1_bookmark TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  manifest_key TEXT,
  content_sha256 TEXT,
  manifest_sha256 TEXT,
  export_bytes INTEGER,
  schema_migration_level INTEGER,
  linked_attempt_id TEXT REFERENCES catalogue_backup_attempts(idempotency_key),
  publication_ingestion_run_id TEXT REFERENCES ingestion_runs(id),
  disposable_database_id TEXT,
  restore_generation INTEGER NOT NULL DEFAULT 0
    CHECK (restore_generation >= 0),
  restore_phase TEXT
    CHECK (restore_phase IN ('prepared', 'importing', 'imported', 'verified')),
  CHECK (
    (state = 'verified' AND d1_bookmark IS NOT NULL
      AND failure_code IS NULL AND failure_detail IS NULL
      AND completed_at IS NOT NULL)
    OR (state = 'failed'
      AND failure_code IS NOT NULL AND failure_detail IS NOT NULL
      AND completed_at IS NOT NULL)
    OR (state IN ('pending', 'exporting') AND d1_bookmark IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL
      AND completed_at IS NULL)
    OR (state IN ('restoring_verification', 'verifying')
      AND d1_bookmark IS NOT NULL
      AND failure_code IS NULL AND failure_detail IS NULL
      AND completed_at IS NULL)
  )
);

CREATE TRIGGER catalogue_backup_attempts_terminal_immutable
BEFORE UPDATE ON catalogue_backup_attempts
WHEN OLD.state IN ('verified', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal backup attempt is immutable');
END;

CREATE TABLE catalogue_backup_workflow_requests (
  idempotency_key TEXT PRIMARY KEY,
  expected_current_revision_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  workflow_params_json TEXT NOT NULL CHECK (json_valid(workflow_params_json)),
  workflow_instance_id TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  linked_attempt_id TEXT REFERENCES catalogue_backup_attempts(idempotency_key)
);

CREATE TRIGGER catalogue_backup_workflow_requests_are_immutable
BEFORE UPDATE ON catalogue_backup_workflow_requests
BEGIN
  SELECT RAISE(ABORT, 'catalogue_backup_workflow_request_immutable');
END;

CREATE TRIGGER catalogue_backup_workflow_requests_are_not_deleted
BEFORE DELETE ON catalogue_backup_workflow_requests
BEGIN
  SELECT RAISE(ABORT, 'catalogue_backup_workflow_request_immutable');
END;

CREATE TABLE revision_card_search_fts_rows (
  fts_rowid INTEGER PRIMARY KEY,
  catalogue_revision_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  field_ordinal INTEGER NOT NULL,
  chunk_ordinal INTEGER NOT NULL,
  UNIQUE (
    catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
  )
);

CREATE VIRTUAL TABLE revision_card_search_fts USING fts5(
  revision_token,
  catalogue_revision_id UNINDEXED,
  card_id UNINDEXED,
  field_ordinal UNINDEXED,
  chunk_ordinal UNINDEXED,
  search_text,
  tokenize = 'trigram case_sensitive 1'
);

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

CREATE UNIQUE INDEX one_catalogue_backup_retry_per_failed_attempt
ON catalogue_backup_attempts (linked_attempt_id)
WHERE linked_attempt_id IS NOT NULL;

CREATE UNIQUE INDEX one_catalogue_backup_retry_workflow_per_failed_attempt
ON catalogue_backup_workflow_requests (linked_attempt_id)
WHERE linked_attempt_id IS NOT NULL;

CREATE TABLE catalogue_backup_retention (
  attempt_id TEXT PRIMARY KEY REFERENCES catalogue_backup_attempts(idempotency_key),
  newest_success INTEGER NOT NULL CHECK (newest_success IN (0, 1)),
  retain_until TEXT,
  policy TEXT NOT NULL CHECK (policy = 'newest-indefinite-and-dated-90-days'),
  CHECK (
    (newest_success = 1 AND retain_until IS NULL)
    OR (newest_success = 0 AND retain_until GLOB '[0-9][0-9][0-9][0-9]-*Z')
  )
);

CREATE UNIQUE INDEX one_newest_successful_catalogue_backup
ON catalogue_backup_retention (newest_success)
WHERE newest_success = 1;

CREATE TABLE catalogue_recovery_operations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'restoring', 'validating', 'awaiting_acceptance',
    'accepted', 'failed'
  )),
  method TEXT NOT NULL CHECK (
    method IN ('time_travel', 'replacement_database')
  ),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  target_revision_id TEXT NOT NULL,
  target_bookmark TEXT NOT NULL,
  target_digest TEXT NOT NULL CHECK (
    length(target_digest) = 64
    AND target_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_backup_attempt_id TEXT NOT NULL
    REFERENCES catalogue_backup_attempts(idempotency_key),
  linked_operation_id TEXT REFERENCES catalogue_recovery_operations(id),
  expected_current_revision_id TEXT NOT NULL,
  current_bookmark TEXT,
  restored_bookmark TEXT,
  undo_bookmark TEXT,
  original_database_id TEXT NOT NULL,
  restored_database_id TEXT,
  retained_database_id TEXT,
  expected_schema_migration_level INTEGER NOT NULL CHECK (
    expected_schema_migration_level > 0
  ),
  expected_verification_json TEXT NOT NULL CHECK (
    json_valid(expected_verification_json)
  ),
  verification_json TEXT CHECK (
    verification_json IS NULL OR json_valid(verification_json)
  ),
  verification_idempotency_key TEXT UNIQUE,
  verification_request_digest TEXT,
  acceptance_idempotency_key TEXT UNIQUE,
  acceptance_request_digest TEXT,
  started_at TEXT NOT NULL,
  restored_at TEXT,
  verified_at TEXT,
  accepted_at TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  failed_at TEXT,
  CHECK (
    (state = 'accepted' AND verification_json IS NOT NULL
      AND verification_idempotency_key IS NOT NULL
      AND acceptance_idempotency_key IS NOT NULL
      AND accepted_at IS NOT NULL
      AND failure_code IS NULL AND failure_detail IS NULL AND failed_at IS NULL)
    OR (state = 'failed' AND failure_code IS NOT NULL
      AND failure_detail IS NOT NULL AND failed_at IS NOT NULL
      AND acceptance_idempotency_key IS NULL AND accepted_at IS NULL)
    OR (state = 'awaiting_acceptance' AND verification_json IS NOT NULL
      AND verification_idempotency_key IS NOT NULL AND verified_at IS NOT NULL
      AND acceptance_idempotency_key IS NULL AND accepted_at IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL AND failed_at IS NULL)
    OR (state IN ('preparing', 'restoring', 'validating')
      AND verification_json IS NULL
      AND acceptance_idempotency_key IS NULL AND accepted_at IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL AND failed_at IS NULL)
  )
);

CREATE UNIQUE INDEX one_catalogue_recovery_child_per_failed_operation
ON catalogue_recovery_operations (linked_operation_id)
WHERE linked_operation_id IS NOT NULL;

CREATE UNIQUE INDEX one_active_catalogue_recovery_operation
ON catalogue_recovery_operations ((1))
WHERE state IN (
  'preparing', 'restoring', 'validating', 'awaiting_acceptance'
);

CREATE TRIGGER catalogue_recovery_request_is_immutable
BEFORE UPDATE OF id, method, request_json, idempotency_key,
  target_revision_id, target_bookmark, target_digest,
  source_backup_attempt_id, linked_operation_id,
  expected_current_revision_id, current_bookmark,
  original_database_id, expected_schema_migration_level,
  expected_verification_json, started_at
ON catalogue_recovery_operations
BEGIN
  SELECT RAISE(ABORT, 'catalogue_recovery_request_immutable');
END;

CREATE TRIGGER catalogue_recovery_terminal_is_immutable
BEFORE UPDATE ON catalogue_recovery_operations
WHEN OLD.state IN ('accepted', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal recovery operation is immutable');
END;

CREATE TRIGGER catalogue_recovery_operations_are_not_deleted
BEFORE DELETE ON catalogue_recovery_operations
BEGIN
  SELECT RAISE(ABORT, 'catalogue_recovery_audit_immutable');
END;

CREATE TABLE catalogue_export_deletion_plans (
  id TEXT PRIMARY KEY,
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  manifest_digest TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  object_keys_json TEXT NOT NULL CHECK (json_valid(object_keys_json)),
  component_names_json TEXT NOT NULL CHECK (json_valid(component_names_json)),
  object_set_digest TEXT NOT NULL CHECK (
    length(object_set_digest) = 64 AND object_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  plan_digest TEXT NOT NULL UNIQUE CHECK (
    length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER catalogue_export_deletion_plan_immutable_update
BEFORE UPDATE ON catalogue_export_deletion_plans
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_plan_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_plan_immutable_delete
BEFORE DELETE ON catalogue_export_deletion_plans
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_plan_immutable');
END;

CREATE TABLE catalogue_export_deletions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE REFERENCES catalogue_export_deletion_plans(id),
  state TEXT NOT NULL CHECK (state IN ('deleting', 'deleted', 'failed')),
  catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  manifest_digest TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  object_set_digest TEXT NOT NULL CHECK (
    length(object_set_digest) = 64 AND object_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT,
  retry_owner_idempotency_key TEXT,
  execution_owner_token TEXT,
  execution_lease_expires_at TEXT,
  confirmation_response_json TEXT CHECK (
    confirmation_response_json IS NULL OR json_valid(confirmation_response_json)
  ),
  CHECK (
    (state = 'deleting' AND completed_at IS NULL AND failure_code IS NULL) OR
    (state = 'deleted' AND completed_at IS NOT NULL AND failure_code IS NULL
      AND confirmation_response_json IS NOT NULL) OR
    (state = 'failed' AND completed_at IS NULL AND failure_code IS NOT NULL
      AND confirmation_response_json IS NOT NULL)
  )
);

CREATE TABLE catalogue_export_deletion_tombstones (
  catalogue_revision_id TEXT PRIMARY KEY REFERENCES catalogue_revisions(id),
  deletion_id TEXT NOT NULL UNIQUE REFERENCES catalogue_export_deletions(id),
  manifest_digest TEXT NOT NULL,
  object_set_digest TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

CREATE TABLE catalogue_export_deletion_retries (
  idempotency_key TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL REFERENCES catalogue_export_deletions(id),
  object_set_digest TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL
);

CREATE TRIGGER catalogue_export_deletion_retry_update_guard
BEFORE UPDATE ON catalogue_export_deletion_retries
WHEN OLD.response_json IS NOT NULL
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.deletion_id <> OLD.deletion_id
  OR NEW.object_set_digest <> OLD.object_set_digest
  OR NEW.request_json <> OLD.request_json
  OR NEW.created_at <> OLD.created_at
  OR NEW.response_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_retry_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_retry_delete_guard
BEFORE DELETE ON catalogue_export_deletion_retries
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_retry_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_tombstone_immutable_update
BEFORE UPDATE ON catalogue_export_deletion_tombstones
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_tombstone_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_tombstone_immutable_delete
BEFORE DELETE ON catalogue_export_deletion_tombstones
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_tombstone_immutable');
END;

CREATE TRIGGER catalogue_export_deletion_operation_immutable_delete
BEFORE DELETE ON catalogue_export_deletions
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_operation_immutable');
END;

CREATE TABLE production_releases (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'requested', 'preflight', 'migrating', 'deploying',
    'smoke_testing', 'succeeded', 'failed'
  )),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_current_revision_id TEXT NOT NULL,
  expected_head_sha TEXT NOT NULL CHECK (
    length(expected_head_sha) = 40
    AND expected_head_sha NOT GLOB '*[^0-9a-f]*'
  ),
  production_target_digest TEXT NOT NULL CHECK (
    length(production_target_digest) = 64
    AND production_target_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expected_migration_level INTEGER NOT NULL CHECK (expected_migration_level > 0),
  recovery_bookmark TEXT NOT NULL,
  recovery_backup_attempt_id TEXT NOT NULL
    REFERENCES catalogue_backup_attempts(idempotency_key),
  replacement_recovery_id TEXT REFERENCES catalogue_recovery_operations(id),
  replacement_database_id TEXT,
  retained_database_id TEXT,
  api_version_id TEXT,
  ingestion_version_id TEXT,
  binding_observation_json TEXT CHECK (
    binding_observation_json IS NULL OR json_valid(binding_observation_json)
  ),
  smoke_evidence_json TEXT CHECK (
    smoke_evidence_json IS NULL OR json_valid(smoke_evidence_json)
  ),
  failure_code TEXT,
  failure_detail TEXT,
  roll_forward_required INTEGER NOT NULL DEFAULT 0
    CHECK (roll_forward_required IN (0, 1)),
  requested_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (replacement_recovery_id IS NULL
      AND replacement_database_id IS NULL AND retained_database_id IS NULL)
    OR (replacement_recovery_id IS NOT NULL
      AND replacement_database_id IS NOT NULL AND retained_database_id IS NOT NULL
      AND replacement_database_id <> retained_database_id)
  ),
  CHECK (
    (state = 'succeeded' AND terminal_at IS NOT NULL
      AND failure_code IS NULL AND failure_detail IS NULL
      AND smoke_evidence_json IS NOT NULL)
    OR (state = 'failed' AND terminal_at IS NOT NULL
      AND failure_code IS NOT NULL AND failure_detail IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed') AND terminal_at IS NULL
      AND failure_code IS NULL AND failure_detail IS NULL)
  )
);

CREATE UNIQUE INDEX one_active_production_release
ON production_releases ((1))
WHERE state IN (
  'requested', 'preflight', 'migrating', 'deploying', 'smoke_testing'
);

CREATE TRIGGER production_release_request_immutable
BEFORE UPDATE OF id, request_json, idempotency_key,
  expected_current_revision_id, expected_head_sha, production_target_digest,
  expected_migration_level, recovery_bookmark, recovery_backup_attempt_id,
  replacement_recovery_id, replacement_database_id, retained_database_id,
  requested_at
ON production_releases
BEGIN
  SELECT RAISE(ABORT, 'production release request is immutable');
END;

CREATE TRIGGER production_release_terminal_immutable
BEFORE UPDATE ON production_releases
WHEN OLD.state IN ('succeeded', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal production release is immutable');
END;

CREATE TABLE reconciled_releases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES reconciled_products(id),
  event_key TEXT NOT NULL,
  region TEXT NOT NULL,
  date_precision TEXT CHECK (
    date_precision IN ('day', 'month', 'quarter', 'season', 'year', 'unknown')
  ),
  date_value TEXT,
  release_status TEXT CHECK (
    release_status IN ('announced', 'released')
  ),
  first_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
  last_observed_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id)
);

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

CREATE TABLE ingestion_run_capacity_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  capacity_generation INTEGER NOT NULL CHECK (capacity_generation >= 1),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason = 'source_request_capacity_exhausted'
  ),
  paused_at TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  parent_request_id TEXT NOT NULL,
  request_capacity INTEGER NOT NULL CHECK (request_capacity >= 1),
  used_capacity INTEGER NOT NULL CHECK (
    used_capacity BETWEEN 0 AND request_capacity
  ),
  overflow_request_count INTEGER NOT NULL CHECK (
    overflow_request_count >= 1
  ),
  required_capacity INTEGER NOT NULL CHECK (
    required_capacity = used_capacity + overflow_request_count
    AND required_capacity > request_capacity
  ),
  PRIMARY KEY (ingestion_run_id, capacity_generation)
);

CREATE TRIGGER guard_capacity_pause_update
BEFORE UPDATE ON ingestion_run_capacity_pauses
BEGIN
  SELECT RAISE(ABORT, 'capacity_pause_immutable');
END;

CREATE TRIGGER guard_capacity_pause_delete
BEFORE DELETE ON ingestion_run_capacity_pauses
BEGIN
  SELECT RAISE(ABORT, 'capacity_pause_immutable');
END;

CREATE TABLE ingestion_run_capacity_extensions (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  capacity_generation INTEGER NOT NULL CHECK (capacity_generation >= 2),
  previous_request_capacity INTEGER NOT NULL CHECK (
    previous_request_capacity >= 1
  ),
  request_capacity INTEGER NOT NULL CHECK (
    request_capacity > previous_request_capacity
    AND request_capacity BETWEEN 2 AND 24999
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

CREATE TABLE ingestion_run_retry_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  request_id TEXT NOT NULL,
  retry_generation INTEGER NOT NULL CHECK (retry_generation >= 1),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_transport_retries_exhausted',
      'source_storage_retries_exhausted'
    )
  ),
  paused_at TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  hostname TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  failure_classification TEXT NOT NULL CHECK (
    failure_classification IN (
      'network_failure',
      'http_failure',
      'storage_failure'
    )
  ),
  http_status INTEGER,
  PRIMARY KEY (ingestion_run_id, request_id, retry_generation),
  FOREIGN KEY (ingestion_run_id, request_id)
    REFERENCES source_requests (ingestion_run_id, request_id),
  -- The pause reason and the recorded classification must agree: storage
  -- exhaustion is exactly the storage_failure outcome, transport exhaustion
  -- is exactly the network and retryable HTTP outcomes.
  CHECK (
    (pause_reason = 'source_storage_retries_exhausted')
    = (failure_classification = 'storage_failure')
  )
);

CREATE TRIGGER guard_retry_pause_update
BEFORE UPDATE ON ingestion_run_retry_pauses
BEGIN
  SELECT RAISE(ABORT, 'retry_pause_immutable');
END;

CREATE TRIGGER guard_retry_pause_delete
BEFORE DELETE ON ingestion_run_retry_pauses
BEGIN
  SELECT RAISE(ABORT, 'retry_pause_immutable');
END;

CREATE TABLE ingestion_workflow_attempts (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('parent', 'child')),
  base_workflow_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  workflow_instance_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    ingestion_run_id, workflow_kind, base_workflow_id, attempt_number
  )
);

CREATE TRIGGER workflow_attempts_are_immutable_on_update
BEFORE UPDATE ON ingestion_workflow_attempts
BEGIN
  SELECT RAISE(ABORT, 'workflow_attempt_immutable');
END;

CREATE TRIGGER workflow_attempts_are_immutable_on_delete
BEFORE DELETE ON ingestion_workflow_attempts
BEGIN
  SELECT RAISE(ABORT, 'workflow_attempt_immutable');
END;

CREATE INDEX revision_printings_by_card
ON revision_printings (catalogue_revision_id, card_id, printing_id);

CREATE INDEX source_snapshots_by_run
ON source_snapshots (ingestion_run_id, retrieved_at DESC, id DESC);

CREATE INDEX source_fetch_attempts_by_run
ON source_fetch_attempts (
  ingestion_run_id,
  completed_at DESC,
  request_id DESC,
  attempt_number DESC
);

CREATE INDEX reconciled_printing_locators_by_printing
ON reconciled_printing_locators (printing_id, source_lineage, locator);

CREATE INDEX catalogue_backup_attempts_by_revision
ON catalogue_backup_attempts (
  catalogue_revision_id,
  started_at DESC,
  idempotency_key DESC
);

CREATE INDEX ingestion_runs_recent
ON ingestion_runs (started_at DESC, id DESC);

CREATE TABLE ingestion_run_workflow_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  workflow_instance_id TEXT NOT NULL,
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_workflow_stalled',
      'source_workflow_errored',
      'source_workflow_terminated',
      'source_workflow_unavailable',
      'owner_requested'
    )
  ),
  workflow_status TEXT NOT NULL CHECK (
    workflow_status IN (
      'queued',
      'running',
      'paused',
      'errored',
      'terminated',
      'complete',
      'waiting',
      'waiting_for_pause',
      'unknown',
      'unavailable'
    )
  ),
  paused_at TEXT NOT NULL,
  last_progress_at TEXT,
  PRIMARY KEY (ingestion_run_id, workflow_instance_id)
);

CREATE TRIGGER guard_workflow_pause_update
BEFORE UPDATE ON ingestion_run_workflow_pauses
BEGIN
  SELECT RAISE(ABORT, 'workflow_pause_immutable');
END;

CREATE TRIGGER guard_workflow_pause_delete
BEFORE DELETE ON ingestion_run_workflow_pauses
BEGIN
  SELECT RAISE(ABORT, 'workflow_pause_immutable');
END;

CREATE TABLE ingestion_run_terminations (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_request_capacity_exhausted',
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

CREATE TRIGGER guard_termination_update
BEFORE UPDATE ON ingestion_run_terminations
BEGIN
  SELECT RAISE(ABORT, 'termination_immutable');
END;

CREATE TRIGGER guard_termination_delete
BEFORE DELETE ON ingestion_run_terminations
BEGIN
  SELECT RAISE(ABORT, 'termination_immutable');
END;

CREATE TRIGGER revision_legality_rules_immutable_update
BEFORE UPDATE ON revision_legality_rules
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
END;

CREATE TABLE revision_printing_query (
  catalogue_revision_id TEXT NOT NULL,
  printing_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  supported_game TEXT NOT NULL CHECK (supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')),
  normalized_rarity TEXT,
  PRIMARY KEY (catalogue_revision_id, printing_id),
  FOREIGN KEY (catalogue_revision_id, printing_id)
    REFERENCES revision_printings(catalogue_revision_id, printing_id) ON DELETE CASCADE
);

CREATE INDEX revision_printing_query_by_card
  ON revision_printing_query(catalogue_revision_id, card_id, printing_id);

CREATE INDEX revision_printing_query_by_game
  ON revision_printing_query(catalogue_revision_id, supported_game, card_id, printing_id);

CREATE INDEX revision_printing_query_by_rarity
  ON revision_printing_query(catalogue_revision_id, normalized_rarity, card_id, printing_id);

CREATE INDEX revision_printing_query_by_game_rarity
  ON revision_printing_query(catalogue_revision_id, supported_game, normalized_rarity, card_id, printing_id);

CREATE TABLE revision_printing_product_query (
  catalogue_revision_id TEXT NOT NULL,
  printing_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  -- Empty means this current Product membership has no published Release region.
  release_region TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, printing_id, product_id, release_region),
  FOREIGN KEY (catalogue_revision_id, printing_id)
    REFERENCES revision_printing_query(catalogue_revision_id, printing_id) ON DELETE CASCADE,
  FOREIGN KEY (catalogue_revision_id, product_id)
    REFERENCES revision_products(catalogue_revision_id, product_id) ON DELETE CASCADE
);

CREATE INDEX revision_printing_products_by_product
  ON revision_printing_product_query(catalogue_revision_id, product_id, card_id, printing_id, release_region);

CREATE INDEX revision_printing_products_by_region
  ON revision_printing_product_query(catalogue_revision_id, release_region, card_id, printing_id, product_id);

CREATE INDEX revision_printing_products_by_product_region
  ON revision_printing_product_query(catalogue_revision_id, product_id, release_region, card_id, printing_id);

CREATE TABLE ingestion_workflow_progress (
  workflow_instance_id TEXT PRIMARY KEY REFERENCES ingestion_workflow_attempts(workflow_instance_id),
  last_progress_at TEXT NOT NULL,
  last_work_at TEXT,
  last_step_name TEXT,
  last_phase TEXT CHECK (last_phase IN ('started', 'completed', 'failed'))
);

CREATE TRIGGER workflow_progress_identity_is_immutable
BEFORE UPDATE OF workflow_instance_id ON ingestion_workflow_progress
BEGIN SELECT RAISE(ABORT, 'workflow_progress_identity_immutable'); END;

CREATE TABLE revision_card_attributes (
  catalogue_revision_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, card_id, attribute, value),
  FOREIGN KEY (catalogue_revision_id, card_id)
    REFERENCES revision_cards(catalogue_revision_id, card_id) ON DELETE CASCADE
);

CREATE INDEX revision_card_attributes_by_value
  ON revision_card_attributes(catalogue_revision_id, profile, attribute, value, card_id);

CREATE TABLE catalogue_backup_dispatch (
  idempotency_key TEXT PRIMARY KEY REFERENCES catalogue_backup_workflow_requests(idempotency_key),
  state TEXT NOT NULL CHECK (state IN ('pending', 'failed', 'dispatched')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_detail TEXT,
  updated_at TEXT NOT NULL
);

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

CREATE TRIGGER catalogue_export_deletion_identity_is_immutable
BEFORE UPDATE ON catalogue_export_deletions
WHEN NEW.id <> OLD.id
  OR NEW.plan_id <> OLD.plan_id
  OR NEW.catalogue_revision_id <> OLD.catalogue_revision_id
  OR NEW.manifest_digest <> OLD.manifest_digest
  OR NEW.expected_current_revision_id <> OLD.expected_current_revision_id
  OR NEW.object_set_digest <> OLD.object_set_digest
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.request_json <> OLD.request_json
  OR NEW.requested_at <> OLD.requested_at
  OR (OLD.confirmation_response_json IS NOT NULL
      AND NEW.confirmation_response_json IS NOT OLD.confirmation_response_json)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_transition_invalid');
END;

CREATE TRIGGER ingestion_run_identity_is_immutable
BEFORE UPDATE ON ingestion_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.expected_current_revision_id IS NOT OLD.expected_current_revision_id
  OR NEW.linked_run_id IS NOT OLD.linked_run_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.operational_request_id IS NOT OLD.operational_request_id
  OR (OLD.approval_idempotency_key IS NOT NULL
    AND NEW.approval_idempotency_key IS NOT OLD.approval_idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_identity_immutable');
END;

CREATE TRIGGER ingestion_run_identity_is_not_deleted
BEFORE DELETE ON ingestion_runs
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_identity_immutable');
END;

CREATE TABLE ingestion_run_events (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  event_id TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('created', 'stage_changed', 'collection_paused', 'collection_resumed', 'collection_terminated', 'candidate_prepared', 'candidate_blocked', 'approval_reserved', 'rejected', 'expired', 'failed', 'published')),
  occurred_at TEXT NOT NULL,
  from_state TEXT CHECK (from_state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  to_state TEXT NOT NULL CHECK (to_state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  PRIMARY KEY (ingestion_run_id, sequence_number)
);

CREATE TRIGGER ingestion_run_events_are_immutable_on_update
BEFORE UPDATE ON ingestion_run_events
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_immutable');
END;

CREATE TRIGGER ingestion_run_events_are_immutable_on_delete
BEFORE DELETE ON ingestion_run_events
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_immutable');
END;

CREATE TABLE ingestion_run_current (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 1),
  last_event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  previous_state TEXT CHECK (previous_state IN ('planning', 'collecting', 'paused', 'parsing', 'reconciling', 'awaiting_approval', 'publishing', 'published', 'rejected', 'expired', 'failed')),
  completed_stage_count INTEGER NOT NULL CHECK (completed_stage_count BETWEEN 0 AND 6),
  candidate_digest TEXT,
  candidate_catalogue_digest TEXT,
  candidate_created_at TEXT,
  approval_deadline TEXT,
  candidate_payload_event_sequence INTEGER CHECK (candidate_payload_event_sequence >= 1),
  diagnostics_event_sequence INTEGER CHECK (diagnostics_event_sequence >= 1),
  approved_at TEXT,
  approved_candidate_digest TEXT,
  approved_expected_revision_id TEXT,
  failure_code TEXT,
  terminal_at TEXT,
  publication_revision_id TEXT,
  publication_started_at TEXT,
  publication_reconcile_after TEXT,
  publication_manifest_digest TEXT,
  publication_writer_token TEXT,
  published_revision_id TEXT,
  export_manifest_digest TEXT,
  publication_outcome TEXT CHECK (publication_outcome IN ('revision', 'no_change')),
  resulting_revision_id TEXT,
  freshness_checked_at TEXT
);

CREATE INDEX ingestion_runs_by_state
ON ingestion_run_current (state, publication_reconcile_after, ingestion_run_id);

CREATE TABLE ingestion_run_selected_games (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  game TEXT NOT NULL CHECK (game IN ('one-piece', 'fusion-world', 'digimon', 'gundam')),
  PRIMARY KEY (ingestion_run_id, ordinal),
  UNIQUE (ingestion_run_id, game)
);

CREATE TABLE ingestion_run_event_payload_chunks (
  ingestion_run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  payload_kind TEXT NOT NULL CHECK (payload_kind IN ('candidate', 'diagnostics')),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 524288),
  PRIMARY KEY (ingestion_run_id, event_sequence, payload_kind, chunk_index),
  FOREIGN KEY (ingestion_run_id, event_sequence)
    REFERENCES ingestion_run_events(ingestion_run_id, sequence_number)
);

CREATE TRIGGER ingestion_run_event_payload_chunks_are_immutable_on_update
BEFORE UPDATE ON ingestion_run_event_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_payload_immutable');
END;

CREATE TRIGGER ingestion_run_event_payload_chunks_are_immutable_on_delete
BEFORE DELETE ON ingestion_run_event_payload_chunks
BEGIN
  SELECT RAISE(ABORT, 'ingestion_run_event_payload_immutable');
END;

CREATE VIEW ingestion_run_read AS
SELECT identity.id, current.state,
  (SELECT json_group_array(game) FROM (
    SELECT game FROM ingestion_run_selected_games
    WHERE ingestion_run_id = identity.id ORDER BY ordinal
  )) AS selected_games_json,
  identity.started_at, identity.expected_current_revision_id, identity.linked_run_id,
  identity.idempotency_key, current.candidate_digest, current.candidate_created_at,
  current.approval_deadline,
  CASE WHEN current.approved_at IS NULL THEN NULL ELSE json_object(
    'action', 'approved',
    'candidate_digest', current.approved_candidate_digest,
    'expected_current_revision_id', current.approved_expected_revision_id,
    'approved_at', current.approved_at
  ) END AS approval_json,
  current.published_revision_id, current.export_manifest_digest, current.terminal_at,
  COALESCE((SELECT group_concat(content, '') FROM (
    SELECT content FROM ingestion_run_event_payload_chunks
    WHERE ingestion_run_id = identity.id
      AND event_sequence = current.candidate_payload_event_sequence
      AND payload_kind = 'candidate' ORDER BY chunk_index
  )), '{}') AS candidate_json,
  identity.approval_idempotency_key, current.failure_code,
  json_object('completed_stages', json((SELECT json_group_array(value) FROM (
    SELECT value FROM json_each('["planning","collecting","parsing","reconciling","awaiting_approval","publishing"]')
    WHERE CAST(key AS INTEGER) < current.completed_stage_count ORDER BY CAST(key AS INTEGER)
  ))), 'current_stage', current.state) AS progress_json,
  COALESCE((SELECT group_concat(content, '') FROM (
    SELECT content FROM ingestion_run_event_payload_chunks
    WHERE ingestion_run_id = identity.id
      AND event_sequence = current.diagnostics_event_sequence
      AND payload_kind = 'diagnostics' ORDER BY chunk_index
  )), '[]') AS warnings_json,
  (SELECT json_group_array(json(decision)) FROM (
    SELECT json_extract(payload_json, '$.decision') AS decision FROM ingestion_run_events
    WHERE ingestion_run_id = identity.id AND json_type(payload_json, '$.decision') = 'object'
    ORDER BY sequence_number
  )) AS approval_history_json,
  current.publication_outcome, current.resulting_revision_id, current.freshness_checked_at,
  current.publication_revision_id, current.publication_started_at, current.publication_reconcile_after,
  current.publication_manifest_digest, current.publication_writer_token,
  current.candidate_catalogue_digest, identity.operational_request_id
FROM ingestion_runs AS identity
JOIN ingestion_run_current AS current ON current.ingestion_run_id = identity.id;

-- Initial singleton state and shipped production adapter registrations.
INSERT INTO "catalogue_state" ("singleton", "current_revision_id", "published_at")
VALUES (1, 'catrev_spine_000', '1970-01-01T00:00:00.000Z');

INSERT INTO "operation_state" ("singleton", "active_ingestion_run_id", "recovery_health", "active_recovery_id", "recovery_restore_guard", "active_production_release_id", "active_production_release_expires_at")
VALUES (1, NULL, 'healthy', NULL, 'clear', NULL, NULL);

INSERT INTO "catalogue_schema_state" ("singleton", "migration_level")
VALUES (1, 1);

INSERT INTO "source_adapter_versions" ("adapter_version", "source_lineage", "supported_game", "game_profile_version", "parser_contract", "adapter_origin", "request_capacity")
VALUES ('one-piece-official-errata-html@1', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-official-errata-html@1', 'production', 5000);

INSERT INTO "source_adapter_versions" ("adapter_version", "source_lineage", "supported_game", "game_profile_version", "parser_contract", "adapter_origin", "request_capacity")
VALUES ('one-piece-en@6', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-en-restructured-complete-catalogue@6', 'production', 10000);

INSERT INTO "source_adapter_versions" ("adapter_version", "source_lineage", "supported_game", "game_profile_version", "parser_contract", "adapter_origin", "request_capacity")
VALUES ('gundam-en-asia@7', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-en-asia-restructured-complete-catalogue@6', 'production', 5000);

INSERT INTO "source_adapter_versions" ("adapter_version", "source_lineage", "supported_game", "game_profile_version", "parser_contract", "adapter_origin", "request_capacity")
VALUES ('gundam-en-us@7', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-en-us-restructured-complete-catalogue@6', 'production', 5000);

INSERT INTO "source_adapter_versions" ("adapter_version", "source_lineage", "supported_game", "game_profile_version", "parser_contract", "adapter_origin", "request_capacity")
VALUES ('digimon-en@7', 'digimon-en', 'digimon', 'digimon@1', 'digimon-en-restructured-complete-catalogue@6', 'production', 5000);

INSERT INTO "source_adapter_versions" ("adapter_version", "source_lineage", "supported_game", "game_profile_version", "parser_contract", "adapter_origin", "request_capacity")
VALUES ('fusion-world-en@9', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-restructured-complete-catalogue@7', 'production', 15000);

INSERT INTO "card_search_fts_state" ("singleton", "state", "owner_token", "lease_expires_at")
VALUES (1, 'ready', NULL, NULL);
