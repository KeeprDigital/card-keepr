-- Schema baseline (ADR 0006).
--
-- This file replaces the 36 forward migrations that took the catalogue
-- database to schema level 36 (0001_catalogue_publication through
-- 0036_drop_credential_rotation, last applied together at commit 30751a2a46548530d48dc37a1dc507efbbd07c03).
-- It creates the level-36 schema in one pass and seeds the rows every
-- environment starts from, recording schema level 1. The old files remain
-- in git history; acceptance/schema-baseline.test.mjs proves this file
-- yields the same sqlite_schema and seed rows as the old chain.
--
-- Every migration after this one must open with the level guard:
--
--   SELECT CASE
--     WHEN (SELECT migration_level FROM catalogue_schema_state
--           WHERE singleton = 1) = <previous level>
--     THEN 1
--     ELSE json_extract('schema_level_mismatch_expected_<previous level>', '$')
--   END;
--
-- json_extract on a non-JSON string raises "malformed JSON" and aborts the
-- whole migration, so a stale or skipped level can never be papered over.
-- The migration's final statement bumps catalogue_schema_state to its own
-- level without a WHERE clause, because the guard has proven it.
--
-- Objects appear in the order the chain created them, except that the
-- singleton state tables and ingestion_runs are hoisted to the top. Trigger
-- order is unchanged: SQLite fires overlapping triggers in creation order.

-- Singleton state.
--
-- A fresh database starts at the schema-valid catrev_spine_000 bootstrap
-- pointer (seeded at the end of this file) until the first approved
-- candidate is published.
CREATE TABLE catalogue_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_revision_id TEXT NOT NULL,
  published_at TEXT NOT NULL
);

-- active_release_id / active_release_expires_at were the original
-- Production Release lease columns; active_production_release_id and its
-- expiry are the later vocabulary. Both pairs stay and are kept equal by
-- the production_release_lease_sync_* triggers so a Worker built against
-- either name keeps working during a compatible rollout.
CREATE TABLE operation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_ingestion_run_id TEXT,
  recovery_health TEXT NOT NULL CHECK (
    recovery_health IN ('healthy', 'degraded', 'blocked')
  ),
  active_release_id TEXT,
  active_release_expires_at TEXT,
  active_recovery_id TEXT,
  recovery_restore_guard TEXT NOT NULL DEFAULT 'clear'
    CHECK (recovery_restore_guard IN ('clear', 'blocked')),
  active_production_release_id TEXT,
  active_production_release_expires_at TEXT
);

-- The schema level is read by backup and restore verification, which
-- compares a backup's stamped level with the live one, and by the
-- Production Release preflight. The baseline seeds level 1; every later
-- migration opens with the level guard described in ADR 0006 and ends by
-- bumping this row.
CREATE TABLE catalogue_schema_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  migration_level INTEGER NOT NULL CHECK (migration_level > 0)
);

-- Ingestion Runs.
--
-- 'paused' is a non-terminal state reachable only from 'collecting': a
-- run pauses when atomic admission of a discovered request batch would
-- exceed its Source Adapter Version's request capacity, when transport or
-- R2 retries are exhausted, or when its collection Workflow stalls. The
-- paused run keeps the single active-run reservation, its expected
-- Catalogue Revision, and every retained Source Request, Source Snapshot,
-- and Source Observation Set. Termination (paused -> failed) is the only
-- exit besides resuming.
--
-- operational_request_id is one safe request identity linking a durable
-- run to the structured request-completion event that created it; it is
-- deliberately distinct from the owner-supplied idempotency key.
CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (
    state IN (
      'planning',
      'collecting',
      'paused',
      'parsing',
      'reconciling',
      'awaiting_approval',
      'publishing',
      'published',
      'rejected',
      'expired',
      'failed'
    )
  ),
  selected_games_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expected_current_revision_id TEXT NOT NULL,
  linked_run_id TEXT REFERENCES ingestion_runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  candidate_digest TEXT,
  candidate_created_at TEXT,
  approval_deadline TEXT,
  approval_json TEXT,
  published_revision_id TEXT,
  export_manifest_digest TEXT,
  terminal_at TEXT,
  candidate_json TEXT NOT NULL,
  approval_idempotency_key TEXT UNIQUE,
  failure_code TEXT,
  progress_json TEXT NOT NULL
    DEFAULT '{"completed_stages":[],"current_stage":"planning"}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  approval_history_json TEXT NOT NULL DEFAULT '[]',
  publication_outcome TEXT CHECK (
    publication_outcome IN ('revision', 'no_change')
  ),
  resulting_revision_id TEXT,
  freshness_checked_at TEXT,
  publication_revision_id TEXT,
  publication_started_at TEXT,
  publication_reconcile_after TEXT,
  publication_manifest_digest TEXT,
  publication_writer_token TEXT,
  candidate_catalogue_digest TEXT,
  operational_request_id TEXT
);

-- Published catalogue: revisions, their per-revision documents, and the
-- verified export packages.
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

-- Administration idempotency: completed outcomes are immutable, and an
-- in-flight claim must be finished by the same owner that opened it.
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

CREATE TRIGGER guard_idempotency_claim_after_completion
BEFORE INSERT ON administration_idempotency_claims
WHEN EXISTS (
  SELECT 1
  FROM administration_idempotency AS outcome
  WHERE outcome.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'administration_idempotency_completed');
END;

CREATE TRIGGER guard_idempotency_outcome_owner
BEFORE INSERT ON administration_idempotency
WHEN EXISTS (
  SELECT 1
  FROM administration_idempotency_claims AS claim
  WHERE claim.idempotency_key = NEW.idempotency_key
)
  AND NOT EXISTS (
    SELECT 1
    FROM administration_idempotency_claims AS claim
    WHERE claim.idempotency_key = NEW.idempotency_key
      AND claim.operation = NEW.operation
      AND claim.request_json = NEW.request_json
      AND claim.owner_token = NEW.claim_owner_token
      AND claim.claim_version = NEW.claim_version
  )
BEGIN
  SELECT RAISE(ABORT, 'administration_idempotency_owner_changed');
END;

-- Ingestion lifecycle audit and publication bookkeeping.
CREATE TABLE ingestion_run_transitions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  transitioned_at TEXT NOT NULL
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

CREATE TRIGGER guard_ingestion_transition_update
BEFORE UPDATE ON ingestion_run_transitions
BEGIN
  SELECT RAISE(ABORT, 'ingestion_transition_audit_immutable');
END;

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

CREATE TRIGGER guard_cleanup_idempotency_completion
BEFORE INSERT ON administration_idempotency
WHEN NEW.operation = 'retry_publication_cleanup'
  AND NEW.outcome = 'success'
  AND NOT EXISTS (
    SELECT 1
    FROM ingestion_publication_cleanup AS cleanup
    WHERE cleanup.ingestion_run_id =
      json_extract(NEW.request_json, '$.run_id')
      AND cleanup.state = 'completed'
      AND cleanup.idempotency_key = NEW.idempotency_key
      AND cleanup.request_json = NEW.request_json
      AND cleanup.claim_token IS NULL
      AND cleanup.claim_version = json_extract(
        NEW.response_json,
        '$.publication_cleanup.generation'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'cleanup_completion_claim_changed');
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

-- Immutable Source Evidence.
--
-- Source Adapter Versions are append-only identities: a row retains the
-- parser contract and origin under which evidence was captured, and
-- earlier identities stay installed for retained-snapshot replay.
-- request_capacity is an immutable request-capacity policy owned by each
-- exact version, constrained by the larger global emergency ceiling
-- (25,000) declared in src/catalogue/source-adapters.ts. The seed rows at
-- the end of this file are a database constraint copy of
-- installedSourceAdapterRegistrations there; the Worker drift test
-- requires exact agreement, request_capacity included, because SQLite
-- migrations cannot import runtime TypeScript.
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

CREATE TRIGGER ingestion_evidence_plan_origin_matches_adapter
BEFORE INSERT ON ingestion_evidence_plans
WHEN NOT EXISTS (
  SELECT 1
  FROM source_adapter_versions AS adapter
  WHERE adapter.adapter_version = NEW.adapter_version
    AND adapter.adapter_origin = NEW.plan_origin
)
BEGIN
  SELECT RAISE(ABORT, 'evidence_plan_origin_mismatch');
END;

CREATE TRIGGER ingestion_evidence_plan_origin_is_immutable
BEFORE UPDATE OF plan_origin ON ingestion_evidence_plans
BEGIN
  SELECT RAISE(ABORT, 'evidence_plan_origin_immutable');
END;

-- Card and Printing reconciliation.
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

CREATE TABLE reconciliation_contexts (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id),
  source_observation_set_id TEXT NOT NULL REFERENCES source_observation_sets(id),
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id),
  source_lineage TEXT NOT NULL,
  digest_payload_json TEXT NOT NULL,
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

-- Products, Releases, and distribution contexts.
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
  printing_id TEXT NOT NULL,
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

-- Reconciliation Workflow bookkeeping and Errata rules text.
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

-- Revision-pinned Card query documents and substring search.
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

CREATE TABLE revision_card_search_terms (
  catalogue_revision_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  term TEXT NOT NULL CHECK (
    (substr(term, 1, 3) = 'g1:' AND length(term) = 4)
    OR (substr(term, 1, 3) = 'g2:' AND length(term) = 5)
    OR (substr(term, 1, 3) = 'g3:' AND length(term) = 6)
  ),
  sort_game TEXT NOT NULL,
  sort_identity_kind TEXT NOT NULL,
  sort_identity_value TEXT NOT NULL,
  sort_id TEXT NOT NULL,
  PRIMARY KEY (catalogue_revision_id, card_id, term),
  FOREIGN KEY (catalogue_revision_id, card_id)
    REFERENCES revision_card_query_documents(catalogue_revision_id, card_id)
    ON DELETE CASCADE
);

CREATE INDEX revision_card_search_by_term
  ON revision_card_search_terms(
    catalogue_revision_id, term, sort_game, sort_identity_kind,
    sort_identity_value, sort_id, card_id
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
  repair_term_offset INTEGER NOT NULL DEFAULT 0 CHECK (
    repair_term_offset >= 0
  )
);

CREATE TRIGGER archive_removed_card_query_material
AFTER DELETE ON revision_card_query_documents
WHEN NOT EXISTS (
  SELECT 1
  FROM revision_card_query_documents
  WHERE catalogue_revision_id = OLD.catalogue_revision_id
)
BEGIN
  UPDATE catalogue_query_revisions
  SET state = 'archived',
      repaired_through_card_id = NULL,
      repair_card_id = NULL,
      repair_search_offset = 0,
      repair_term_offset = 0
  WHERE catalogue_revision_id = OLD.catalogue_revision_id;
END;

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

CREATE TRIGGER reconciled_card_erratum_target_is_valid
BEFORE INSERT ON reconciled_errata
WHEN NEW.target_type = 'card'
  AND NOT EXISTS (
    SELECT 1
    FROM reconciled_cards AS card
    WHERE card.id = NEW.target_id
      AND card.supported_game = NEW.game
  )
BEGIN
  SELECT RAISE(ABORT, 'reconciled_erratum_target_invalid');
END;

CREATE TRIGGER reconciled_printing_erratum_target_is_valid
BEFORE INSERT ON reconciled_errata
WHEN NEW.target_type = 'printing'
  AND NOT EXISTS (
    SELECT 1
    FROM reconciled_printings AS printing
    JOIN reconciled_cards AS card
      ON card.id = printing.card_id
    WHERE printing.id = NEW.target_id
      AND card.supported_game = NEW.game
  )
BEGIN
  SELECT RAISE(ABORT, 'reconciled_erratum_target_invalid');
END;

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

CREATE TRIGGER official_source_collection_plan_discovery_owner
BEFORE INSERT ON official_source_collection_plans
WHEN NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = NEW.discovery_observation_set_id
    AND snapshot.ingestion_run_id = NEW.ingestion_run_id
    AND snapshot.source_lineage = NEW.source_lineage
)
BEGIN
  SELECT RAISE(
    ABORT,
    'official_source_collection_plan_discovery_owner_mismatch'
  );
END;

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

CREATE TRIGGER source_requests_must_match_immutable_plan
BEFORE INSERT ON source_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan,
       json_each(
         CASE
           WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
             THEN json_extract(plan.request_plan_json, '$.plans')
           ELSE json_array(json(plan.request_plan_json))
         END
       ) AS evidence_plan,
       json_each(evidence_plan.value, '$.requests') AS planned
  WHERE plan.ingestion_run_id = NEW.ingestion_run_id
    AND json_extract(planned.value, '$.id') = NEW.request_id
    AND CAST(planned.key AS INTEGER) + (
      SELECT COALESCE(
        SUM(json_array_length(json_extract(preceding.value, '$.requests'))),
        0
      )
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      ) AS preceding
      WHERE CAST(preceding.key AS INTEGER) <
        CAST(evidence_plan.key AS INTEGER)
    ) = NEW.sequence_number
    AND json_extract(planned.value, '$.method') = NEW.method
    AND json_extract(planned.value, '$.url') = NEW.url
    AND json_extract(planned.value, '$.headers') = NEW.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      NEW.representation_fingerprint
)
AND NOT EXISTS (
  SELECT 1
  FROM ingestion_evidence_plans AS plan
  JOIN official_source_collection_plans AS collection
    ON collection.ingestion_run_id = plan.ingestion_run_id,
       json_each(collection.collection_plan_json, '$.requests') AS planned
  WHERE plan.ingestion_run_id = NEW.ingestion_run_id
    AND json_extract(planned.value, '$.id') = NEW.request_id
    AND (
      SELECT SUM(json_array_length(json_extract(value, '$.requests')))
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      )
    ) + 10000 * (
      SELECT CAST(key AS INTEGER)
      FROM json_each(
        CASE
          WHEN json_type(plan.request_plan_json, '$.plans') = 'array'
            THEN json_extract(plan.request_plan_json, '$.plans')
          ELSE json_array(json(plan.request_plan_json))
        END
      )
      WHERE json_extract(value, '$.source_lineage') =
        collection.source_lineage
    ) + CAST(planned.key AS INTEGER) = NEW.sequence_number
    AND json_extract(planned.value, '$.method') = NEW.method
    AND json_extract(planned.value, '$.url') = NEW.url
    AND json_extract(planned.value, '$.headers') = NEW.request_headers_json
    AND json_extract(planned.value, '$.representation_fingerprint') =
      NEW.representation_fingerprint
    AND json_type(planned.value, '$.surface') = 'text'
    AND length(json_extract(planned.value, '$.surface')) > 0
)
AND NOT EXISTS (
  SELECT 1
  FROM source_discovery_request_plans AS planned
  WHERE planned.ingestion_run_id = NEW.ingestion_run_id
    AND planned.request_id = NEW.request_id
    AND planned.sequence_number = NEW.sequence_number
    AND planned.method = NEW.method
    AND planned.url = NEW.url
    AND planned.request_headers_json = NEW.request_headers_json
    AND planned.representation_fingerprint = NEW.representation_fingerprint
    AND planned.request_role = NEW.request_role
    AND planned.parent_request_id = NEW.discovered_from_request_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_request_not_in_immutable_plan');
END;

CREATE TRIGGER source_requests_immutable_delete
BEFORE DELETE ON source_requests
BEGIN
  SELECT RAISE(ABORT, 'source_request_immutable');
END;

-- Legality Rules.
--
-- unresolved_scope_json represents open-predicate Official Source
-- restrictions explicitly. The 'target_scope' dimension means the rule's
-- retained Card list is the enumerated set of known matches while the
-- Official Source states that unenumerated (including future) Cards are
-- also in scope; such a rule additionally materializes one explicit
-- 'all_cards' applicability row so every contextual Legality Status query
-- in its game, region, and format retains the uncertainty instead of
-- silently missing it.
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

CREATE TRIGGER legality_rule_effect_valid_insert
BEFORE INSERT ON legality_rules
WHEN NOT (
  (
    json_extract(NEW.effect_json, '$.type') IN ('eligible', 'ban')
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 1
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'copy_limit'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.maximum_copies') = 'integer'
    AND json_extract(NEW.effect_json, '$.maximum_copies') >= 1
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'prohibited_combination'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.with_card_ids') = 'array'
    AND json_array_length(NEW.direct_card_ids_json) >= 1
    AND json_array_length(NEW.effect_json, '$.with_card_ids') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.effect_json, '$.with_card_ids')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(NEW.effect_json, '$.with_card_ids')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'membership'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 3
    AND json_type(NEW.effect_json, '$.attribute') = 'text'
    AND length(trim(json_extract(NEW.effect_json, '$.attribute'))) > 0
    AND json_type(NEW.effect_json, '$.includes_any') = 'array'
    AND json_array_length(NEW.effect_json, '$.includes_any') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.effect_json, '$.includes_any')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(NEW.effect_json, '$.includes_any')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'rotation'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.eligible_blocks') = 'array'
    AND json_array_length(NEW.effect_json, '$.eligible_blocks') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.effect_json, '$.eligible_blocks')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value FROM json_each(NEW.effect_json, '$.eligible_blocks')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'release_timing'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.legal_from') = 'text'
    AND json_extract(NEW.effect_json, '$.legal_from')
      GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(json_extract(NEW.effect_json, '$.legal_from')) =
      json_extract(NEW.effect_json, '$.legal_from')
  )
  OR (
    json_extract(NEW.effect_json, '$.type') = 'unresolved'
    AND (SELECT COUNT(*) FROM json_each(NEW.effect_json)) = 2
    AND json_type(NEW.effect_json, '$.reason') = 'text'
    AND length(trim(json_extract(NEW.effect_json, '$.reason'))) > 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_effect_invalid');
END;

CREATE TRIGGER legality_rule_card_ids_canonical_insert
BEFORE INSERT ON legality_rules
WHEN NOT (
  json_valid(NEW.card_ids_json)
  AND json_type(NEW.card_ids_json) = 'array'
  AND json_valid(NEW.direct_card_ids_json)
  AND json_type(NEW.direct_card_ids_json) = 'array'
  AND json_valid(NEW.effect_json)
  AND json_type(NEW.effect_json) = 'object'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.direct_card_ids_json) AS item
    WHERE item.type <> 'text'
      OR length(item.value) NOT BETWEEN 1 AND 200
      OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR item.value GLOB '*[^A-Za-z0-9._:-]*'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.direct_card_ids_json) AS item
    JOIN json_each(NEW.direct_card_ids_json) AS prior
      ON prior.key = item.key - 1
    WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
  )
  AND (
    (
      json_extract(NEW.effect_json, '$.type') =
        'prohibited_combination'
      AND json_type(
        NEW.effect_json,
        '$.with_card_ids'
      ) = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          json_extract(NEW.effect_json, '$.with_card_ids')
        ) AS item
        WHERE item.type <> 'text'
          OR length(item.value) NOT BETWEEN 1 AND 200
          OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
          OR item.value GLOB '*[^A-Za-z0-9._:-]*'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          json_extract(NEW.effect_json, '$.with_card_ids')
        ) AS item
        JOIN json_each(
          json_extract(NEW.effect_json, '$.with_card_ids')
        ) AS prior ON prior.key = item.key - 1
        WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
      )
    )
    OR (
      COALESCE(json_extract(NEW.effect_json, '$.type'), '') <>
        'prohibited_combination'
      AND json_type(
        NEW.effect_json,
        '$.with_card_ids'
      ) IS NULL
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.card_ids_json) AS item
    WHERE item.type <> 'text'
      OR length(item.value) NOT BETWEEN 1 AND 200
      OR substr(item.value, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR item.value GLOB '*[^A-Za-z0-9._:-]*'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(NEW.card_ids_json) AS item
    JOIN json_each(NEW.card_ids_json) AS prior
      ON prior.key = item.key - 1
    WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
  )
  AND NOT EXISTS (
    SELECT value FROM json_each(NEW.card_ids_json)
    EXCEPT
    SELECT value FROM (
      SELECT value FROM json_each(NEW.direct_card_ids_json)
      UNION
      SELECT value
      FROM json_each(
        CASE
          WHEN json_type(
            NEW.effect_json,
            '$.with_card_ids'
          ) = 'array'
          THEN json_extract(NEW.effect_json, '$.with_card_ids')
          ELSE '[]'
        END
      )
    )
  )
  AND NOT EXISTS (
    SELECT value FROM (
      SELECT value FROM json_each(NEW.direct_card_ids_json)
      UNION
      SELECT value
      FROM json_each(
        CASE
          WHEN json_type(
            NEW.effect_json,
            '$.with_card_ids'
          ) = 'array'
          THEN json_extract(NEW.effect_json, '$.with_card_ids')
          ELSE '[]'
        END
      )
    )
    EXCEPT
    SELECT value FROM json_each(NEW.card_ids_json)
  )
  AND json_array_length(NEW.card_ids_json) =
    json_array_length(NEW.direct_card_ids_json) +
    json_array_length(
      CASE
        WHEN json_type(
          NEW.effect_json,
          '$.with_card_ids'
        ) = 'array'
        THEN json_extract(NEW.effect_json, '$.with_card_ids')
        ELSE '[]'
      END
    )
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_card_ids_not_canonical');
END;

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

CREATE TRIGGER legality_rule_provenance_owner_insert
BEFORE INSERT ON legality_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = NEW.source_observation_set_id
    AND observation_set.source_snapshot_id = NEW.source_snapshot_id
    AND observation_set.source_lineage = NEW.source_lineage
    AND observation_set.supported_game = NEW.supported_game
    AND snapshot.source_lineage = NEW.source_lineage
    AND snapshot.supported_game = NEW.supported_game
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_provenance_owner_mismatch');
END;

CREATE TRIGGER legality_rule_provenance_owner_update
BEFORE UPDATE OF supported_game, source_lineage, source_snapshot_id,
  source_observation_set_id
ON legality_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM source_observation_sets AS observation_set
  JOIN source_snapshots AS snapshot
    ON snapshot.id = observation_set.source_snapshot_id
  WHERE observation_set.id = NEW.source_observation_set_id
    AND observation_set.source_snapshot_id = NEW.source_snapshot_id
    AND observation_set.source_lineage = NEW.source_lineage
    AND observation_set.supported_game = NEW.supported_game
    AND snapshot.source_lineage = NEW.source_lineage
    AND snapshot.supported_game = NEW.supported_game
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_provenance_owner_mismatch');
END;

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
  ),
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

CREATE TRIGGER revision_legality_rule_effect_valid_insert
BEFORE INSERT ON revision_legality_rules
WHEN NOT (
  (
    json_extract(NEW.document_json, '$.effect.type') IN ('eligible', 'ban')
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 1
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'copy_limit'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.maximum_copies') = 'integer'
    AND json_extract(NEW.document_json, '$.effect.maximum_copies') >= 1
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'prohibited_combination'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.with_card_ids') = 'array'
    AND json_array_length(NEW.document_json, '$.card_ids') >= 1
    AND json_array_length(NEW.document_json, '$.effect.with_card_ids') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.document_json, '$.effect.with_card_ids')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.document_json, '$.effect.with_card_ids')
      GROUP BY value HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT direct.value
      FROM json_each(NEW.document_json, '$.card_ids') AS direct
      JOIN json_each(
        NEW.document_json,
        '$.effect.with_card_ids'
      ) AS companion ON companion.value = direct.value
    )
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'membership'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 3
    AND json_type(NEW.document_json, '$.effect.attribute') = 'text'
    AND length(trim(json_extract(NEW.document_json, '$.effect.attribute'))) > 0
    AND json_type(NEW.document_json, '$.effect.includes_any') = 'array'
    AND json_array_length(NEW.document_json, '$.effect.includes_any') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.document_json, '$.effect.includes_any')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.document_json, '$.effect.includes_any')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'rotation'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.eligible_blocks') = 'array'
    AND json_array_length(NEW.document_json, '$.effect.eligible_blocks') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.document_json, '$.effect.eligible_blocks')
      WHERE type <> 'text' OR length(trim(value)) = 0
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.document_json, '$.effect.eligible_blocks')
      GROUP BY value HAVING COUNT(*) > 1
    )
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'release_timing'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.legal_from') = 'text'
    AND json_extract(NEW.document_json, '$.effect.legal_from')
      GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(json_extract(NEW.document_json, '$.effect.legal_from')) =
      json_extract(NEW.document_json, '$.effect.legal_from')
  )
  OR (
    json_extract(NEW.document_json, '$.effect.type') = 'unresolved'
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json, '$.effect')) = 2
    AND json_type(NEW.document_json, '$.effect.reason') = 'text'
    AND length(trim(json_extract(NEW.document_json, '$.effect.reason'))) > 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_effect_invalid');
END;

CREATE TRIGGER revision_legality_rule_matches_canonical
BEFORE INSERT ON revision_legality_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM legality_rules AS canonical
  WHERE canonical.id = NEW.legality_rule_id
    AND canonical.supported_game = NEW.supported_game
    AND canonical.region = NEW.region
    AND canonical.format = NEW.format
    AND canonical.event_tier IS NEW.event_tier
    AND canonical.effective_from IS NEW.effective_from
    AND canonical.effective_until IS NEW.effective_until
    AND canonical.unresolved_scope_json = NEW.unresolved_scope_json
    AND canonical.card_ids_json = NEW.card_ids_json
    AND json_extract(NEW.document_json, '$.id') = canonical.id
    AND json_extract(NEW.document_json, '$.official_id') =
      canonical.official_id
    AND json_extract(NEW.document_json, '$.game') =
      canonical.supported_game
    AND json_extract(NEW.document_json, '$.region') = canonical.region
    AND json_extract(NEW.document_json, '$.format') = canonical.format
    AND json_extract(NEW.document_json, '$.event_tier') IS
      canonical.event_tier
    AND json_extract(NEW.document_json, '$.effective_from') IS
      canonical.effective_from
    AND json_extract(NEW.document_json, '$.effective_until') IS
      canonical.effective_until
    AND json_extract(NEW.document_json, '$.unresolved_scope') IS
      json_extract(canonical.unresolved_scope_json, '$')
    AND json_type(NEW.document_json, '$.card_ids') = 'array'
    AND json_extract(NEW.document_json, '$.card_ids') =
      canonical.direct_card_ids_json
    AND json_array_length(
      json_extract(NEW.document_json, '$.card_ids')
    ) = json_array_length(canonical.direct_card_ids_json)
    AND json_extract(NEW.document_json, '$.official_wording') =
      canonical.official_wording
    AND json_type(NEW.document_json, '$.effect') = 'object'
    AND json_extract(NEW.document_json, '$.effect') =
      canonical.effect_json
    AND (
      (
        json_extract(canonical.effect_json, '$.type') =
          'prohibited_combination'
        AND json_type(
          NEW.document_json,
          '$.effect.with_card_ids'
        ) = 'array'
        AND json_extract(
          NEW.document_json,
          '$.effect.with_card_ids'
        ) = json_extract(canonical.effect_json, '$.with_card_ids')
        AND json_array_length(
          json_extract(
            NEW.document_json,
            '$.effect.with_card_ids'
          )
        ) = json_array_length(
          json_extract(canonical.effect_json, '$.with_card_ids')
        )
      )
      OR (
        json_extract(canonical.effect_json, '$.type') <>
          'prohibited_combination'
        AND json_type(
          NEW.document_json,
          '$.effect.with_card_ids'
        ) IS NULL
      )
    )
    AND json_extract(NEW.document_json, '$.source_lineage') =
      canonical.source_lineage
    AND json_extract(NEW.document_json, '$.source_snapshot_id') =
      canonical.source_snapshot_id
    AND json_extract(NEW.document_json, '$.source_observation_set_id') =
      canonical.source_observation_set_id
    AND json_extract(NEW.document_json, '$.source_observation_id') =
      canonical.source_observation_id
    AND json_extract(NEW.document_json, '$.source_observation_pointer') =
      canonical.source_observation_pointer
    AND json_extract(NEW.document_json, '$.source_field_pointers') =
      canonical.source_field_pointers_json
    AND json_extract(NEW.document_json, '$.first_revision_id') =
      canonical.first_revision_id
    AND json_extract(NEW.document_json, '$.last_observed_revision_id') =
      canonical.last_observed_revision_id
    AND json_extract(NEW.document_json, '$.current') = canonical.current
    AND json_extract(NEW.document_json, '$.last_missing_revision_id') IS
      canonical.last_missing_revision_id
    AND (SELECT COUNT(*) FROM json_each(NEW.document_json)) = 22
    AND NOT EXISTS (
      SELECT value
      FROM json_each(
        '["card_ids","current","effect","effective_from",'
        || '"effective_until","event_tier","first_revision_id",'
        || '"format","game","id","last_missing_revision_id",'
        || '"last_observed_revision_id","official_id",'
        || '"official_wording","region","source_field_pointers",'
        || '"source_lineage","source_observation_id",'
        || '"source_observation_pointer",'
        || '"source_observation_set_id","source_snapshot_id",'
        || '"unresolved_scope"]'
      )
      EXCEPT
      SELECT key FROM json_each(NEW.document_json)
    )
    AND NOT EXISTS (
      SELECT key FROM json_each(NEW.document_json)
      EXCEPT
      SELECT value
      FROM json_each(
        '["card_ids","current","effect","effective_from",'
        || '"effective_until","event_tier","first_revision_id",'
        || '"format","game","id","last_missing_revision_id",'
        || '"last_observed_revision_id","official_id",'
        || '"official_wording","region","source_field_pointers",'
        || '"source_lineage","source_observation_id",'
        || '"source_observation_pointer",'
        || '"source_observation_set_id","source_snapshot_id",'
        || '"unresolved_scope"]'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_canonical_mismatch');
END;

CREATE TRIGGER revision_legality_rules_immutable_update
BEFORE UPDATE ON revision_legality_rules
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
END;

CREATE TRIGGER revision_legality_rules_immutable_delete
BEFORE DELETE ON revision_legality_rules
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
END;

-- Revision-pinned Card substring search stays inside D1. Normalized search
-- chunks are indexed independently so matches cannot cross field
-- boundaries. The relational chunks remain the exportable source of truth:
-- recovery code temporarily removes the derived virtual index before D1
-- export, then reconstructs it after restore before marking it ready
-- again. Searches of three or more characters use FTS; only the one- and
-- two-character fallback remains in the relational term index.
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

-- Publication backups, verification, and recovery.
--
-- A backup is useful only when its exact bytes and verified restore are
-- durably attributable to one immutable attempt: the manifest, digests,
-- restore target, and complete verification evidence are required before
-- an attempt may become 'verified'.
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

CREATE TRIGGER catalogue_backup_attempts_legal_transition
BEFORE UPDATE OF state ON catalogue_backup_attempts
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('exporting', 'failed'))
  OR (OLD.state = 'exporting' AND NEW.state IN ('restoring_verification', 'failed'))
  OR (OLD.state = 'restoring_verification' AND NEW.state IN ('verifying', 'failed'))
  OR (OLD.state = 'verifying' AND NEW.state IN ('verified', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal backup attempt transition');
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

CREATE TRIGGER revision_card_search_chunks_insert_fts
AFTER INSERT ON revision_card_search_chunks
BEGIN
  INSERT INTO revision_card_search_fts_rows (
    catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
  ) VALUES (
    NEW.catalogue_revision_id, NEW.card_id, NEW.field_ordinal,
    NEW.chunk_ordinal
  );
  INSERT INTO revision_card_search_fts (
    rowid, revision_token, catalogue_revision_id, card_id,
    field_ordinal, chunk_ordinal, search_text
  ) VALUES (
    last_insert_rowid(), '|' || NEW.catalogue_revision_id || '|',
    NEW.catalogue_revision_id, NEW.card_id,
    NEW.field_ordinal,
    NEW.chunk_ordinal, NEW.search_text
  );
END;

CREATE TRIGGER revision_card_search_chunks_delete_fts
BEFORE DELETE ON revision_card_search_chunks
BEGIN
  DELETE FROM revision_card_search_fts
  WHERE rowid = (
    SELECT fts_rowid
    FROM revision_card_search_fts_rows
    WHERE catalogue_revision_id = OLD.catalogue_revision_id
      AND card_id = OLD.card_id
      AND field_ordinal = OLD.field_ordinal
      AND chunk_ordinal = OLD.chunk_ordinal
  );
  DELETE FROM revision_card_search_fts_rows
  WHERE catalogue_revision_id = OLD.catalogue_revision_id
    AND card_id = OLD.card_id
    AND field_ordinal = OLD.field_ordinal
    AND chunk_ordinal = OLD.chunk_ordinal;
END;

CREATE TRIGGER revision_card_search_chunks_before_update_fts
BEFORE UPDATE ON revision_card_search_chunks
BEGIN
  DELETE FROM revision_card_search_fts
  WHERE rowid = (
    SELECT fts_rowid
    FROM revision_card_search_fts_rows
    WHERE catalogue_revision_id = OLD.catalogue_revision_id
      AND card_id = OLD.card_id
      AND field_ordinal = OLD.field_ordinal
      AND chunk_ordinal = OLD.chunk_ordinal
  );
  DELETE FROM revision_card_search_fts_rows
  WHERE catalogue_revision_id = OLD.catalogue_revision_id
    AND card_id = OLD.card_id
    AND field_ordinal = OLD.field_ordinal
    AND chunk_ordinal = OLD.chunk_ordinal;
END;

CREATE TRIGGER revision_card_search_chunks_after_update_fts
AFTER UPDATE ON revision_card_search_chunks
BEGIN
  INSERT INTO revision_card_search_fts_rows (
    catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
  ) VALUES (
    NEW.catalogue_revision_id, NEW.card_id, NEW.field_ordinal,
    NEW.chunk_ordinal
  );
  INSERT INTO revision_card_search_fts (
    rowid, revision_token, catalogue_revision_id, card_id,
    field_ordinal, chunk_ordinal, search_text
  ) VALUES (
    last_insert_rowid(), '|' || NEW.catalogue_revision_id || '|',
    NEW.catalogue_revision_id, NEW.card_id,
    NEW.field_ordinal,
    NEW.chunk_ordinal, NEW.search_text
  );
END;

-- Production Release lease and curated revisions.
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

CREATE UNIQUE INDEX one_catalogue_backup_retry_per_failed_attempt
ON catalogue_backup_attempts (linked_attempt_id)
WHERE linked_attempt_id IS NOT NULL;

CREATE UNIQUE INDEX one_catalogue_backup_retry_workflow_per_failed_attempt
ON catalogue_backup_workflow_requests (linked_attempt_id)
WHERE linked_attempt_id IS NOT NULL;

CREATE TRIGGER catalogue_backup_verified_evidence_required
BEFORE UPDATE OF state ON catalogue_backup_attempts
WHEN NEW.state = 'verified' AND NOT (
  NEW.manifest_key IS NOT NULL
  AND NEW.content_sha256 NOT GLOB '*[^0-9a-f]*'
  AND length(NEW.content_sha256) = 64
  AND NEW.manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  AND length(NEW.manifest_sha256) = 64
  AND NEW.export_bytes >= 0
  AND NEW.schema_migration_level > 0
  AND length(NEW.disposable_database_id) > 0
  AND NEW.restore_generation > 0
  AND NEW.restore_phase = 'verified'
)
BEGIN
  SELECT RAISE(ABORT, 'verified backup evidence is incomplete');
END;

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

CREATE TRIGGER catalogue_recovery_transition_is_legal
BEFORE UPDATE OF state ON catalogue_recovery_operations
WHEN NOT (
  (OLD.state = 'preparing' AND NEW.state IN ('restoring', 'failed'))
  OR (OLD.state = 'restoring' AND NEW.state IN ('validating', 'failed'))
  OR (OLD.state = 'validating'
      AND NEW.state IN ('awaiting_acceptance', 'failed'))
  OR (OLD.state = 'awaiting_acceptance'
      AND NEW.state IN ('accepted', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal recovery transition');
END;

CREATE TRIGGER catalogue_recovery_operations_are_not_deleted
BEFORE DELETE ON catalogue_recovery_operations
BEGIN
  SELECT RAISE(ABORT, 'catalogue_recovery_audit_immutable');
END;

CREATE TRIGGER catalogue_recovery_health_remains_blocked
BEFORE UPDATE OF recovery_health ON operation_state
WHEN OLD.recovery_health = 'blocked'
  AND NEW.recovery_health <> 'blocked'
  AND EXISTS (
    SELECT 1 FROM catalogue_recovery_operations
    WHERE id = OLD.active_recovery_id AND state <> 'accepted'
  )
BEGIN
  SELECT RAISE(ABORT, 'recovery_not_accepted');
END;

-- Guarded catalogue export deletion.
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

CREATE TRIGGER catalogue_export_deletion_operation_guard
BEFORE INSERT ON catalogue_export_deletions
WHEN NOT EXISTS (
  SELECT 1
  FROM catalogue_export_deletion_plans AS plan
  JOIN catalogue_exports AS export
    ON export.catalogue_revision_id = plan.catalogue_revision_id
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  JOIN operation_state AS operation ON operation.singleton = 1
  WHERE plan.id = NEW.plan_id
    AND plan.catalogue_revision_id = NEW.catalogue_revision_id
    AND plan.manifest_digest = NEW.manifest_digest
    AND plan.expected_current_revision_id = NEW.expected_current_revision_id
    AND plan.object_set_digest = NEW.object_set_digest
    AND plan.expires_at > NEW.requested_at
    AND json_extract(NEW.request_json, '$.plan_id') = plan.id
    AND json_extract(NEW.request_json, '$.plan_digest') = plan.plan_digest
    AND json_extract(NEW.request_json, '$.catalogue_revision_id') = plan.catalogue_revision_id
    AND json_extract(NEW.request_json, '$.manifest_digest') = plan.manifest_digest
    AND json_extract(NEW.request_json, '$.expected_current_revision_id') = plan.expected_current_revision_id
    AND json_extract(NEW.request_json, '$.confirmation_revision_id') = plan.catalogue_revision_id
    AND json_extract(NEW.request_json, '$.deletion_id') = NEW.id
    AND json_extract(NEW.request_json, '$.idempotency_key') = NEW.idempotency_key
    AND export.maintenance_state = 'available'
    AND export.manifest_digest = plan.manifest_digest
    AND export.catalogue_revision_id <> catalogue.current_revision_id
    AND catalogue.current_revision_id = plan.expected_current_revision_id
    AND operation.active_ingestion_run_id IS NULL
    AND (
      operation.active_release_id IS NULL OR
      operation.active_release_expires_at <= NEW.requested_at
    )
    AND operation.recovery_health = 'healthy'
)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_guard_failed');
END;

CREATE TRIGGER catalogue_export_maintenance_transition_guard
BEFORE UPDATE OF maintenance_state, deletion_operation_id, deleted_at
ON catalogue_exports
WHEN NOT (
  (OLD.maintenance_state = 'available' AND NEW.maintenance_state = 'deleting'
    AND OLD.deletion_operation_id IS NULL AND NEW.deletion_operation_id IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM catalogue_export_deletions AS deletion
      WHERE deletion.id = NEW.deletion_operation_id
        AND deletion.catalogue_revision_id = NEW.catalogue_revision_id
        AND deletion.state = 'deleting'
    )) OR
  (OLD.maintenance_state = 'deleting' AND NEW.maintenance_state = 'deleted'
    AND NEW.deletion_operation_id = OLD.deletion_operation_id
    AND NEW.deleted_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_maintenance_transition_invalid');
END;

CREATE TRIGGER catalogue_export_deletion_operation_transition_guard
BEFORE UPDATE ON catalogue_export_deletions
WHEN NOT (
  (OLD.state = 'deleting' AND NEW.state IN ('deleted', 'failed')
    AND NEW.retry_owner_idempotency_key IS OLD.retry_owner_idempotency_key
    AND NEW.execution_owner_token IS OLD.execution_owner_token
    AND NEW.execution_lease_expires_at IS OLD.execution_lease_expires_at) OR
  (OLD.state = 'failed' AND NEW.state = 'deleting'
    AND NEW.retry_owner_idempotency_key IS NOT NULL
    AND NEW.execution_owner_token IS NOT NULL
    AND NEW.execution_lease_expires_at IS NOT NULL) OR
  (OLD.state = 'deleting' AND NEW.state = 'deleting'
    AND NEW.retry_owner_idempotency_key IS OLD.retry_owner_idempotency_key
    AND NEW.execution_owner_token IS NOT NULL
    AND NEW.execution_lease_expires_at IS NOT NULL)
)
OR (
  OLD.state = 'failed' AND NEW.state = 'deleting' AND NOT EXISTS (
    SELECT 1
    FROM catalogue_export_deletion_plans AS plan
    JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
    JOIN operation_state AS operation ON operation.singleton = 1
    WHERE plan.id = OLD.plan_id
      AND plan.object_set_digest = OLD.object_set_digest
      AND catalogue.current_revision_id = OLD.expected_current_revision_id
      AND plan.catalogue_revision_id <> catalogue.current_revision_id
      AND operation.active_ingestion_run_id IS NULL
      AND EXISTS (
        SELECT 1 FROM catalogue_export_deletion_retries AS retry
        WHERE retry.deletion_id = OLD.id
          AND retry.idempotency_key = NEW.retry_owner_idempotency_key
          AND retry.object_set_digest = OLD.object_set_digest
          AND retry.response_json IS NULL
      )
      AND (
        operation.active_release_id IS NULL OR
        operation.active_release_expires_at <= (
          SELECT retry.created_at
          FROM catalogue_export_deletion_retries AS retry
          WHERE retry.deletion_id = OLD.id AND retry.response_json IS NULL
            AND retry.idempotency_key = NEW.retry_owner_idempotency_key
          ORDER BY retry.created_at DESC LIMIT 1
        )
      )
      AND operation.recovery_health = 'healthy'
  )
)
OR NEW.id <> OLD.id
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

CREATE TRIGGER catalogue_export_deletion_operation_immutable_delete
BEFORE DELETE ON catalogue_export_deletions
BEGIN
  SELECT RAISE(ABORT, 'catalogue_export_deletion_operation_immutable');
END;

-- Guarded Production Release.
--
-- After migration begins a failure must be recorded with
-- roll_forward_required = 1; there is no rollback past that point.
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

CREATE TRIGGER production_release_transition_is_legal
BEFORE UPDATE OF state ON production_releases
WHEN NOT (
  (OLD.state = 'requested' AND NEW.state IN ('preflight', 'failed'))
  OR (OLD.state = 'preflight' AND NEW.state IN ('migrating', 'failed'))
  OR (OLD.state = 'migrating' AND NEW.state IN ('deploying', 'failed'))
  OR (OLD.state = 'deploying' AND NEW.state IN ('smoke_testing', 'failed'))
  OR (OLD.state = 'smoke_testing' AND NEW.state IN ('succeeded', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal production release transition');
END;

CREATE TRIGGER production_release_no_rollback_after_migration
BEFORE UPDATE OF state ON production_releases
WHEN OLD.state IN ('migrating', 'deploying', 'smoke_testing')
  AND NEW.state = 'failed' AND NEW.roll_forward_required <> 1
BEGIN
  SELECT RAISE(ABORT, 'roll_forward_required');
END;

CREATE TABLE production_release_transitions (
  release_id TEXT NOT NULL REFERENCES production_releases(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  from_state TEXT,
  to_state TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (release_id, ordinal)
);

CREATE TRIGGER production_release_requested_audit
AFTER INSERT ON production_releases
BEGIN
  INSERT INTO production_release_transitions (
    release_id, ordinal, from_state, to_state, evidence_json, observed_at
  ) VALUES (
    NEW.id, 0, NULL, 'requested', NEW.request_json, NEW.requested_at
  );
END;

CREATE TRIGGER production_release_state_audit
AFTER UPDATE OF state ON production_releases
BEGIN
  INSERT INTO production_release_transitions (
    release_id, ordinal, from_state, to_state, evidence_json, observed_at
  ) VALUES (
    NEW.id,
    (SELECT COALESCE(MAX(ordinal), -1) + 1
     FROM production_release_transitions WHERE release_id = NEW.id),
    OLD.state,
    NEW.state,
    json_object(
      'api_version_id', NEW.api_version_id,
      'ingestion_version_id', NEW.ingestion_version_id,
      'binding_observed', NEW.binding_observation_json IS NOT NULL,
      'smoke_observed', NEW.smoke_evidence_json IS NOT NULL,
      'failure_code', NEW.failure_code,
      'roll_forward_required', NEW.roll_forward_required
    ),
    COALESCE(NEW.terminal_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
END;

CREATE TRIGGER production_release_transition_audit_immutable_update
BEFORE UPDATE ON production_release_transitions
BEGIN
  SELECT RAISE(ABORT, 'production release transition audit is immutable');
END;

CREATE TRIGGER production_release_transition_audit_immutable_delete
BEFORE DELETE ON production_release_transitions
BEGIN
  SELECT RAISE(ABORT, 'production release transition audit is immutable');
END;

CREATE TRIGGER retain_reconciliation_candidate_evidence
AFTER INSERT ON reconciliation_candidates
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT NEW.source_observation_id,
         'reconciliation_candidates', NEW.source_observation_set_id
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = NEW.source_observation_id
  );
END;

CREATE TRIGGER retain_legality_rule_evidence
AFTER INSERT ON legality_rules
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT NEW.source_observation_id, 'legality_rules', NEW.id
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = NEW.source_observation_id
  );
END;

CREATE TRIGGER retain_revision_product_evidence
AFTER INSERT ON revision_products
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT json_extract(evidence.value, '$.id'),
         'revision_products', NEW.product_id
  FROM json_each(NEW.document_json, '$.included') AS evidence
  WHERE json_extract(evidence.value, '$.type') = 'source_observation'
    AND json_extract(evidence.value, '$.id') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM retained_source_observation_evidence AS retained
      WHERE retained.source_observation_id =
        json_extract(evidence.value, '$.id')
    );
END;

CREATE TRIGGER retain_product_relationship_evidence
AFTER INSERT ON reconciled_product_relationships
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT observation.value,
         'reconciled_product_relationships', NEW.id
  FROM json_each(NEW.source_observation_ids_json) AS observation
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = observation.value
  );
END;

CREATE TRIGGER retain_updated_product_relationship_evidence
AFTER UPDATE OF source_observation_ids_json
ON reconciled_product_relationships
BEGIN
  INSERT INTO retained_source_observation_evidence
    (source_observation_id, retained_by_table, retained_record_id)
  SELECT observation.value,
         'reconciled_product_relationships', NEW.id
  FROM json_each(NEW.source_observation_ids_json) AS observation
  WHERE NOT EXISTS (
    SELECT 1 FROM retained_source_observation_evidence AS retained
    WHERE retained.source_observation_id = observation.value
  );
END;

-- Keep both Production Release lease vocabularies in step (see
-- operation_state).
CREATE TRIGGER production_release_lease_shape_guard_v2
BEFORE UPDATE OF active_production_release_id,
  active_production_release_expires_at ON operation_state
WHEN (NEW.active_production_release_id IS NULL) <>
    (NEW.active_production_release_expires_at IS NULL)
  OR (NEW.active_production_release_expires_at IS NOT NULL AND (
    NEW.active_production_release_expires_at NOT GLOB
      '????-??-??T??:??:??.???Z'
    OR julianday(NEW.active_production_release_expires_at) IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'production_release_lease_invalid');
END;

CREATE TRIGGER production_release_lease_sync_from_legacy
AFTER UPDATE OF active_release_id, active_release_expires_at
ON operation_state
WHEN NEW.active_production_release_id IS NOT NEW.active_release_id
  OR NEW.active_production_release_expires_at IS NOT NEW.active_release_expires_at
BEGIN
  UPDATE operation_state
  SET active_production_release_id = NEW.active_release_id,
      active_production_release_expires_at = NEW.active_release_expires_at
  WHERE singleton = NEW.singleton;
END;

CREATE TRIGGER production_release_lease_sync_to_legacy
AFTER UPDATE OF active_production_release_id,
  active_production_release_expires_at ON operation_state
WHEN NEW.active_release_id IS NOT NEW.active_production_release_id
  OR NEW.active_release_expires_at IS NOT
    NEW.active_production_release_expires_at
BEGIN
  UPDATE operation_state
  SET active_release_id = NEW.active_production_release_id,
      active_release_expires_at = NEW.active_production_release_expires_at
  WHERE singleton = NEW.singleton;
END;

-- Unresolved-scope validation and applicability materialization (see
-- legality_rules).
CREATE TRIGGER legality_rule_scope_valid_insert
BEFORE INSERT ON legality_rules
WHEN NOT (
  (
    json_type(NEW.unresolved_scope_json) = 'null'
    AND NEW.effective_from IS NOT NULL
  )
  OR (
    json_type(NEW.unresolved_scope_json) = 'object'
    AND json_extract(NEW.effect_json, '$.type') = 'unresolved'
    AND json_array_length(NEW.direct_card_ids_json) >= 1
    AND (SELECT COUNT(*) FROM json_each(NEW.unresolved_scope_json)) = 1
    AND json_type(NEW.unresolved_scope_json, '$.dimensions') = 'array'
    AND json_array_length(NEW.unresolved_scope_json, '$.dimensions') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
      WHERE type <> 'text'
        OR value NOT IN ('effective_interval', 'event_tier', 'target_scope')
    )
    AND NOT EXISTS (
      SELECT value
      FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
      GROUP BY value HAVING COUNT(*) > 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.unresolved_scope_json, '$.dimensions') AS item
      JOIN json_each(
        NEW.unresolved_scope_json,
        '$.dimensions'
      ) AS prior ON prior.key = item.key - 1
      WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
    )
    AND (
      (
        EXISTS (
          SELECT 1
          FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
          WHERE value = 'effective_interval'
        )
        AND NEW.effective_from IS NULL
        AND NEW.effective_until IS NULL
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
          WHERE value = 'effective_interval'
        )
        AND NEW.effective_from IS NOT NULL
      )
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
        WHERE value = 'event_tier'
      )
      OR NEW.event_tier IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'legality_rule_scope_invalid');
END;

CREATE TRIGGER revision_legality_rule_scope_valid_insert
BEFORE INSERT ON revision_legality_rules
WHEN NOT (
  json_extract(NEW.document_json, '$.unresolved_scope') IS
    json_extract(NEW.unresolved_scope_json, '$')
  AND (
    (
      json_type(NEW.unresolved_scope_json) = 'null'
      AND NEW.effective_from IS NOT NULL
    )
    OR (
      json_type(NEW.unresolved_scope_json) = 'object'
      AND json_extract(NEW.document_json, '$.effect.type') = 'unresolved'
      AND json_array_length(NEW.document_json, '$.card_ids') >= 1
      AND (SELECT COUNT(*) FROM json_each(NEW.unresolved_scope_json)) = 1
      AND json_type(NEW.unresolved_scope_json, '$.dimensions') = 'array'
      AND json_array_length(NEW.unresolved_scope_json, '$.dimensions') >= 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
        WHERE type <> 'text'
          OR value NOT IN (
            'effective_interval', 'event_tier', 'target_scope'
          )
      )
      AND NOT EXISTS (
        SELECT value
        FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
        GROUP BY value HAVING COUNT(*) > 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.unresolved_scope_json, '$.dimensions') AS item
        JOIN json_each(
          NEW.unresolved_scope_json,
          '$.dimensions'
        ) AS prior ON prior.key = item.key - 1
        WHERE CAST(prior.value AS BLOB) >= CAST(item.value AS BLOB)
      )
      AND (
        (
          EXISTS (
            SELECT 1
            FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
            WHERE value = 'effective_interval'
          )
          AND NEW.effective_from IS NULL
          AND NEW.effective_until IS NULL
        )
        OR (
          NOT EXISTS (
            SELECT 1
            FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
            WHERE value = 'effective_interval'
          )
          AND NEW.effective_from IS NOT NULL
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
          WHERE value = 'event_tier'
        )
        OR NEW.event_tier IS NULL
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_scope_invalid');
END;

CREATE TRIGGER revision_legality_rule_applicability_insert
AFTER INSERT ON revision_legality_rules
BEGIN
  INSERT INTO revision_legality_rule_applicability (
    catalogue_revision_id, legality_rule_id, applicability_kind, card_id
  )
  SELECT NEW.catalogue_revision_id, NEW.legality_rule_id, 'card', value
  FROM json_each(NEW.card_ids_json);

  INSERT INTO revision_legality_rule_applicability (
    catalogue_revision_id, legality_rule_id, applicability_kind, card_id
  )
  SELECT NEW.catalogue_revision_id, NEW.legality_rule_id, 'all_cards', ''
  WHERE (
    json_array_length(NEW.card_ids_json) = 0
    AND json_type(NEW.unresolved_scope_json) = 'null'
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.unresolved_scope_json, '$.dimensions')
    WHERE value = 'target_scope'
  );
END;

-- Releases carry the 'season' precision Bandai publishes.
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

-- Curated revision pins are fixed when a run starts and cascade only when
-- a bootstrap run row is deleted (see guard_ingestion_deletion).
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

-- Ingestion Run lifecycle triggers, in their original creation order
-- because SQLite fires overlapping triggers in that order.
CREATE TRIGGER record_initial_ingestion_state
AFTER INSERT ON ingestion_runs
BEGIN
  INSERT INTO ingestion_run_transitions (
    ingestion_run_id,
    from_state,
    to_state,
    transitioned_at
  ) VALUES (
    NEW.id,
    NULL,
    NEW.state,
    NEW.started_at
  );
END;

CREATE TRIGGER record_ingestion_transition
AFTER UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
BEGIN
  INSERT INTO ingestion_run_transitions (
    ingestion_run_id,
    from_state,
    to_state,
    transitioned_at
  ) VALUES (
    NEW.id,
    OLD.state,
    NEW.state,
    COALESCE(NEW.terminal_at, NEW.candidate_created_at, NEW.started_at)
  );
END;

CREATE TRIGGER guard_active_ingestion_identity
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
  AND OLD.state IN (
    'planning',
    'collecting',
    'paused',
    'parsing',
    'reconciling',
    'awaiting_approval',
    'publishing'
  )
  AND NOT (
    OLD.state = 'publishing'
    AND NEW.state = 'failed'
    AND NEW.failure_code IN (
      'publication_abandoned',
      'publication_precondition_failed',
      'export_verification_failed'
    )
  )
  AND NOT (
    OLD.state = 'awaiting_approval'
    AND NEW.state = 'expired'
    AND OLD.approval_deadline IS NOT NULL
    AND NEW.terminal_at >= OLD.approval_deadline
  )
  AND NOT EXISTS (
    SELECT 1
    FROM operation_state
    WHERE singleton = 1
      AND active_ingestion_run_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'run_not_active');
END;

CREATE TRIGGER guard_terminal_ingestion_immutability
BEFORE UPDATE ON ingestion_runs
WHEN OLD.state IN ('published', 'rejected', 'expired', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal_ingestion_run_immutable');
END;

CREATE TRIGGER guard_reserved_approval
BEFORE UPDATE OF
  approval_json,
  approval_history_json,
  approval_idempotency_key,
  publication_revision_id,
  publication_started_at,
  publication_reconcile_after,
  publication_manifest_digest,
  publication_writer_token
ON ingestion_runs
WHEN OLD.state IN (
  'publishing',
  'published',
  'rejected',
  'expired',
  'failed'
)
  AND (
    OLD.approval_json IS NOT NEW.approval_json
    OR OLD.approval_history_json IS NOT NEW.approval_history_json
    OR OLD.approval_idempotency_key
      IS NOT NEW.approval_idempotency_key
    OR OLD.publication_revision_id
      IS NOT NEW.publication_revision_id
    OR OLD.publication_started_at
      IS NOT NEW.publication_started_at
    OR OLD.publication_reconcile_after
      IS NOT NEW.publication_reconcile_after
    OR OLD.publication_manifest_digest
      IS NOT NEW.publication_manifest_digest
    OR OLD.publication_writer_token
      IS NOT NEW.publication_writer_token
  )
BEGIN
  SELECT RAISE(ABORT, 'reserved_approval_immutable');
END;

CREATE TRIGGER guard_approval_transition
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state = 'awaiting_approval'
  AND NEW.state = 'publishing'
  AND NOT (
    NEW.approval_json IS NOT NULL
    AND json_extract(
      NEW.approval_json,
      '$.candidate_digest'
    ) = OLD.candidate_digest
    AND json_extract(
      NEW.approval_json,
      '$.expected_current_revision_id'
    ) = OLD.expected_current_revision_id
    AND json_extract(
      NEW.approval_json,
      '$.approved_at'
    ) < OLD.approval_deadline
    AND EXISTS (
      SELECT 1
      FROM catalogue_state AS catalogue
      JOIN operation_state AS operation ON operation.singleton = 1
      WHERE catalogue.singleton = 1
        AND catalogue.current_revision_id =
          OLD.expected_current_revision_id
        AND operation.active_ingestion_run_id = OLD.id
        AND operation.recovery_health = 'healthy'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'approval_guard_failed');
END;

CREATE TRIGGER guard_catalogue_publication
BEFORE INSERT ON catalogue_revisions
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_runs AS run
  JOIN operation_state AS operation ON operation.singleton = 1
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  WHERE run.id = NEW.ingestion_run_id
    AND run.state = 'publishing'
    AND run.candidate_digest = NEW.approved_candidate_digest
    AND run.expected_current_revision_id =
      NEW.expected_previous_revision_id
    AND json_extract(
      run.approval_json,
      '$.candidate_digest'
    ) = NEW.approved_candidate_digest
    AND json_extract(
      run.approval_json,
      '$.expected_current_revision_id'
    ) = NEW.expected_previous_revision_id
    AND operation.active_ingestion_run_id = run.id
    AND operation.recovery_health = 'healthy'
    AND catalogue.current_revision_id =
      NEW.expected_previous_revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication_guard_failed');
END;

CREATE TRIGGER guard_candidate_finalization
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state = 'reconciling'
  AND NEW.state = 'awaiting_approval'
  AND (
    NEW.candidate_digest IS NULL
    OR NEW.candidate_catalogue_digest IS NULL
    OR NEW.candidate_created_at IS NULL
    OR NEW.approval_deadline IS NULL
    OR NEW.approval_deadline <> strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      NEW.candidate_created_at,
      '+7 days'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_candidate_deadline');
END;

CREATE TRIGGER guard_fixed_candidate
BEFORE UPDATE OF
  candidate_digest,
  candidate_catalogue_digest,
  candidate_created_at,
  approval_deadline,
  expected_current_revision_id,
  candidate_json,
  selected_games_json,
  warnings_json
ON ingestion_runs
WHEN OLD.state IN (
  'awaiting_approval',
  'publishing',
  'published',
  'rejected',
  'expired',
  'failed'
)
  AND (
    OLD.candidate_digest IS NOT NEW.candidate_digest
    OR OLD.candidate_catalogue_digest
      IS NOT NEW.candidate_catalogue_digest
    OR OLD.candidate_created_at IS NOT NEW.candidate_created_at
    OR OLD.approval_deadline IS NOT NEW.approval_deadline
    OR OLD.expected_current_revision_id
      IS NOT NEW.expected_current_revision_id
    OR OLD.candidate_json IS NOT NEW.candidate_json
    OR OLD.selected_games_json IS NOT NEW.selected_games_json
    OR OLD.warnings_json IS NOT NEW.warnings_json
  )
BEGIN
  SELECT RAISE(ABORT, 'candidate_immutable');
END;

CREATE TRIGGER guard_no_change_result
BEFORE INSERT ON ingestion_no_change_results
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_runs AS run
  JOIN operation_state AS operation ON operation.singleton = 1
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  JOIN catalogue_revisions AS revision
    ON revision.id = catalogue.current_revision_id
  WHERE run.id = NEW.ingestion_run_id
    AND run.state = 'awaiting_approval'
    AND run.candidate_digest = NEW.candidate_digest
    AND run.expected_current_revision_id = NEW.catalogue_revision_id
    AND operation.active_ingestion_run_id = run.id
    AND operation.recovery_health = 'healthy'
    AND catalogue.current_revision_id = NEW.catalogue_revision_id
    AND revision.content_digest = run.candidate_catalogue_digest
    AND NEW.checked_at < run.approval_deadline
)
BEGIN
  SELECT RAISE(ABORT, 'no_change_guard_failed');
END;

-- The release workflow acquires its lease through a bootstrap ingestion
-- row. That row exists only so the ingestion worker recognises the lock as
-- live; once its exact operation-state pointer is gone it is safe to
-- remove. All domain runs remain immutable.
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

CREATE TRIGGER require_idle_ingestion
BEFORE INSERT ON ingestion_runs
WHEN EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1 AND (
    active_ingestion_run_id IS NOT NULL
    OR (
      active_release_id IS NOT NULL
      AND active_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'active_ingestion_run_or_release');
END;

-- Keep the database-level gate aligned with the Worker check so neither a
-- new ingestion nor a production-release bootstrap can begin while
-- recovery is blocked.
CREATE TRIGGER require_recovery_idle_ingestion
BEFORE INSERT ON ingestion_runs
WHEN EXISTS (
  SELECT 1 FROM operation_state
  WHERE singleton = 1
    AND (recovery_health = 'blocked' OR recovery_restore_guard = 'blocked')
    AND active_ingestion_run_id IS NULL
    AND NOT (
      active_release_id IS NOT NULL
      AND active_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'recovery_in_progress');
END;

-- One immutable pause record per capacity generation retains the facts the
-- owner needs to choose a meaningful capacity extension: the exact capacity
-- and generation that were exhausted, the unique Source Request identities
-- already held by the Source Lineage, the size of the rejected all-or-nothing
-- overflow batch, and the safe parent Source Request reference whose retained
-- discovery evidence can derive that batch again.
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

CREATE TRIGGER guard_capacity_pause_requires_paused_run
BEFORE INSERT ON ingestion_run_capacity_pauses
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'capacity_pause_requires_paused_run');
END;

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

-- One immutable record per successful extension advances the run's capacity
-- generation through an authenticated, idempotent, compare-and-set
-- administration action. The effective capacity of a Source Lineage within a
-- run becomes the newest extension's absolute capacity (still constrained by
-- the global emergency ceiling); a run without extensions keeps its Source
-- Adapter Version's registered capacity at generation 1. The stored request
-- digest and response document let an idempotent replay return the original
-- result without applying another extension.
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

CREATE TRIGGER guard_capacity_extension_requires_paused_run
BEFORE INSERT ON ingestion_run_capacity_extensions
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'capacity_extension_requires_paused_run');
END;

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

-- Recoverable transport and R2 persistence retry exhaustion pause the
-- Ingestion Run instead of failing it. Each Source Request carries a bounded
-- retry generation: attempts stay append-only and monotonically numbered, and
-- resuming a paused run opens the next generation by raising the counted
-- budget window rather than deleting or renumbering earlier attempts.
--
-- One immutable record per (run, request, generation) retry-exhaustion pause.
-- Unlike ingestion_run_capacity_pauses, the facts here describe the exhausted
-- request, not lineage capacity: the safe request reference, its hostname,
-- the exhausted generation, and the latest safe failure classification.
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

CREATE TRIGGER guard_retry_pause_requires_paused_run
BEFORE INSERT ON ingestion_run_retry_pauses
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'retry_pause_requires_paused_run');
END;

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

-- A stalled, errored, terminated, or unavailable collection Workflow pauses
-- the Ingestion Run instead of abandoning it. Parent and hostname-shard child
-- Workflow attempts become append-only records with deterministic identities,
-- so recovery supersedes an attempt by opening a new one without deleting or
-- renumbering history, and exactly one attempt per scope is current.
--
-- One immutable row per Workflow Attempt. The base identity groups the
-- attempts of one scope (the run's parent Workflow, or one hostname shard),
-- and the highest attempt number per scope is the current attempt.
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

-- One immutable record per (run, Workflow instance) Workflow Pause. Unlike
-- the capacity and retry-exhaustion pause tables, the facts here describe
-- the abandoned Workflow Attempt: its safe instance reference, the safe
-- status that classified it, and the deterministic last-progress time the
-- classification was derived from.
CREATE TABLE ingestion_run_workflow_pauses (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  workflow_instance_id TEXT NOT NULL,
  pause_reason TEXT NOT NULL CHECK (
    pause_reason IN (
      'source_workflow_stalled',
      'source_workflow_errored',
      'source_workflow_terminated',
      'source_workflow_unavailable'
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

CREATE TRIGGER guard_workflow_pause_requires_paused_run
BEFORE INSERT ON ingestion_run_workflow_pauses
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'workflow_pause_requires_paused_run');
END;

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

-- Termination is the owner's explicit decision that a paused run will not be
-- resumed. It is the only path from 'paused' to 'failed': the transition is
-- legal solely when the run carries the stable owner-termination reason and
-- an immutable termination record already exists for it. Every retained
-- Source Snapshot, Source Observation Set, request plan, collection plan,
-- fetch attempt, capture operation, pause record, Workflow Attempt, and
-- transition survives unchanged; the run merely becomes terminal, and the
-- administration action then releases the single active-run reservation.
--
-- One immutable record per terminated run retains the owner decision: which
-- pause was abandoned, when, and under which idempotency key. The stored
-- request digest and response document let an idempotent replay return the
-- original result without applying anything.
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
      'source_workflow_unavailable'
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

CREATE TRIGGER guard_termination_requires_paused_run
BEFORE INSERT ON ingestion_run_terminations
WHEN NOT EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE id = NEW.ingestion_run_id AND state = 'paused'
)
BEGIN
  SELECT RAISE(ABORT, 'termination_requires_paused_run');
END;

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

-- paused -> collecting is `keepr source resume`; paused -> failed is legal
-- only through explicit termination.
CREATE TRIGGER guard_legal_ingestion_transition
BEFORE UPDATE OF state ON ingestion_runs
WHEN OLD.state <> NEW.state
  AND NOT (
    (OLD.state = 'planning' AND NEW.state IN ('collecting', 'failed'))
    OR (
      OLD.state = 'collecting'
      AND NEW.state IN ('paused', 'parsing', 'failed')
    )
    OR (OLD.state = 'paused' AND NEW.state = 'collecting')
    OR (
      OLD.state = 'paused'
      AND NEW.state = 'failed'
      AND NEW.failure_code = 'ingestion_run_terminated'
      AND EXISTS (
        SELECT 1 FROM ingestion_run_terminations
        WHERE ingestion_run_id = OLD.id
      )
    )
    OR (OLD.state = 'parsing' AND NEW.state IN ('reconciling', 'failed'))
    OR (
      OLD.state = 'reconciling'
      AND NEW.state IN ('awaiting_approval', 'failed')
    )
    OR (
      OLD.state = 'awaiting_approval'
      AND NEW.state IN (
        'publishing',
        'rejected',
        'expired',
        'failed'
      )
    )
    OR (
      OLD.state = 'publishing'
      AND NEW.state IN ('published', 'failed')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'illegal_ingestion_transition');
END;

-- ADR 0005: rotating a worker bearer key is an operator procedure with no
-- attestation. Each rotation is recorded as one append-only log entry so
-- the history stays queryable. The row is the entry: a replay under the
-- same idempotency key returns it unchanged, and the stored request digest
-- turns a changed request under a reused key into an explicit conflict.
CREATE TABLE credential_rotation_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_class TEXT NOT NULL CHECK (
    credential_class IN ('api_bearer_key', 'ingestion_admin_key')
  ),
  operator_note TEXT NOT NULL CHECK (
    length(operator_note) BETWEEN 1 AND 500
  ),
  recorded_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER guard_credential_rotation_log_update
BEFORE UPDATE ON credential_rotation_log
BEGIN
  SELECT RAISE(ABORT, 'credential_rotation_log_immutable');
END;

CREATE TRIGGER guard_credential_rotation_log_delete
BEFORE DELETE ON credential_rotation_log
BEGIN
  SELECT RAISE(ABORT, 'credential_rotation_log_immutable');
END;

-- Hot-path indexes.
--
-- Card detail (src/catalogue/read.ts) filters one revision's printings by
-- card and orders by printing; the printing collection read and the
-- ingestion diagnostics sample order by (card_id, printing_id) under the
-- same revision. The primary key (catalogue_revision_id, printing_id) seeks
-- the revision and then filters every printing in it.
CREATE INDEX revision_printings_by_card
ON revision_printings (catalogue_revision_id, card_id, printing_id);

-- Collection inspection counts, sums, and lists one run's snapshots and
-- fetch attempts newest first; both tables are append-only and never pruned.
CREATE INDEX source_snapshots_by_run
ON source_snapshots (ingestion_run_id, retrieved_at DESC, id DESC);

CREATE INDEX source_fetch_attempts_by_run
ON source_fetch_attempts (
  ingestion_run_id,
  completed_at DESC,
  request_id DESC,
  attempt_number DESC
);

-- Locators are keyed by (source_lineage, locator, variant_identity) but
-- publication, candidate reads, and the repository look them up by printing.
CREATE INDEX reconciled_printing_locators_by_printing
ON reconciled_printing_locators (printing_id, source_lineage, locator);

-- Backup attempts are listed per revision newest first; the release and
-- recovery gates seek the same revision and filter the few rows by state.
-- (Retry children are already found through the partial unique index
-- one_catalogue_backup_retry_per_failed_attempt on linked_attempt_id.)
CREATE INDEX catalogue_backup_attempts_by_revision
ON catalogue_backup_attempts (
  catalogue_revision_id,
  started_at DESC,
  idempotency_key DESC
);

-- The run dashboard lists the twenty most recent runs from a table that
-- grows forever; the publication-reconcile poll picks the next publishing
-- run by its reconcile deadline, and the active-run release sweeps expired
-- runs. Every other state filter is anchored on the primary key.
CREATE INDEX ingestion_runs_recent
ON ingestion_runs (started_at DESC, id DESC);

CREATE INDEX ingestion_runs_by_state
ON ingestion_runs (state, publication_reconcile_after, id);

-- Seed rows.

-- The spine Catalogue Revision pointer: schema-valid before any publication.
INSERT INTO catalogue_state (singleton, current_revision_id, published_at)
VALUES (1, 'catrev_spine_000', '1970-01-01T00:00:00.000Z');

INSERT INTO operation_state (singleton, active_ingestion_run_id, recovery_health)
VALUES (1, NULL, 'healthy');

INSERT INTO card_search_fts_state (singleton, state, owner_token, lease_expires_at)
VALUES (1, 'ready', NULL, NULL);

-- Source Adapter Version registrations, in registration order. See the
-- source_adapter_versions table comment: this list must equal
-- installedSourceAdapterRegistrations in src/catalogue/source-adapters.ts.
INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin,
  request_capacity
) VALUES
  ('one-piece-json-document@1', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-card-document@1', 'production', 5000),
  ('one-piece-json-document@2', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-card-document@1', 'production', 5000),
  ('fixture-one-piece-json@1', 'one-piece-en', 'one-piece', 'one-piece@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 5000),
  ('fusion-world-en@1', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-card-document@1', 'production', 5000),
  ('digimon-en@1', 'digimon-en', 'digimon', 'digimon@1', 'digimon-card-document@1', 'production', 5000),
  ('gundam-en-asia@1', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-card-document@1', 'production', 5000),
  ('gundam-en-us@1', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-card-document@1', 'production', 5000),
  ('fixture-fusion-world-json@1', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 5000),
  ('fixture-digimon-json@1', 'digimon-en', 'digimon', 'digimon@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 5000),
  ('fixture-gundam-en-asia-json@1', 'gundam-en-asia', 'gundam', 'gundam@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 5000),
  ('fixture-gundam-en-us-json@1', 'gundam-en-us', 'gundam', 'gundam@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 5000),
  ('one-piece-en@1', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-en-raw-surfaces@1', 'production', 5000),
  ('fixture-one-piece-json@2', 'one-piece-en', 'one-piece', 'one-piece@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 5000),
  ('fixture-one-piece-json-capped@1', 'one-piece-en', 'one-piece', 'one-piece@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 5000),
  ('fusion-world-en@2', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-raw-surfaces@1', 'production', 5000),
  ('digimon-en@2', 'digimon-en', 'digimon', 'digimon@1', 'digimon-en-raw-surfaces@1', 'production', 5000),
  ('gundam-en-asia@2', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-en-asia-raw-surfaces@1', 'production', 5000),
  ('gundam-en-us@2', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-en-us-raw-surfaces@1', 'production', 5000),
  ('one-piece-official-errata-html@1', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-official-errata-html@1', 'production', 5000),
  ('fixture-one-piece-official-errata-json@1', 'one-piece-en', 'one-piece', 'one-piece@1', 'synthetic-official-errata-fixture@1', 'synthetic_fixture', 5000),
  ('one-piece-en@2', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-en-raw-surfaces-with-legality@2', 'production', 5000),
  ('fusion-world-en@3', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-raw-surfaces-with-legality@2', 'production', 5000),
  ('digimon-en@3', 'digimon-en', 'digimon', 'digimon@1', 'digimon-en-raw-surfaces-with-legality@2', 'production', 5000),
  ('gundam-en-asia@3', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-en-asia-raw-surfaces-with-legality@2', 'production', 5000),
  ('gundam-en-us@3', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-en-us-raw-surfaces-with-legality@2', 'production', 5000),
  ('fixture-one-piece-json@3', 'one-piece-en', 'one-piece', 'one-piece@1', 'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture', 5000),
  ('fixture-fusion-world-json@2', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture', 5000),
  ('fixture-digimon-json@2', 'digimon-en', 'digimon', 'digimon@1', 'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture', 5000),
  ('fixture-gundam-en-asia-json@2', 'gundam-en-asia', 'gundam', 'gundam@1', 'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture', 5000),
  ('fixture-gundam-en-us-json@2', 'gundam-en-us', 'gundam', 'gundam@1', 'synthetic-fixture-card-document-with-legality@2', 'synthetic_fixture', 5000),
  ('one-piece-en@3', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-en-complete-catalogue@3', 'production', 5000),
  ('fusion-world-en@4', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-raw-surfaces-with-legality-and-catalogue@3', 'production', 5000),
  ('digimon-en@4', 'digimon-en', 'digimon', 'digimon@1', 'digimon-en-raw-surfaces-complete-catalogue@3', 'production', 5000),
  ('gundam-en-asia@4', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-en-asia-raw-surfaces-complete-catalogue@3', 'production', 5000),
  ('gundam-en-us@4', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-en-us-raw-surfaces-complete-catalogue@3', 'production', 5000),
  ('one-piece-en@4', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-en-restructured-complete-catalogue@4', 'production', 5000),
  ('fusion-world-en@5', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-restructured-complete-catalogue@4', 'production', 5000),
  ('digimon-en@5', 'digimon-en', 'digimon', 'digimon@1', 'digimon-en-restructured-complete-catalogue@4', 'production', 5000),
  ('gundam-en-asia@5', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-en-asia-restructured-complete-catalogue@4', 'production', 5000),
  ('gundam-en-us@5', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-en-us-restructured-complete-catalogue@4', 'production', 5000),
  ('one-piece-en@5', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-en-restructured-complete-catalogue@5', 'production', 5000),
  ('fusion-world-en@6', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-restructured-complete-catalogue@5', 'production', 5000),
  ('digimon-en@6', 'digimon-en', 'digimon', 'digimon@1', 'digimon-en-restructured-complete-catalogue@5', 'production', 5000),
  ('gundam-en-asia@6', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-en-asia-restructured-complete-catalogue@5', 'production', 5000),
  ('gundam-en-us@6', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-en-us-restructured-complete-catalogue@5', 'production', 5000),
  ('one-piece-en@6', 'one-piece-en', 'one-piece', 'one-piece@1', 'one-piece-en-restructured-complete-catalogue@6', 'production', 5000),
  ('gundam-en-asia@7', 'gundam-en-asia', 'gundam', 'gundam@1', 'gundam-en-asia-restructured-complete-catalogue@6', 'production', 5000),
  ('gundam-en-us@7', 'gundam-en-us', 'gundam', 'gundam@1', 'gundam-en-us-restructured-complete-catalogue@6', 'production', 5000),
  ('fusion-world-en@7', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-restructured-complete-catalogue@6', 'production', 5000),
  ('digimon-en@7', 'digimon-en', 'digimon', 'digimon@1', 'digimon-en-restructured-complete-catalogue@6', 'production', 5000),
  ('fusion-world-en@8', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-restructured-complete-catalogue@7', 'production', 5000),
  ('fusion-world-en@9', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'fusion-world-en-restructured-complete-catalogue@7', 'production', 15000),
  ('fixture-fusion-world-json-large@1', 'fusion-world-en', 'fusion-world', 'fusion-world@1', 'synthetic-fixture-card-document@1', 'synthetic_fixture', 15000);

INSERT INTO catalogue_schema_state (singleton, migration_level)
VALUES (1, 1);
