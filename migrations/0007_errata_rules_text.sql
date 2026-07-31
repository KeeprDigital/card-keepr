INSERT INTO source_adapter_versions (
  adapter_version,
  source_lineage,
  supported_game,
  game_profile_version,
  parser_contract,
  adapter_origin
) VALUES
  (
    'one-piece-official-errata-html@1',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'one-piece-official-errata-html@1',
    'production'
  ),
  (
    'fixture-one-piece-official-errata-json@1',
    'one-piece-en',
    'one-piece',
    'one-piece@1',
    'synthetic-official-errata-fixture@1',
    'synthetic_fixture'
  );

ALTER TABLE reconciliation_candidates
  ADD COLUMN observation_kind TEXT NOT NULL DEFAULT 'card_printing'
  CHECK (observation_kind IN ('card_printing', 'official_erratum'));

ALTER TABLE reconciliation_candidates
  ADD COLUMN source_card_facts_json TEXT CHECK (
    source_card_facts_json IS NULL OR json_valid(source_card_facts_json)
  );

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

CREATE INDEX revision_errata_by_revision
  ON revision_errata(catalogue_revision_id, erratum_id);

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
