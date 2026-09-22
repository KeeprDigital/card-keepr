-- #327: resumable archive decoding. A decode keeps one serialized gzip/JSONL
-- continuation (compressed bit cursor, 32 KiB history, open block bytes and
-- digests) so each bounded Workflow step continues where the last stopped
-- instead of re-inflating the retained prefix. The checkpoint never runs ahead
-- of committed blocks; a stale or absent one only re-verifies retained blocks.
-- Sealing clears it. Existing rows start without one.
SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=50
THEN 1 ELSE json_extract('schema_level_mismatch_expected_50','$') END;

ALTER TABLE source_archive_decodes ADD COLUMN checkpoint_block INTEGER
  CHECK(checkpoint_block IS NULL OR checkpoint_block BETWEEN 0 AND 512);
ALTER TABLE source_archive_decodes ADD COLUMN checkpoint_json TEXT
  CHECK(checkpoint_json IS NULL OR (json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB)) <= 16384));
ALTER TABLE source_archive_decodes ADD COLUMN checkpoint_bytes BLOB
  CHECK(checkpoint_bytes IS NULL OR length(checkpoint_bytes) <= 1048576);

CREATE TRIGGER archive_decode_checkpoint_bound BEFORE UPDATE OF checkpoint_block,checkpoint_json,checkpoint_bytes
ON source_archive_decodes
WHEN (NEW.checkpoint_block IS NULL) != (NEW.checkpoint_json IS NULL)
 OR (NEW.checkpoint_block IS NULL) != (NEW.checkpoint_bytes IS NULL)
 OR NEW.checkpoint_block > NEW.next_block
 OR (NEW.state='decoded' AND NEW.checkpoint_block IS NOT NULL)
 OR (NEW.checkpoint_block IS NOT NULL AND OLD.checkpoint_block IS NOT NULL AND NEW.checkpoint_block < OLD.checkpoint_block)
BEGIN SELECT RAISE(ABORT,'archive_decode_checkpoint_invalid'); END;

UPDATE catalogue_schema_state SET migration_level=51 WHERE singleton=1 AND migration_level=50;
SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('schema_level_update_count_mismatch','$') END;
