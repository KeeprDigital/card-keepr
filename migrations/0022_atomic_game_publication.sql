SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=21
THEN 1 ELSE json_extract('schema_level_mismatch_expected_21','$') END;

-- Approval is an immutable owner decision, independently of subsequent work.
CREATE TABLE game_publication_operations (
 id TEXT PRIMARY KEY,
 candidate_id TEXT NOT NULL UNIQUE REFERENCES game_candidates(id),
 manifest_digest TEXT NOT NULL,
 expected_game_revision_id TEXT NOT NULL,
 candidate_generation INTEGER NOT NULL,
 deadline TEXT NOT NULL,
 approved_at TEXT NOT NULL,
 inspection_receipt TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 approval_json TEXT NOT NULL CHECK(json_valid(approval_json)),
 generation INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('approved','waiting_artifacts','waiting_backup','retry_paused','published','failed')),
 failure_code TEXT,
 resulting_revision_id TEXT,
 backup_attempt_id TEXT,
 published_at TEXT
);
CREATE TRIGGER game_publication_approval_immutable BEFORE UPDATE ON game_publication_operations
WHEN NEW.id<>OLD.id OR NEW.candidate_id<>OLD.candidate_id OR NEW.manifest_digest<>OLD.manifest_digest
 OR NEW.expected_game_revision_id<>OLD.expected_game_revision_id OR NEW.candidate_generation<>OLD.candidate_generation
 OR NEW.deadline<>OLD.deadline OR NEW.approved_at<>OLD.approved_at OR NEW.inspection_receipt<>OLD.inspection_receipt
 OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_json<>OLD.request_json OR NEW.approval_json<>OLD.approval_json
BEGIN SELECT RAISE(ABORT,'publication_approval_immutable'); END;
CREATE TRIGGER game_publication_operation_retained BEFORE DELETE ON game_publication_operations
BEGIN SELECT RAISE(ABORT,'publication_operation_retained'); END;
CREATE TABLE game_publication_actions (
 idempotency_key TEXT PRIMARY KEY,
 publication_operation_id TEXT NOT NULL REFERENCES game_publication_operations(id),
 request_json TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE TRIGGER game_publication_actions_immutable BEFORE UPDATE ON game_publication_actions
BEGIN SELECT RAISE(ABORT,'publication_action_immutable'); END;
CREATE TRIGGER game_publication_actions_retained BEFORE DELETE ON game_publication_actions
BEGIN SELECT RAISE(ABORT,'publication_action_retained'); END;
-- Retain the common ancestry spine, without making collection identity a
-- unique publication identity. Deferred FK checks close over the rebuilt table.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE catalogue_revisions_native (
 id TEXT PRIMARY KEY,
 ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
 published_at TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 expected_previous_revision_id TEXT NOT NULL,
 approved_candidate_digest TEXT NOT NULL,
 publication_operation_id TEXT UNIQUE REFERENCES game_publication_operations(id)
);
CREATE TABLE publication_revision_migration_copy AS SELECT * FROM catalogue_revisions;
DROP TABLE catalogue_revisions;
ALTER TABLE catalogue_revisions_native RENAME TO catalogue_revisions;
INSERT INTO catalogue_revisions SELECT *,NULL FROM publication_revision_migration_copy;
DROP TABLE publication_revision_migration_copy;
CREATE UNIQUE INDEX catalogue_legacy_collection_identity ON catalogue_revisions(ingestion_run_id)
 WHERE publication_operation_id IS NULL;
CREATE TABLE catalogue_composition_games (
 catalogue_revision_id TEXT NOT NULL REFERENCES catalogue_revisions(id),
 supported_game TEXT NOT NULL,
 candidate_id TEXT NOT NULL REFERENCES game_candidates(id),
 game_revision_id TEXT NOT NULL,
 root_digest TEXT NOT NULL,
 PRIMARY KEY(catalogue_revision_id,supported_game)
);
CREATE TRIGGER catalogue_composition_immutable BEFORE UPDATE ON catalogue_composition_games
BEGIN SELECT RAISE(ABORT,'catalogue_composition_immutable'); END;
CREATE TRIGGER catalogue_composition_retained BEFORE DELETE ON catalogue_composition_games
BEGIN SELECT RAISE(ABORT,'catalogue_composition_retained'); END;
ALTER TABLE catalogue_backup_attempts ADD COLUMN publication_operation_id TEXT REFERENCES game_publication_operations(id);
CREATE UNIQUE INDEX catalogue_publication_backup ON catalogue_backup_attempts(publication_operation_id)
 WHERE publication_operation_id IS NOT NULL AND linked_attempt_id IS NULL;
UPDATE catalogue_schema_state SET migration_level=22 WHERE singleton=1;
