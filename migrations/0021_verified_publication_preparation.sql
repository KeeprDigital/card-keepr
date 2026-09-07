-- #227: private preparation only; no published pointer or consumer table changes.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 20
  THEN 1 ELSE json_extract('{}', 'publication_preparation_requires_schema20') END;
CREATE TABLE publication_preparations (
  candidate_id TEXT PRIMARY KEY REFERENCES game_candidates(id),
  manifest_digest TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  state TEXT NOT NULL CHECK(state IN ('preparing','verified','retry_paused','failed')),
  phase TEXT NOT NULL CHECK(phase IN ('images','exports','projections','composition')),
  cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json) AND length(CAST(cursor_json AS BLOB)) <= 16384),
  failures INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  root_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER publication_preparation_identity BEFORE UPDATE ON publication_preparations
WHEN NEW.candidate_id <> OLD.candidate_id OR NEW.manifest_digest <> OLD.manifest_digest OR NEW.generation <> OLD.generation
  OR NEW.created_at <> OLD.created_at OR NEW.sequence <> OLD.sequence + 1
BEGIN SELECT RAISE(ABORT, 'publication_preparation_identity_conflict'); END;
CREATE TABLE publication_preparation_actions (
  idempotency_key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 32768)
);
CREATE TABLE publication_preparation_artifacts (
  candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  reused INTEGER NOT NULL CHECK(reused IN (0,1)),
  PRIMARY KEY(candidate_id, ordinal)
);
CREATE TABLE publication_projection_batches (
  candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK(json_valid(content) AND length(CAST(content AS BLOB)) <= 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  PRIMARY KEY(candidate_id, ordinal)
);
CREATE TABLE publication_composition_nodes (
  candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
  level INTEGER NOT NULL CHECK(level >= 0),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length <= 16384),
  PRIMARY KEY(candidate_id, level, ordinal)
);
CREATE TRIGGER publication_preparation_actions_no_update BEFORE UPDATE ON publication_preparation_actions
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TRIGGER publication_preparation_actions_no_delete BEFORE DELETE ON publication_preparation_actions
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TRIGGER publication_preparation_artifacts_no_update BEFORE UPDATE ON publication_preparation_artifacts
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TRIGGER publication_preparation_artifacts_no_delete BEFORE DELETE ON publication_preparation_artifacts
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TRIGGER publication_projection_batches_no_update BEFORE UPDATE ON publication_projection_batches
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TRIGGER publication_projection_batches_no_delete BEFORE DELETE ON publication_projection_batches
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TRIGGER publication_composition_nodes_no_update BEFORE UPDATE ON publication_composition_nodes
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TRIGGER publication_composition_nodes_no_delete BEFORE DELETE ON publication_composition_nodes
BEGIN SELECT RAISE(ABORT, 'publication_artifact_immutable'); END;
CREATE TABLE publication_workflow_budgets (
  candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
  first_sequence INTEGER NOT NULL CHECK(first_sequence >= 0),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 40),
  PRIMARY KEY(candidate_id, first_sequence)
);
CREATE TRIGGER publication_workflow_budget_monotonic BEFORE UPDATE ON publication_workflow_budgets
WHEN NEW.candidate_id <> OLD.candidate_id OR NEW.first_sequence <> OLD.first_sequence OR NEW.attempts <> OLD.attempts + 1
BEGIN SELECT RAISE(ABORT, 'publication_workflow_budget_conflict'); END;
CREATE TRIGGER publication_workflow_budget_retained BEFORE DELETE ON publication_workflow_budgets
BEGIN SELECT RAISE(ABORT, 'publication_workflow_budget_retained'); END;
CREATE TABLE verified_publication_compositions (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
  content TEXT NOT NULL CHECK(json_valid(content) AND length(CAST(content AS BLOB)) <= 16384)
);
CREATE TRIGGER verified_publication_compositions_no_update BEFORE UPDATE ON verified_publication_compositions
BEGIN SELECT RAISE(ABORT, 'publication_composition_immutable'); END;
CREATE TRIGGER verified_publication_compositions_no_delete BEFORE DELETE ON verified_publication_compositions
BEGIN SELECT RAISE(ABORT, 'publication_composition_retained'); END;
CREATE TABLE publication_query_documents (
  candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  batch_ordinal INTEGER NOT NULL,
  PRIMARY KEY(candidate_id,kind,entity_id),
  FOREIGN KEY(candidate_id,batch_ordinal) REFERENCES publication_projection_batches(candidate_id,ordinal)
);
CREATE TABLE publication_search_chunks (
  candidate_id TEXT NOT NULL REFERENCES publication_preparations(candidate_id),
  card_id TEXT NOT NULL,
  field INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  search_text TEXT NOT NULL CHECK(length(CAST(search_text AS BLOB)) <= 65536),
  PRIMARY KEY(candidate_id,card_id,field,ordinal)
);
CREATE VIRTUAL TABLE publication_search_fts USING fts5(candidate_token, candidate_id UNINDEXED, card_id UNINDEXED, search_text, tokenize='trigram case_sensitive 1');
CREATE TRIGGER publication_query_documents_no_update BEFORE UPDATE ON publication_query_documents
BEGIN SELECT RAISE(ABORT,'publication_query_document_immutable'); END;
CREATE TRIGGER publication_query_documents_no_delete BEFORE DELETE ON publication_query_documents
BEGIN SELECT RAISE(ABORT,'publication_query_document_retained'); END;
CREATE TRIGGER publication_search_chunks_no_update BEFORE UPDATE ON publication_search_chunks
BEGIN SELECT RAISE(ABORT,'publication_search_chunk_immutable'); END;
CREATE TRIGGER publication_search_chunks_no_delete BEFORE DELETE ON publication_search_chunks
BEGIN SELECT RAISE(ABORT,'publication_search_chunk_retained'); END;
UPDATE catalogue_schema_state SET migration_level = 21 WHERE singleton = 1;
