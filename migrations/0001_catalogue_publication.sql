PRAGMA foreign_keys = ON;

CREATE TABLE catalogue_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_revision_id TEXT NOT NULL,
  published_at TEXT NOT NULL
);

INSERT INTO catalogue_state (
  singleton,
  current_revision_id,
  published_at
) VALUES (
  1,
  'catrev_spine_000',
  '1970-01-01T00:00:00.000Z'
);

CREATE TABLE operation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_ingestion_run_id TEXT,
  recovery_health TEXT NOT NULL CHECK (
    recovery_health IN ('healthy', 'degraded', 'blocked')
  )
);

INSERT INTO operation_state (
  singleton,
  active_ingestion_run_id,
  recovery_health
) VALUES (1, NULL, 'healthy');

CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (
    state IN (
      'planning',
      'collecting',
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
  approval_idempotency_key TEXT UNIQUE
);

CREATE TRIGGER require_idle_ingestion
BEFORE INSERT ON ingestion_runs
WHEN (SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1)
  IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'active_ingestion_run');
END;

CREATE TABLE catalogue_revisions (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL UNIQUE REFERENCES ingestion_runs(id),
  published_at TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  expected_previous_revision_id TEXT NOT NULL,
  approved_candidate_digest TEXT NOT NULL
);

CREATE TRIGGER guard_catalogue_publication
BEFORE INSERT ON catalogue_revisions
WHEN NOT EXISTS (
  SELECT 1
  FROM ingestion_runs AS run
  JOIN operation_state AS operation ON operation.singleton = 1
  JOIN catalogue_state AS catalogue ON catalogue.singleton = 1
  WHERE run.id = NEW.ingestion_run_id
    AND run.state = 'awaiting_approval'
    AND run.candidate_digest = NEW.approved_candidate_digest
    AND run.expected_current_revision_id = NEW.expected_previous_revision_id
    AND operation.active_ingestion_run_id = run.id
    AND operation.recovery_health = 'healthy'
    AND catalogue.current_revision_id = NEW.expected_previous_revision_id
    AND run.approval_deadline > NEW.published_at
)
BEGIN
  SELECT RAISE(ABORT, 'publication_guard_failed');
END;

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
  verified INTEGER NOT NULL CHECK (verified = 1)
);
