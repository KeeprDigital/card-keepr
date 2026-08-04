PRAGMA foreign_keys = ON;

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
    length(content_digest) = 64 AND content_digest GLOB '[0-9a-f]*'
  ),
  reviewed_source_digest TEXT NOT NULL CHECK (
    length(reviewed_source_digest) = 64 AND reviewed_source_digest GLOB '[0-9a-f]*'
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
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  response_status INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ingestion_run_curated_revisions (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  revision_id TEXT NOT NULL REFERENCES curated_revisions(id),
  content_digest TEXT NOT NULL,
  reviewed_source_digest TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, ordinal),
  UNIQUE (ingestion_run_id, revision_id)
);

CREATE TABLE ingestion_run_curated_revision_sets (
  ingestion_run_id TEXT PRIMARY KEY REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  revision_ids_json TEXT NOT NULL CHECK (json_valid(revision_ids_json)),
  set_digest TEXT NOT NULL CHECK (length(set_digest) = 64),
  pinned_at TEXT NOT NULL
);

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
  content_digest TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (catalogue_revision_id, curated_revision_id)
);
