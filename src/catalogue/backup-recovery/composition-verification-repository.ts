import { type CatalogueStore, repositoryStatements, registeredSupportedGames } from "../shared";
import { proposalArtifactsQuery } from "./composition-proposal-artifacts-repository";

// Pages bound database snapshot metadata independently of consumer export envelopes.
export const maximumSnapshotPageRows = 128;
export const maximumSnapshotPageBytes = 1_048_576;
export const maximumSchemaSnapshotPageRows = 32;
export const maximumSchemaSnapshotPageBytes = 1_048_576;
export const compositionSourceSnapshotTables = [
  "source_capture_operations",
  "source_parse_operations",
  "source_record_pages",
  "source_record_progress",
  "source_record_auxiliary",
  "source_archive_decodes",
  "source_archive_blocks",
  "source_archive_parse_progress",
  "source_archive_record_receipts",
] as const;
export const compositionParentContextTables = ["source_parse_contexts", "source_parse_dependencies"] as const;
export const compositionSnapshotTables = [
  ...compositionSourceSnapshotTables,
  ...compositionParentContextTables,
  "catalogue_revisions",
  "catalogue_exports",
  "catalogue_export_deletion_plans",
  "catalogue_export_deletions",
  "catalogue_export_deletion_tombstones",
  "catalogue_export_deletion_retries",
  "catalogue_composition_games",
  "catalogue_candidate_publications",
  "game_candidate_semantic_receipts",
  "game_candidate_predecessors",
  "game_accepted_candidates",
  "catalogue_acceptance_head",
  "game_catalogue_heads",
  "catalogue_query_revisions",
  "game_candidates",
  "game_candidate_partitions",
  "game_publication_operations",
  "game_publication_actions",
  "publication_preparations",
  "publication_export_preparations",
  "publication_export_components",
  "publication_export_nodes",
  "publication_query_documents",
  "publication_projection_batches",
  "publication_search_chunks",
  "publication_read_entities",
  "publication_read_lifecycles",
  "publication_read_attributes",
  "publication_read_release_regions",
  "publication_read_text_chunks",
  "publication_preparation_artifacts",
  "publication_composition_nodes",
  "verified_publication_compositions",
  "canonical_identity_allocations",
  "canonical_source_mappings",
  "canonical_identity_reviews",
  "canonical_identity_decisions",
  "entity_proposals",
  "entity_admission_decisions",
  "entity_admission_events",
  "entity_proposal_source_evidence",
  "identity_correction_decisions",
  "curated_revisions",
  "curated_revision_events",
  "reconciliation_source_mappings",
  "reconciliation_identity_reviews",
  "reconciliation_curated_pins",
  "reconciliation_automatic_admissions",
  "reconciliation_admission_decisions",
  "reconciliation_correction_pins",
  "reconciliation_evidence_selection",
  "staging_objects",
  "staging_object_writes",
  "staging_object_deletes",
  "evidence_cleanup_operations",
  "evidence_cleanup_objects",
  "evidence_cleanup_results",
  "evidence_object_writers",
  "evidence_object_references",
  "source_snapshots",
  "source_observation_sets",
  "retained_source_observation_evidence",
  "source_requests",
  "source_fetch_attempts",
  "source_authority_decisions",
  "source_lifecycle_decisions",
  "ingestion_runs",
  "ingestion_run_current",
  "ingestion_run_events",
  "ingestion_run_event_payload_chunks",
  "reconciliation_operations",
  "reconciliation_contexts",
  "reconciliation_checkpoints",
  "reconciliation_reducer_state",
  "reconciliation_text_chunks",
  "reconciliation_source_observations",
  "reconciliation_observation_origins",
] as const;
export type CompositionSnapshotTable = (typeof compositionSnapshotTables)[number];
export type CompositionVerificationQuery =
  | { kind: "composition-state"; revisionId: string }
  | { kind: "composition-columns"; table: CompositionSnapshotTable }
  | { kind: "composition-page"; table: CompositionSnapshotTable; after: number; columns: readonly string[] }
  | { kind: "composition-schema"; after: string }
  | { kind: "composition-accepted-roots" }
  | { kind: "composition-source-artifacts"; after: string }
  | { kind: "composition-parent-context-artifacts"; after: string }
  | { kind: "composition-proposal-artifacts"; after: string }
  | { kind: "foreign-keys" };
export type CompositionQuery = (query: CompositionVerificationQuery) => Promise<Record<string, unknown>[]>;
export function compositionVerificationQuery(input: CompositionVerificationQuery) {
  if (input.kind === "composition-proposal-artifacts") return proposalArtifactsQuery(input.after);
  if (input.kind === "composition-source-artifacts")
    return {
      sql: `WITH retained_snapshots AS (
      SELECT snapshot_id FROM evidence_cleanup_retained_snapshots
      -- Reverse ownership comes from literal stored keys, never an inherited
      -- cleanup closure that could map an ancestor key onto its descendants.
      UNION SELECT snapshot.id FROM evidence_object_references pin
        JOIN source_snapshots snapshot ON snapshot.content_object_key=pin.object_key
      UNION SELECT parse.source_snapshot_id FROM evidence_object_references pin
        JOIN source_parse_operations parse ON parse.content_object_key=pin.object_key
      UNION SELECT block.source_snapshot_id FROM evidence_object_references pin
        JOIN source_archive_blocks block ON block.object_key=pin.object_key
    ), archive_roots AS (
      SELECT archive.source_snapshot_id AS snapshot_id FROM source_archive_decodes archive
        JOIN retained_snapshots retained ON retained.snapshot_id=archive.source_snapshot_id
    ), required_snapshots AS (
      SELECT snapshot_id FROM archive_roots
      UNION SELECT image.id FROM archive_roots root
        JOIN source_snapshots archive ON archive.id=root.snapshot_id
        JOIN source_requests parent ON parent.ingestion_run_id=archive.ingestion_run_id
          AND parent.request_id=archive.request_id
        JOIN source_requests child ON child.ingestion_run_id=parent.ingestion_run_id
          AND child.discovered_from_request_id=parent.request_id AND child.request_role='image'
        -- Retained snapshots outlive each request's mutable current pointer.
        JOIN source_snapshots image ON image.ingestion_run_id=child.ingestion_run_id
          AND image.request_id=child.request_id
        JOIN retained_snapshots retained ON retained.snapshot_id=image.id
    ), artifacts AS (
      SELECT s.content_object_key AS object_key,s.content_digest AS sha256,s.content_byte_length AS byte_length,'raw' AS kind
        FROM source_snapshots s JOIN required_snapshots r ON r.snapshot_id=s.id
      UNION SELECT s.content_object_key,s.content_digest,s.content_byte_length,'observations'
        FROM source_observation_sets s JOIN required_snapshots r ON r.snapshot_id=s.source_snapshot_id
      UNION SELECT b.object_key,b.sha256,b.byte_length,'derived'
        FROM source_archive_blocks b JOIN required_snapshots r ON r.snapshot_id=b.source_snapshot_id
        JOIN source_archive_decodes d ON d.source_snapshot_id=b.source_snapshot_id AND d.state='decoded'
        WHERE b.state='retained' AND EXISTS(SELECT 1 FROM source_observation_sets s WHERE s.source_snapshot_id=b.source_snapshot_id)
    ) SELECT object_key,
      CASE WHEN MIN(sha256)=MAX(sha256) AND MIN(byte_length)=MAX(byte_length) AND MIN(kind)=MAX(kind)
        THEN MIN(sha256) ELSE NULL END AS sha256,
      MIN(byte_length) AS byte_length,MIN(kind) AS kind
      FROM artifacts WHERE object_key>?
      -- Validate every receipt for the physical key before the page boundary:
      -- otherwise a contradictory 65th row could disappear behind the cursor.
      GROUP BY object_key ORDER BY object_key LIMIT 64`,
      params: [input.after],
    };
  if (input.kind === "composition-parent-context-artifacts") {
    const retainedParent = (snapshot: string) => `EXISTS (
      SELECT 1 FROM source_parse_dependencies dependency
      JOIN source_parse_contexts context ON context.parse_operation_id=dependency.parse_operation_id
      JOIN source_parse_operations child ON child.id=dependency.parse_operation_id
      WHERE dependency.parent_source_snapshot_id=${snapshot} AND (
        EXISTS(SELECT 1 FROM evidence_cleanup_retained_snapshots retained WHERE retained.snapshot_id=child.source_snapshot_id)
        OR EXISTS(SELECT 1 FROM source_snapshots owned
          JOIN evidence_object_references reference ON reference.object_key=owned.content_object_key
          WHERE owned.id=child.source_snapshot_id)
        OR EXISTS(SELECT 1 FROM source_parse_operations owned
          JOIN evidence_object_references reference ON reference.object_key=owned.content_object_key
          WHERE owned.source_snapshot_id=child.source_snapshot_id)
        OR EXISTS(SELECT 1 FROM source_archive_blocks owned
          JOIN evidence_object_references reference ON reference.object_key=owned.object_key
          WHERE owned.source_snapshot_id=child.source_snapshot_id)))`;
    return {
      sql: `WITH receipts AS (
        SELECT s.content_object_key AS object_key,s.content_digest AS sha256,s.content_byte_length AS byte_length
        FROM source_snapshots s WHERE s.content_object_key>?1 AND ${retainedParent("s.id")}
        UNION ALL SELECT observation.content_object_key,observation.content_digest,observation.content_byte_length
        FROM source_observation_sets observation WHERE observation.content_object_key>?1
          AND ${retainedParent("observation.source_snapshot_id")}
        UNION ALL SELECT block.object_key,block.sha256,block.byte_length
        FROM source_archive_blocks block
        JOIN source_archive_decodes archive ON archive.source_snapshot_id=block.source_snapshot_id
          AND archive.state='decoded'
        WHERE block.object_key>?1 AND block.state='retained'
          AND EXISTS(SELECT 1 FROM source_observation_sets s WHERE s.source_snapshot_id=block.source_snapshot_id)
          AND ${retainedParent("block.source_snapshot_id")}
        ) SELECT object_key,min(sha256) AS sha256,min(byte_length) AS byte_length,
          min(sha256)=max(sha256) AND min(byte_length)=max(byte_length) AS consistent
        FROM receipts GROUP BY object_key
        ORDER BY object_key LIMIT 64`,
      params: [input.after],
    };
  }
  if (input.kind === "composition-accepted-roots") return acceptedEvidenceArtifactRootsQuery();
  if (input.kind === "composition-schema")
    return {
      sql: `WITH page AS (
        SELECT name,type,sql FROM sqlite_schema WHERE name>? AND sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%'
        AND name<>'d1_migrations' ORDER BY name LIMIT ${maximumSchemaSnapshotPageRows}
      ), sizes AS (
        SELECT name,sum(length(CAST(json_object('name',name,'type',type,'sql',sql) AS BLOB)))
          OVER (ORDER BY name) AS page_bytes FROM page
      ) SELECT page.name,page.type,page.sql FROM page JOIN sizes USING(name)
        WHERE sizes.page_bytes<=${maximumSchemaSnapshotPageBytes} OR page.name=(SELECT min(name) FROM page)
        ORDER BY page.name`,
      params: [input.after],
    };
  if (input.kind === "foreign-keys") return { sql: "PRAGMA foreign_key_check", params: [] };
  if (input.kind === "composition-columns" || input.kind === "composition-page") {
    if (!compositionSnapshotTables.includes(input.table)) throw new Error("Unknown composition snapshot table.");
    if (input.kind === "composition-columns")
      return { sql: "SELECT name FROM pragma_table_info(?) ORDER BY cid", params: [input.table] };
    if (
      !input.columns.length ||
      input.columns.length > 128 ||
      new Set(input.columns).size !== input.columns.length ||
      input.columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column) || column === "snapshot_rowid")
    )
      throw new Error("Invalid composition snapshot columns.");
    const fields = ["snapshot_rowid", ...input.columns].map((column) => `'${column}',"${column}"`).join(",");
    return {
      sql: `WITH page AS (SELECT rowid AS snapshot_rowid,* FROM ${input.table} WHERE rowid>? ORDER BY rowid LIMIT ${maximumSnapshotPageRows}),
        sizes AS (SELECT snapshot_rowid,sum(length(CAST(json_object(${fields}) AS BLOB))) OVER (ORDER BY snapshot_rowid) AS page_bytes FROM page)
        SELECT page.* FROM page JOIN sizes USING(snapshot_rowid)
        WHERE sizes.page_bytes<=${maximumSnapshotPageBytes} OR page.snapshot_rowid=(SELECT min(snapshot_rowid) FROM page)
        ORDER BY page.snapshot_rowid`,
      params: [input.after],
    };
  }
  return {
    sql: `SELECT r.id, r.content_digest, r.publication_operation_id, r.ingestion_run_id,
    s.migration_level, o.recovery_restore_guard,
    (SELECT state FROM card_search_fts_state WHERE singleton=1) AS search_state,
    (SELECT count(*) FROM catalogue_composition_games WHERE catalogue_revision_id=r.id) AS members,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
      WHERE m.catalogue_revision_id=r.id AND d.kind='cards') AS cards,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
      WHERE m.catalogue_revision_id=r.id AND d.kind='printings') AS printings,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
      WHERE m.catalogue_revision_id=r.id AND d.kind='products') AS products,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_read_entities e ON e.candidate_id=m.candidate_id
      LEFT JOIN publication_read_lifecycles l ON l.candidate_id=e.candidate_id AND l.kind=e.kind AND l.entity_id=e.entity_id
      LEFT JOIN catalogue_candidate_publications first ON first.candidate_id=l.first_candidate_id
      LEFT JOIN catalogue_candidate_publications last ON last.candidate_id=l.last_observed_candidate_id
      LEFT JOIN catalogue_candidate_publications withdrawn ON withdrawn.candidate_id=l.withdrawal_candidate_id
      WHERE m.catalogue_revision_id=r.id AND e.kind IN ('cards','printings','products','relationships','product_relationships')
      AND (l.entity_id IS NULL OR first.candidate_id IS NULL OR last.candidate_id IS NULL
        OR (l.withdrawal_candidate_id IS NOT NULL AND withdrawn.candidate_id IS NULL))) AS missing_lifecycle,
    (SELECT count(*) FROM publication_search_chunks c WHERE NOT EXISTS (
      SELECT 1 FROM publication_search_fts f WHERE f.candidate_id=c.candidate_id AND f.card_id=c.card_id
      AND f.search_text=c.search_text)) AS missing_search
    FROM catalogue_revisions r JOIN catalogue_state h ON h.current_revision_id=r.id
    JOIN catalogue_schema_state s ON s.singleton=1 JOIN operation_state o ON o.singleton=1
    WHERE r.id=?`,
    params: [input.revisionId],
  };
}
export function compositionVerificationStatement(db: CatalogueStore, input: CompositionVerificationQuery) {
  const query = compositionVerificationQuery(input);
  return repositoryStatements(db)
    .prepare(query.sql)
    .bind(...query.params);
}

export function compositionArtifactRootsStatement(db: CatalogueStore, revisionId: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT m.supported_game,m.game_revision_id,m.candidate_id,m.root_digest,
 c.preparation_id,c.manifest_digest,p.publication_operation_id,p.revision_id,p.state AS public_state,
 p.root_digest AS public_root_digest,p.root_object_key,p.root_bytes,p.component_count,o.deadline,
 r.content_digest AS composition_digest,v.content AS composition_json
 FROM catalogue_composition_games m JOIN game_candidates c ON c.id=m.candidate_id
 JOIN catalogue_revisions r ON r.id=m.catalogue_revision_id
 LEFT JOIN verified_publication_compositions v ON v.sha256=r.content_digest
 LEFT JOIN publication_export_preparations p ON p.candidate_id=m.candidate_id
 LEFT JOIN game_publication_operations o ON o.id=p.publication_operation_id
 WHERE m.catalogue_revision_id=? ORDER BY m.supported_game LIMIT ?`,
    )
    .bind(revisionId, registeredSupportedGames().length);
}

export type AcceptedEvidenceArtifactRoot = {
  supported_game: string;
  candidate_id: string;
  preparation_id: string;
  manifest_digest: string;
  root_digest: string;
};

function acceptedEvidenceArtifactRootsQuery() {
  return {
    sql: `SELECT head.supported_game,candidate.id AS candidate_id,
    candidate.preparation_id,candidate.manifest_digest,prepared.root_digest
    FROM game_accepted_candidates head JOIN game_candidates candidate ON candidate.id=head.candidate_id
    LEFT JOIN publication_preparations prepared ON prepared.candidate_id=candidate.id
      AND prepared.state='verified' AND prepared.manifest_digest=candidate.manifest_digest
      AND prepared.generation=candidate.generation
    WHERE candidate.state='published' ORDER BY head.supported_game LIMIT ?`,
    params: [registeredSupportedGames().length],
  };
}

/** At most one current accepted private root per supported game, including same-revision evidence. */
export function acceptedEvidenceArtifactRootsStatement(db: CatalogueStore) {
  const query = acceptedEvidenceArtifactRootsQuery();
  return repositoryStatements(db)
    .prepare(query.sql)
    .bind(...query.params);
}
