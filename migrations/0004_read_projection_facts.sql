-- The api worker reads only published projections (issue #98). Two read
-- paths reached past them: Printing Image content joined
-- reconciled_printing_images, the reconciliation cluster's image identity
-- table, for the media type, digest, byte length, and object key it serves;
-- and the Legality Status evidence sidecar joined source_snapshots, the
-- source-evidence cluster's capture table, for the retrieval instant of each
-- rule's Source Observation. Both facts are now written into the revision
-- projection at publication time, and the read cluster queries the
-- projection alone. (The third read path, Product evidence, already had its
-- fact in catalogue_curated_provenance and needed no schema change.)
--
-- The columns are added nullable because SQLite cannot add a NOT NULL
-- column without a default, then backfilled from the tables the read paths
-- used to join, and an AFTER INSERT trigger on each table rejects a new row
-- that omits them. AFTER rather than BEFORE so the existing BEFORE INSERT
-- guards on revision_legality_rules keep reporting their own diagnostics
-- first (SQLite fires the newest trigger first). The revision_legality_rules
-- immutability trigger is dropped for the backfill and recreated verbatim.
-- Per ADR 0008 this migration is folded into the baseline at Go-Live, where
-- the columns become NOT NULL.

SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 3
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_3', '$')
END;

-- revision_printing_images: the content facts the api serves for a
-- published Printing Image, frozen per Catalogue Revision.
ALTER TABLE revision_printing_images ADD COLUMN media_type TEXT CHECK (
  media_type IS NULL OR media_type LIKE 'image/%'
);
ALTER TABLE revision_printing_images ADD COLUMN content_sha256 TEXT CHECK (
  content_sha256 IS NULL OR (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE revision_printing_images ADD COLUMN content_byte_length INTEGER CHECK (
  content_byte_length IS NULL OR content_byte_length > 0
);
ALTER TABLE revision_printing_images ADD COLUMN object_key TEXT CHECK (
  object_key IS NULL OR length(object_key) > 0
);

UPDATE revision_printing_images
SET media_type = (
      SELECT image.media_type FROM reconciled_printing_images AS image
      WHERE image.id = revision_printing_images.image_id
    ),
    content_sha256 = (
      SELECT image.content_sha256 FROM reconciled_printing_images AS image
      WHERE image.id = revision_printing_images.image_id
    ),
    content_byte_length = (
      SELECT image.content_byte_length FROM reconciled_printing_images AS image
      WHERE image.id = revision_printing_images.image_id
    ),
    object_key = (
      SELECT image.object_key FROM reconciled_printing_images AS image
      WHERE image.id = revision_printing_images.image_id
    );

CREATE TRIGGER revision_printing_image_content_projected
AFTER INSERT ON revision_printing_images
WHEN NEW.media_type IS NULL
  OR NEW.content_sha256 IS NULL
  OR NEW.content_byte_length IS NULL
  OR NEW.object_key IS NULL
BEGIN
  SELECT RAISE(ABORT, 'revision_printing_image_content_missing');
END;

-- revision_legality_rules: the retrieval instant of the Source Snapshot
-- behind each rule's Source Observation, which the Legality Status evidence
-- sidecar reports as captured_at.
ALTER TABLE revision_legality_rules ADD COLUMN source_retrieved_at TEXT;

DROP TRIGGER revision_legality_rules_immutable_update;

UPDATE revision_legality_rules
SET source_retrieved_at = (
  SELECT snapshot.retrieved_at FROM source_snapshots AS snapshot
  WHERE snapshot.id = json_extract(revision_legality_rules.document_json, '$.source_snapshot_id')
);

CREATE TRIGGER revision_legality_rules_immutable_update
BEFORE UPDATE ON revision_legality_rules
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
END;

CREATE TRIGGER revision_legality_rule_evidence_projected
AFTER INSERT ON revision_legality_rules
WHEN NEW.source_retrieved_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'revision_legality_rule_source_retrieved_at_missing');
END;

UPDATE catalogue_schema_state
SET migration_level = 4
WHERE singleton = 1;
