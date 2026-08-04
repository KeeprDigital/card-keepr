-- Revision-pinned Card substring search stays inside D1. Normalized search
-- chunks are indexed independently so matches cannot cross field boundaries.
-- The relational chunks remain the exportable source of truth: recovery code
-- temporarily removes this derived virtual index before D1 export, then
-- reconstructs it after restore before marking it ready again.
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

INSERT INTO card_search_fts_state (
  singleton, state, owner_token, lease_expires_at
) VALUES (1, 'ready', NULL, NULL);

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
  CHECK (
    (state = 'verified' AND d1_bookmark IS NOT NULL
      AND failure_code IS NULL AND failure_detail IS NULL
      AND completed_at IS NOT NULL)
    OR (state = 'failed' AND d1_bookmark IS NULL
      AND failure_code IS NOT NULL AND failure_detail IS NOT NULL
      AND completed_at IS NOT NULL)
    OR (state NOT IN ('verified', 'failed') AND d1_bookmark IS NULL
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

INSERT INTO revision_card_search_fts_rows (
  catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
)
SELECT catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
FROM revision_card_search_chunks;

CREATE VIRTUAL TABLE revision_card_search_fts USING fts5(
  revision_token,
  catalogue_revision_id UNINDEXED,
  card_id UNINDEXED,
  field_ordinal UNINDEXED,
  chunk_ordinal UNINDEXED,
  search_text,
  tokenize = 'trigram case_sensitive 1'
);

INSERT INTO revision_card_search_fts (
  rowid, revision_token, catalogue_revision_id, card_id,
  field_ordinal, chunk_ordinal, search_text
)
SELECT indexed.fts_rowid, '|' || chunk.catalogue_revision_id || '|',
       chunk.catalogue_revision_id, chunk.card_id,
       chunk.field_ordinal, chunk.chunk_ordinal, chunk.search_text
FROM revision_card_search_chunks AS chunk
JOIN revision_card_search_fts_rows AS indexed
  USING (catalogue_revision_id, card_id, field_ordinal, chunk_ordinal);

-- Searches of three or more characters now use FTS; only the one- and
-- two-character fallback remains in the relational term index.
DELETE FROM revision_card_search_terms
WHERE term LIKE 'g3:%';

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
