-- #232: widen existing closed game contracts without publishing or enabling data.

-- Follows the fresh-baseline handoff migration 0027.

SELECT CASE WHEN (SELECT migration_level FROM catalogue_schema_state WHERE singleton=1)=27 THEN 1 ELSE json_extract('schema_level_mismatch_expected_27','$') END;

PRAGMA defer_foreign_keys=ON;
DROP VIEW curated_revision_event_read;
DROP VIEW curated_revision_read;
DROP VIEW visible_prepared_curated_conflicts;

CREATE TABLE reconciled_errata_riftbound AS SELECT "id","game","target_type","target_id","effective_from","official_wording","corrected_value_json","first_revision_id","last_observed_revision_id" FROM reconciled_errata;
DROP TABLE reconciled_errata;
CREATE TABLE reconciled_errata (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL CHECK (
    game IN ('one-piece', 'fusion-world', 'digimon', 'gundam', 'riftbound')
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
INSERT INTO reconciled_errata("id","game","target_type","target_id","effective_from","official_wording","corrected_value_json","first_revision_id","last_observed_revision_id") SELECT "id","game","target_type","target_id","effective_from","official_wording","corrected_value_json","first_revision_id","last_observed_revision_id" FROM reconciled_errata_riftbound;
DROP TABLE reconciled_errata_riftbound;

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

CREATE TRIGGER recovery_fence_reconciled_errata_insert BEFORE INSERT ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_reconciled_errata_update BEFORE UPDATE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_reconciled_errata_delete BEFORE DELETE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TABLE source_freshness_riftbound AS SELECT "game","area","source_lineage","region","checked_at","ingestion_run_id" FROM source_freshness;
DROP TABLE source_freshness;
CREATE TABLE source_freshness (
  game TEXT NOT NULL CHECK (game IN ('one-piece', 'fusion-world', 'digimon', 'gundam', 'riftbound')),
  area TEXT NOT NULL CHECK (area IN ('cards-and-printings', 'products-and-releases', 'errata')),
  source_lineage TEXT NOT NULL DEFAULT '' CHECK (source_lineage = ''),
  region TEXT NOT NULL DEFAULT '' CHECK (region = ''),
  checked_at TEXT NOT NULL,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  PRIMARY KEY (game, area, source_lineage, region)
);
INSERT INTO source_freshness("game","area","source_lineage","region","checked_at","ingestion_run_id") SELECT "game","area","source_lineage","region","checked_at","ingestion_run_id" FROM source_freshness_riftbound;
DROP TABLE source_freshness_riftbound;

CREATE TRIGGER recovery_fence_source_freshness_insert BEFORE INSERT ON source_freshness
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_source_freshness_update BEFORE UPDATE ON source_freshness
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_source_freshness_delete BEFORE DELETE ON source_freshness
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TABLE curated_revisions_riftbound AS SELECT "id","game","target_key","target_kind","effective_from","effective_to","proposal_json","content_digest","reviewed_source_digest","schema_binding_json","author","created_at","status","event_version" FROM curated_revisions;
DROP TABLE curated_revisions;
CREATE TABLE curated_revisions (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL CHECK (
    game IN ('one-piece', 'fusion-world', 'digimon', 'gundam', 'riftbound')
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
INSERT INTO curated_revisions("id","game","target_key","target_kind","effective_from","effective_to","proposal_json","content_digest","reviewed_source_digest","schema_binding_json","author","created_at","status","event_version") SELECT "id","game","target_key","target_kind","effective_from","effective_to","proposal_json","content_digest","reviewed_source_digest","schema_binding_json","author","created_at","status","event_version" FROM curated_revisions_riftbound;
DROP TABLE curated_revisions_riftbound;

CREATE INDEX curated_revisions_active_target
ON curated_revisions (target_key, status, effective_from, effective_to);

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

CREATE INDEX curated_revisions_preparation_scan ON curated_revisions(game);

CREATE TRIGGER recovery_fence_curated_revisions_insert BEFORE INSERT ON curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_curated_revisions_update BEFORE UPDATE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_curated_revisions_delete BEFORE DELETE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TABLE reconciliation_checkpoints_riftbound AS SELECT "preparation_id","phase","ordinal","content","sha256" FROM reconciliation_checkpoints;
DROP TABLE reconciliation_checkpoints;
CREATE TABLE reconciliation_checkpoints (
  preparation_id TEXT NOT NULL REFERENCES reconciliation_operations(id),
  phase TEXT NOT NULL CHECK (phase IN ('curated_diagnostics', 'candidate_partitions', 'source_mappings', 'warning_summary', 'candidate_staging', 'game_preparation', 'identity_lookup', 'payload_preparation:candidate', 'payload_preparation:digest', 'canonical_digest:catalogue', 'canonical_digest:candidate', 'semantic_preparation', 'identity_application', 'curated_revisions', 'source_selection', 'source_graph', 'graph_validation', 'source_documents', 'normalization', 'input_selection', 'input_verification', 'input_preparation', 'prior_state', 'initial_warnings', 'entity_admissions', 'admission_selection', 'identity_associations', 'official_reduction', 'official_errata', 'official_assembly', 'disappearance_warnings', 'withdrawal_diagnostics', 'product_reduction:one-piece', 'product_reduction:digimon', 'product_reduction:fusion-world', 'product_reduction:gundam', 'product_reduction:riftbound') OR substr(phase, 1, 15) = 'record_sorting:' OR substr(phase, 1, 18) = 'workflow_dispatch:'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL CHECK (json_valid(content) AND length(CAST(content AS BLOB)) <= 65536),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (preparation_id, phase, ordinal)
);
INSERT INTO reconciliation_checkpoints("preparation_id","phase","ordinal","content","sha256") SELECT "preparation_id","phase","ordinal","content","sha256" FROM reconciliation_checkpoints_riftbound;
DROP TABLE reconciliation_checkpoints_riftbound;

CREATE INDEX reconciliation_checkpoints_recent ON reconciliation_checkpoints(preparation_id);

CREATE TRIGGER reconciliation_checkpoints_no_update BEFORE UPDATE ON reconciliation_checkpoints
BEGIN SELECT RAISE(ABORT, 'reconciliation_checkpoint_immutable'); END;

CREATE TRIGGER reconciliation_checkpoints_no_delete BEFORE DELETE ON reconciliation_checkpoints
BEGIN SELECT RAISE(ABORT, 'reconciliation_checkpoint_audit_retained'); END;

CREATE TRIGGER recovery_fence_reconciliation_checkpoints_insert BEFORE INSERT ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_reconciliation_checkpoints_update BEFORE UPDATE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TRIGGER recovery_fence_reconciliation_checkpoints_delete BEFORE DELETE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

INSERT INTO source_adapter_versions(adapter_version,source_lineage,supported_game,game_profile_version,parser_contract,adapter_origin,request_capacity) VALUES ('riftbound-en@1','riftbound-en','riftbound','riftbound@1','riot-riftbound-gallery@1','production',5000);

-- Preserve both the legacy query projection and its ON DELETE CASCADE child.
CREATE TABLE revision_printing_query_riftbound AS SELECT "catalogue_revision_id","printing_id","card_id","supported_game","normalized_rarity" FROM revision_printing_query;
CREATE TABLE revision_printing_product_query_riftbound AS SELECT "catalogue_revision_id","printing_id","card_id","product_id","release_region" FROM revision_printing_product_query;
DROP TABLE revision_printing_query;
CREATE TABLE revision_printing_query (
  catalogue_revision_id TEXT NOT NULL,
  printing_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  supported_game TEXT NOT NULL CHECK (supported_game IN ('one-piece', 'fusion-world', 'digimon', 'gundam', 'riftbound')),
  normalized_rarity TEXT,
  PRIMARY KEY (catalogue_revision_id, printing_id),
  FOREIGN KEY (catalogue_revision_id, printing_id)
    REFERENCES revision_printings(catalogue_revision_id, printing_id) ON DELETE CASCADE
);
INSERT INTO revision_printing_query("catalogue_revision_id","printing_id","card_id","supported_game","normalized_rarity") SELECT "catalogue_revision_id","printing_id","card_id","supported_game","normalized_rarity" FROM revision_printing_query_riftbound;
INSERT INTO revision_printing_product_query("catalogue_revision_id","printing_id","card_id","product_id","release_region") SELECT "catalogue_revision_id","printing_id","card_id","product_id","release_region" FROM revision_printing_product_query_riftbound;
DROP TABLE revision_printing_query_riftbound;
DROP TABLE revision_printing_product_query_riftbound;
CREATE INDEX revision_printing_query_by_card
  ON revision_printing_query(catalogue_revision_id, card_id, printing_id);
CREATE INDEX revision_printing_query_by_game
  ON revision_printing_query(catalogue_revision_id, supported_game, card_id, printing_id);
CREATE INDEX revision_printing_query_by_game_rarity
  ON revision_printing_query(catalogue_revision_id, supported_game, normalized_rarity, card_id, printing_id);
CREATE INDEX revision_printing_query_by_rarity
  ON revision_printing_query(catalogue_revision_id, normalized_rarity, card_id, printing_id);
CREATE TRIGGER recovery_fence_revision_printing_query_delete BEFORE DELETE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_query_insert BEFORE INSERT ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_revision_printing_query_update BEFORE UPDATE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;

CREATE TABLE ingestion_run_selected_games_riftbound AS SELECT "ingestion_run_id","ordinal","game" FROM ingestion_run_selected_games;
DROP TABLE ingestion_run_selected_games;
CREATE TABLE ingestion_run_selected_games (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  game TEXT NOT NULL CHECK (game IN ('one-piece', 'fusion-world', 'digimon', 'gundam', 'riftbound')),
  PRIMARY KEY (ingestion_run_id, ordinal),
  UNIQUE (ingestion_run_id, game)
);
INSERT INTO ingestion_run_selected_games("ingestion_run_id","ordinal","game") SELECT "ingestion_run_id","ordinal","game" FROM ingestion_run_selected_games_riftbound;
DROP TABLE ingestion_run_selected_games_riftbound;
CREATE TRIGGER recovery_fence_ingestion_run_selected_games_insert BEFORE INSERT ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_selected_games_update BEFORE UPDATE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
CREATE TRIGGER recovery_fence_ingestion_run_selected_games_delete BEFORE DELETE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_restore_guard='blocked')
BEGIN SELECT RAISE(ABORT,'catalogue_recovery_writer_fenced'); END;
INSERT INTO game_catalogue_heads(supported_game,revision_id) VALUES ('riftbound','catrev_spine_000');

-- Rebuilding these tables must retain the accepted handoff mutation fences.
CREATE TRIGGER handoff_fence_reconciled_errata_insert BEFORE INSERT ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_errata_update BEFORE UPDATE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciled_errata_delete BEFORE DELETE ON reconciled_errata
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_freshness_insert BEFORE INSERT ON source_freshness
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_freshness_update BEFORE UPDATE ON source_freshness
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_source_freshness_delete BEFORE DELETE ON source_freshness
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revisions_insert BEFORE INSERT ON curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revisions_update BEFORE UPDATE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_curated_revisions_delete BEFORE DELETE ON curated_revisions
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_checkpoints_insert BEFORE INSERT ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_checkpoints_update BEFORE UPDATE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_reconciliation_checkpoints_delete BEFORE DELETE ON reconciliation_checkpoints
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_query_insert BEFORE INSERT ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_query_update BEFORE UPDATE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_revision_printing_query_delete BEFORE DELETE ON revision_printing_query
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_selected_games_insert BEFORE INSERT ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_selected_games_update BEFORE UPDATE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;
CREATE TRIGGER handoff_fence_ingestion_run_selected_games_delete BEFORE DELETE ON ingestion_run_selected_games
WHEN EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
BEGIN SELECT RAISE(ABORT,'fresh_baseline_mutation_fenced'); END;

UPDATE catalogue_schema_state SET migration_level=28 WHERE singleton=1;

CREATE VIEW visible_prepared_curated_conflicts AS
SELECT conflict.revision_id, conflict.content,
  json_extract(conflict.content, '$.eventVersion') AS event_version
FROM reconciliation_curated_conflicts AS conflict
JOIN reconciliation_operations AS preparation ON preparation.id = conflict.preparation_id
JOIN ingestion_run_current AS run ON run.ingestion_run_id = preparation.ingestion_run_id
JOIN curated_revisions AS revision ON revision.id = conflict.revision_id
WHERE ((preparation.supported_game IS NULL AND run.state = 'failed' AND run.failure_code = 'curated_revision_reconfirmation_required')
    OR (preparation.supported_game IS NOT NULL AND preparation.state = 'failed' AND preparation.failure_code = 'curated_revision_reconfirmation_required'))
  AND revision.status = 'active'
  AND json_extract(conflict.content, '$.eventVersion') = revision.event_version + 1;
CREATE VIEW curated_revision_read AS
SELECT revision.id, revision.game, revision.target_key, revision.target_kind,
  revision.effective_from, revision.effective_to, revision.proposal_json, revision.content_digest,
  revision.reviewed_source_digest, revision.schema_binding_json, revision.author, revision.created_at,
  CASE WHEN conflict.revision_id IS NULL THEN revision.status ELSE 'reconfirmation_required' END AS status,
  COALESCE(conflict.event_version, revision.event_version) AS event_version
FROM curated_revisions AS revision LEFT JOIN visible_prepared_curated_conflicts AS conflict ON conflict.revision_id = revision.id;
CREATE VIEW curated_revision_event_read AS
SELECT revision_id, event_version, kind, event_json, created_at, author FROM curated_revision_events
UNION ALL
SELECT conflict.revision_id, conflict.event_version, 'source_change_detected',
  json_extract(conflict.content, '$.details'), json_extract(conflict.content, '$.createdAt'), 'system'
FROM visible_prepared_curated_conflicts AS conflict
WHERE NOT EXISTS (SELECT 1 FROM curated_revision_events AS event
  WHERE event.revision_id = conflict.revision_id AND event.event_version = conflict.event_version);
