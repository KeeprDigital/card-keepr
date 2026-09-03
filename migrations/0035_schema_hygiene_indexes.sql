-- Issue #72: hot-path indexes, dead-index removal, and a loud schema-level
-- precondition.
--
-- Every bump since 0015 was `UPDATE ... WHERE migration_level = N`, which
-- silently no-ops when the recorded level is wrong (0017 and 0018 shipped
-- without bumps and 0019 papered over the gap). A stale level poisons backup
-- and restore verification, which compares a backup's stamped level with the
-- live one. From this migration on, the first statement asserts the expected
-- level and aborts the whole migration on mismatch: json_extract on a
-- non-JSON string raises "malformed JSON", the same statement-level gate the
-- production-release and backup batches already use. The final UPDATE then
-- needs no level clause because the guard has proven it.
SELECT CASE
  WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1) = 34
  THEN 1
  ELSE json_extract('schema_level_mismatch_expected_34', '$')
END;

-- Card detail (src/catalogue/read.ts) filters one revision's printings by
-- card and orders by printing; the printing collection read and the
-- ingestion diagnostics sample order by (card_id, printing_id) under the
-- same revision. The primary key (catalogue_revision_id, printing_id) seeks
-- the revision and then filters every printing in it.
CREATE INDEX revision_printings_by_card
ON revision_printings (catalogue_revision_id, card_id, printing_id);

-- Collection inspection counts, sums, and lists one run's snapshots and
-- fetch attempts newest first; both tables are append-only and never pruned,
-- and neither had an index led by ingestion_run_id.
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
-- grows forever. Every state filter in the codebase is anchored on the
-- primary key, so the ordering is the only unindexed access.
CREATE INDEX ingestion_runs_recent
ON ingestion_runs (started_at DESC, id DESC);

-- release_regions_json is a JSON array; no query can seek it, and the
-- revision prefix is already served by revision_products_catalogue_order.
DROP INDEX revision_products_region;

-- Identical column list to the table's primary key.
DROP INDEX revision_errata_by_revision;

UPDATE catalogue_schema_state
SET migration_level = 35
WHERE singleton = 1;
